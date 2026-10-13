import { ApifyClient } from "apify-client";
import { db, must, logEvent, type EvidenceRow } from "./db";
import { retry } from "./util";

export const ACTORS = {
  linkedin: "harvestapi/linkedin-profile-scraper",
  instagram: "apify/instagram-profile-scraper",
};
// Exact enum value of the actor's mode input. Never the email-finding mode.
export const LINKEDIN_MODE = "Profile details no email ($4 per 1k)";

const CACHE_MS = 7 * 24 * 3600 * 1000;
export const MAX_IMAGES = 6;

// ---------- URL validation ----------

export function parseLinkedIn(raw: string): string | null {
  const m = raw.trim().match(/^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([A-Za-z0-9\-_%.]+)\/?(?:[?#].*)?$/i);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return null;
  }
  return `https://www.linkedin.com/in/${slug}`;
}

export function parseInstagram(raw: string): { url: string; handle: string } | null {
  const s = raw.trim().replace(/^@/, "");
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/i) ?? s.match(/^([A-Za-z0-9._]{1,30})$/);
  if (!m) return null;
  const handle = m[1].toLowerCase();
  if (["p", "reel", "reels", "stories", "explore", "accounts"].includes(handle)) return null;
  return { url: `https://www.instagram.com/${handle}/`, handle };
}

// ---------- Apify ----------

export class PrivateInstagramError extends Error {}
export class NotFoundError extends Error {}

function apify() {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("Missing APIFY_TOKEN");
  return new ApifyClient({ token });
}

export async function runActor(actorId: string, input: Record<string, unknown>) {
  const client = apify();
  const run = await client.actor(actorId).call(input, { waitSecs: 240 });
  if (!run || run.status !== "SUCCEEDED") throw new Error(`${actorId} run ${run?.status ?? "failed"}`);
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return { runId: run.id, usd: run.usageTotalUsd ?? null, items: items as Any[] };
}

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Drop the huge, useless parts of the LinkedIn payload (nested company objects, emails, logos, covers). */
export function stripLinkedIn(p: Any): Any {
  const DROP = new Set(["company", "emails", "email", "moreProfiles", "logo", "logos", "backgroundCover", "backgroundCovers", "companyLogo", "schoolLogo", "logoUrl"]);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !DROP.has(k)).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(p) as Any;
}

async function cached(personId: string, source: "linkedin" | "instagram") {
  const { data } = await db().from("raw_sources").select("payload, fetched_at").eq("person_id", personId).eq("source", source).maybeSingle();
  if (data && Date.now() - new Date(data.fetched_at).getTime() < CACHE_MS) return data.payload as Any;
  return null;
}

async function saveRaw(personId: string, source: string, runId: string, usd: number | null, payload: Any) {
  must(
    await db().from("raw_sources").upsert({ person_id: personId, source, actor_id: ACTORS[source as "linkedin"], run_id: runId, usage_usd: usd, payload, fetched_at: new Date().toISOString() }),
    "save raw source",
  );
}

export async function scrapeLinkedIn(personId: string, url: string) {
  if (await cached(personId, "linkedin")) return logEvent(personId, "apify", "LinkedIn: using cached scrape (< 7 days old)");
  await logEvent(personId, "apify", "Running Apify harvestapi/linkedin-profile-scraper…");
  const { runId, usd, items } = await retry(() => runActor(ACTORS.linkedin, { profileScraperMode: LINKEDIN_MODE, urls: [url] }), 2, "LinkedIn scrape");
  const p = items[0];
  if (!p || (p.error && !p.firstName)) throw new NotFoundError("LinkedIn profile not found. Check that the link is correct and the profile is public.");
  await saveRaw(personId, "linkedin", runId, usd, stripLinkedIn(p));
  await logEvent(personId, "apify", `LinkedIn scraped: ${[p.firstName, p.lastName].filter(Boolean).join(" ")}, ${(p.experience ?? []).length} roles`);
}

export async function scrapeInstagram(personId: string, handle: string) {
  let p = await cached(personId, "instagram");
  if (p) await logEvent(personId, "apify", "Instagram: using cached scrape (< 7 days old)");
  else {
    await logEvent(personId, "apify", `Running Apify apify/instagram-profile-scraper for @${handle}…`);
    const res = await retry(() => runActor(ACTORS.instagram, { usernames: [handle], includeAboutSection: false }), 2, "Instagram scrape");
    p = res.items[0];
    if (!p || p.error) throw new NotFoundError(`Instagram profile @${handle} not found.`);
    if (p.private === true) throw new PrivateInstagramError(`@${handle} is a private Instagram account. Proxy only reads public profiles, so this person can't be added.`);
    await saveRaw(personId, "instagram", res.runId, res.usd, p);
  }
  if (p.private === true) throw new PrivateInstagramError(`@${handle} is a private Instagram account. Proxy only reads public profiles, so this person can't be added.`);
  await logEvent(personId, "apify", `Instagram scraped: ${p.postsCount ?? "?"} posts, ${(p.latestPosts ?? []).length} recent ones readable`);
}

// ---------- Normalizers (verified actor output shapes) ----------

const str = (...vals: unknown[]) => vals.find((v) => typeof v === "string" && v.trim()) as string | undefined;
const arr = (v: unknown): Any[] => (Array.isArray(v) ? (v as Any[]) : []);
const clip = (s: string, n = 1000) => (s.length > n ? s.slice(0, n) + "…" : s);
type Ev = Omit<EvidenceRow, "person_id">;

export function normalizeLinkedIn(p: Any): Ev[] {
  const out: Ev[] = [];
  const add = (id: string, kind: string, text: string | undefined, meta: Any = {}) => {
    if (text && text.trim()) out.push({ id, source: "linkedin", kind, text: clip(text.trim()), image_url: null, meta });
  };
  add("li:headline", "headline", str(p.headline));
  add("li:about", "about", str(p.about));
  add("li:location", "location", str(p.location?.linkedinText) && `Based in ${p.location.linkedinText}`);
  arr(p.experience).slice(0, 10).forEach((e, i) => {
    const when = [str(e.startDate?.text), str(e.endDate?.text)].filter(Boolean).join(" – ");
    const head = [str(e.position), str(e.companyName) && `at ${e.companyName}`, when && `(${when}${e.duration ? `, ${e.duration}` : ""})`, str(e.location) && `· ${e.location}`].filter(Boolean).join(" ");
    add(`li:exp:${i}`, "experience", [head, str(e.description)].filter(Boolean).join(". "));
  });
  arr(p.education).slice(0, 6).forEach((e, i) => add(`li:edu:${i}`, "education", [str(e.degree), str(e.fieldOfStudy), str(e.schoolName) && `at ${e.schoolName}`, str(e.period)].filter(Boolean).join(", ")));
  const skills = [...arr(p.topSkills).map((s) => (typeof s === "string" ? s : str(s?.name))), ...(typeof p.topSkills === "string" ? p.topSkills.split(/[•,]/) : []), ...arr(p.skills).map((s) => str(s?.name))]
    .map((s) => s?.trim())
    .filter((s, i, a): s is string => !!s && a.indexOf(s) === i);
  if (skills.length) add("li:skills", "skills", `Skills: ${skills.slice(0, 25).join(", ")}`);
  arr(p.certifications).slice(0, 5).forEach((c, i) => add(`li:cert:${i}`, "certification", [str(c.title), str(c.issuedBy)].filter(Boolean).join(" — ")));
  arr(p.projects).slice(0, 5).forEach((c, i) => add(`li:proj:${i}`, "project", [str(c.title), str(c.description)].filter(Boolean).join(": ")));
  arr(p.volunteering).slice(0, 4).forEach((c, i) => add(`li:vol:${i}`, "volunteering", [str(c.role), str(c.organizationName) && `at ${c.organizationName}`, str(c.cause) && `(cause: ${c.cause})`].filter(Boolean).join(" ")));
  const causes = arr(p.causes).map((c) => (typeof c === "string" ? c : str(c?.name))).filter(Boolean);
  if (causes.length) add("li:causes", "causes", `Causes they care about: ${causes.join(", ")}`);
  const langs = arr(p.languages).map((l) => str(l?.name)).filter(Boolean);
  if (langs.length) add("li:languages", "languages", `Languages: ${langs.join(", ")}`);
  arr(p.honorsAndAwards).slice(0, 4).forEach((c, i) => add(`li:award:${i}`, "award", [str(c.title), str(c.issuedBy) && `from ${c.issuedBy}`, str(c.description)].filter(Boolean).join(" — ")));
  arr(p.interests).slice(0, 6).forEach((g, i) => {
    const titles = arr(g.elements).map((e) => str(e?.title)).filter(Boolean).slice(0, 8);
    if (titles.length) add(`li:int:${i}`, "follows", `Follows on LinkedIn (${str(g.interestName) ?? "interests"}): ${titles.join(", ")}`);
  });
  arr(p.receivedRecommendations).slice(0, 3).forEach((r, i) => add(`li:rec:${i}`, "recommendation", str(r.description) && `Said about them by someone else (recommendation, lower weight): ${r.description}`, { weight: "low" }));
  return out;
}

export function normalizeInstagram(p: Any): Ev[] {
  const out: Ev[] = [];
  // externalUrl is deliberately ignored: it would point at a third source.
  const bio = str(p.biography);
  if (bio) out.push({ id: "ig:bio", source: "instagram", kind: "bio", text: clip(bio), image_url: null, meta: {} });
  const counts = [p.postsCount != null && `${p.postsCount} posts`, p.followersCount != null && `${p.followersCount} followers`].filter(Boolean);
  if (counts.length) out.push({ id: "ig:stats", source: "instagram", kind: "stats", text: `Instagram: ${counts.join(", ")}`, image_url: null, meta: {} });
  arr(p.latestPosts).slice(0, 12).forEach((post, i) => {
    const caption = str(post.caption) ?? "";
    const tags = arr(post.hashtags).length ? ` #${(post.hashtags as string[]).join(" #")}` : "";
    const where = str(post.locationName) ? ` 📍${post.locationName}` : "";
    const when = str(post.timestamp)?.slice(0, 10);
    const kind = post.type === "Sidecar" ? ` (carousel of ${arr(post.childPosts).length || "several"})` : post.type === "Video" ? " (video)" : "";
    out.push({
      id: `ig:post:${i}`,
      source: "instagram",
      kind: "post",
      text: clip((caption || "(no caption)") + tags + where + kind + (when ? ` [${when}]` : ""), 700),
      image_url: str(post.displayUrl, arr(post.images)[0] as unknown as string) ?? null, // carousels: first image
      meta: { url: str(post.url) ?? (post.shortCode ? `https://www.instagram.com/p/${post.shortCode}/` : null), timestamp: post.timestamp ?? null, type: post.type ?? null },
    });
  });
  return out;
}

// ---------- Image caching to Supabase Storage (IG CDN URLs expire) ----------

export async function fetchImage(url: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") ?? "image/jpeg";
    if (!type.startsWith("image/")) return null;
    return { bytes: new Uint8Array(await r.arrayBuffer()), type };
  } catch {
    return null;
  }
}

async function cacheImage(personId: string, name: string, url: string) {
  const img = await fetchImage(url);
  if (!img) return null;
  const path = `${personId}/${name}.jpg`;
  const { error } = await db().storage.from("media").upload(path, img.bytes, { contentType: img.type, upsert: true });
  if (error) return null;
  return db().storage.from("media").getPublicUrl(path).data.publicUrl;
}

/** Normalize both raw sources into the evidence store and cache avatar + up to 6 post images. */
export async function buildEvidence(personId: string) {
  const raws = must(await db().from("raw_sources").select("source, payload").eq("person_id", personId), "load raw") as { source: string; payload: Any }[];
  const li = raws.find((r) => r.source === "linkedin")?.payload;
  const ig = raws.find((r) => r.source === "instagram")?.payload;
  if (!li || !ig) throw new Error("Raw sources missing; scrape steps must run first");

  const liEv = normalizeLinkedIn(li);
  const igEv = normalizeInstagram(ig);
  const n = (k: string) => liEv.filter((e) => e.kind === k).length;
  await logEvent(personId, "evidence", `Reading LinkedIn: ${n("experience")} roles, ${n("education")} degrees${n("skills") ? ", skills" : ""}${n("follows") ? ", what they follow" : ""}`);
  await logEvent(personId, "evidence", `Reading Instagram: ${igEv.some((e) => e.id === "ig:bio") ? "bio + " : ""}${igEv.filter((e) => e.kind === "post").length} posts`);
  if (liEv.length + igEv.length < 2) throw new Error("Both profiles are nearly empty, so there's nothing honest to analyze.");

  const withImages = igEv.filter((e) => e.image_url).slice(0, MAX_IMAGES);
  const avatarSrc = str(ig.profilePicUrlHD, ig.profilePicUrl, li.photo);
  const [avatar, ...stored] = await Promise.all([
    avatarSrc ? cacheImage(personId, "avatar", avatarSrc) : Promise.resolve(null),
    ...withImages.map((e) => cacheImage(personId, e.id.replace(/:/g, "_"), e.image_url!)),
  ]);
  // Only Storage URLs are kept: uncached CDN links would break within days.
  const storedMap = new Map(withImages.map((e, i) => [e.id, stored[i]]));
  for (const e of igEv) if (e.image_url) e.image_url = storedMap.get(e.id) ?? null;
  await logEvent(personId, "evidence", `Cached ${stored.filter(Boolean).length} photos${avatar ? " + avatar" : ""} to storage`);

  const rows = [...liEv, ...igEv].map((e) => ({ ...e, person_id: personId }));
  must(await db().from("evidence").delete().eq("person_id", personId), "clear evidence");
  must(await db().from("evidence").insert(rows), "save evidence");
  must(await db().from("people").update({ avatar_url: avatar }).eq("id", personId), "save avatar");
  await logEvent(personId, "evidence", `Evidence store: ${rows.length} citable facts`);
  return rows;
}
