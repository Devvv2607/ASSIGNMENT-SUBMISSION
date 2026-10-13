import { ApifyClient } from "apify-client";
import { db, must, logEvent, type EvidenceRow } from "./db";
import { retry } from "./util";

export const ACTORS = {
  linkedin: "harvestapi/linkedin-profile-scraper",
  instagram: "apify/instagram-profile-scraper",
};

const CACHE_MS = 7 * 24 * 3600 * 1000;
export const MAX_IMAGES = 6;

// ---------- URL validation ----------

export function parseLinkedIn(raw: string): string | null {
  const m = raw.trim().match(/^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([A-Za-z0-9\-_%.]+)\/?(?:[?#].*)?$/i);
  return m ? `https://www.linkedin.com/in/${decodeURIComponent(m[1]).toLowerCase()}` : null;
}

export function parseInstagram(raw: string): { url: string; handle: string } | null {
  const s = raw.trim();
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/i);
  if (!m) return null;
  const handle = m[1].toLowerCase();
  if (["p", "reel", "reels", "stories", "explore", "accounts"].includes(handle)) return null;
  return { url: `https://www.instagram.com/${handle}/`, handle };
}

// ---------- Apify ----------

export class PrivateInstagramError extends Error {}

function apify() {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("Missing APIFY_TOKEN");
  return new ApifyClient({ token });
}

async function runActor(actorId: string, input: Record<string, unknown>) {
  const run = await apify().actor(actorId).call(input, { waitSecs: 240 });
  if (!run || run.status !== "SUCCEEDED") throw new Error(`${actorId} run ${run?.status ?? "failed"}`);
  const { items } = await apify().dataset(run.defaultDatasetId).listItems();
  return { runId: run.id, items: items as Record<string, unknown>[] };
}

async function cachedSource(personId: string, source: "linkedin" | "instagram") {
  const { data } = await db().from("raw_sources").select("payload, fetched_at").eq("person_id", personId).eq("source", source).maybeSingle();
  if (data && Date.now() - new Date(data.fetched_at).getTime() < CACHE_MS) return data.payload as Record<string, unknown>;
  return null;
}

async function fetchSource(personId: string, source: "linkedin" | "instagram", url: string, handle?: string) {
  const cached = await cachedSource(personId, source);
  if (cached) {
    await logEvent(personId, "apify", `Using cached ${source} data (< 7 days old)`);
    return cached;
  }
  await logEvent(personId, "apify", `Running Apify ${ACTORS[source]}…`);
  // Profile scraper only. Email-search / contact modes are never enabled.
  const input = source === "linkedin" ? { urls: [url] } : { usernames: [handle] };
  const { runId, items } = await retry(() => runActor(ACTORS[source], input), 2, `apify ${source}`);
  const payload = items[0];
  if (!payload) throw new Error(`Apify returned no ${source} profile for ${url}. Is the link correct and public?`);
  if ("error" in payload && !("username" in payload) && !("firstName" in payload)) {
    throw new Error(`Apify could not read the ${source} profile: ${String(payload.error)}`);
  }
  must(
    await db().from("raw_sources").upsert({ person_id: personId, source, actor_id: ACTORS[source], run_id: runId, payload, fetched_at: new Date().toISOString() }),
    "save raw source",
  );
  return payload;
}

// ---------- Normalizers (defensive: actor output fields vary) ----------

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const str = (...vals: unknown[]) => vals.find((v) => typeof v === "string" && v.trim()) as string | undefined;
const arr = (v: unknown): Any[] => (Array.isArray(v) ? (v as Any[]) : []);
const clip = (s: string, n = 1200) => (s.length > n ? s.slice(0, n) + "…" : s);
const dateText = (d: unknown) => (typeof d === "string" ? d : d && typeof d === "object" ? str((d as Any).text, (d as Any).year?.toString()) : undefined);

export function normalizeLinkedIn(p: Any): Omit<EvidenceRow, "person_id">[] {
  const out: Omit<EvidenceRow, "person_id">[] = [];
  const add = (id: string, kind: string, text: string | undefined, meta: Any = {}) => {
    if (text && text.trim()) out.push({ id, source: "linkedin", kind, text: clip(text.trim()), image_url: null, meta });
  };
  add("li:headline", "headline", str(p.headline, p.occupation));
  add("li:about", "about", str(p.about, p.summary));
  add("li:location", "location", str(p.location?.linkedinText, p.location?.parsed?.text, p.location, p.addressWithCountry));
  arr(p.experience ?? p.positions ?? p.experiences).slice(0, 10).forEach((e, i) => {
    const title = str(e.position, e.title);
    const co = str(e.companyName, e.company?.name, e.company);
    const when = [dateText(e.startDate), dateText(e.endDate) ?? (e.endDate ? "" : "present")].filter(Boolean).join("–");
    const line = [title, co && `at ${co}`, when && `(${when})`, str(e.duration)].filter(Boolean).join(" ");
    add(`li:exp:${i}`, "experience", [line, str(e.description)].filter(Boolean).join(". "));
  });
  arr(p.education ?? p.educations).slice(0, 6).forEach((e, i) => {
    const line = [str(e.degree, e.degreeName), str(e.fieldOfStudy), str(e.schoolName, e.school?.name, e.title) && `at ${str(e.schoolName, e.school?.name, e.title)}`, str(e.period, dateText(e.startDate))]
      .filter(Boolean)
      .join(", ");
    add(`li:edu:${i}`, "education", line);
  });
  const skills = arr(p.skills).map((s) => str(s.name, s.title, typeof s === "string" ? s : undefined)).filter(Boolean);
  if (skills.length) add("li:skills", "skills", `Skills: ${skills.slice(0, 25).join(", ")}`);
  arr(p.certifications).slice(0, 5).forEach((c, i) => add(`li:cert:${i}`, "certification", [str(c.title, c.name), str(c.issuedBy, c.authority)].filter(Boolean).join(" — ")));
  arr(p.projects).slice(0, 5).forEach((c, i) => add(`li:proj:${i}`, "project", [str(c.title, c.name), str(c.description)].filter(Boolean).join(": ")));
  arr(p.volunteering ?? p.volunteerExperience).slice(0, 4).forEach((c, i) => add(`li:vol:${i}`, "volunteering", [str(c.role, c.title), str(c.organizationName, c.companyName), str(c.cause)].filter(Boolean).join(" · ")));
  arr(p.honorsAndAwards ?? p.honors).slice(0, 4).forEach((c, i) => add(`li:award:${i}`, "award", [str(c.title), str(c.issuedBy), str(c.description)].filter(Boolean).join(" — ")));
  const langs = arr(p.languages).map((l) => str(l.name, l.language, typeof l === "string" ? l : undefined)).filter(Boolean);
  if (langs.length) add("li:languages", "languages", `Languages: ${langs.join(", ")}`);
  return out;
}

export function normalizeInstagram(p: Any): Omit<EvidenceRow, "person_id">[] {
  const out: Omit<EvidenceRow, "person_id">[] = [];
  // externalUrl is deliberately ignored: it would point at a third source.
  const bio = str(p.biography);
  if (bio) out.push({ id: "ig:bio", source: "instagram", kind: "bio", text: clip(bio), image_url: null, meta: {} });
  const counts = [p.postsCount != null && `${p.postsCount} posts`, p.followersCount != null && `${p.followersCount} followers`, p.followsCount != null && `following ${p.followsCount}`].filter(Boolean);
  if (counts.length) out.push({ id: "ig:stats", source: "instagram", kind: "stats", text: `Instagram: ${counts.join(", ")}`, image_url: null, meta: {} });
  arr(p.latestPosts).slice(0, 12).forEach((post, i) => {
    const caption = str(post.caption) ?? "";
    const tags = arr(post.hashtags).length ? ` #${(post.hashtags as string[]).join(" #")}` : "";
    const where = str(post.locationName) ? ` 📍${post.locationName}` : "";
    const when = str(post.timestamp)?.slice(0, 10);
    const text = (caption || "(no caption)") + tags + where + (when ? ` [${when}]` : "");
    out.push({
      id: `ig:post:${i}`,
      source: "instagram",
      kind: "post",
      text: clip(text, 800),
      image_url: str(post.displayUrl, arr(post.images)[0] as unknown as string) ?? null,
      meta: { url: post.url ?? null, timestamp: post.timestamp ?? null, type: post.type ?? null, likes: post.likesCount ?? null, location: post.locationName ?? null },
    });
  });
  return out;
}

// ---------- Image caching (IG CDN URLs expire) ----------

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

// ---------- Orchestration ----------

export async function ingestPerson(personId: string) {
  const person = must(await db().from("people").select("*").eq("id", personId).single(), "load person");
  const ig = parseInstagram(person.instagram_url);
  if (!ig) throw new Error("Invalid Instagram URL");

  await logEvent(personId, "apify", "Starting LinkedIn + Instagram scrapes in parallel");
  const [li, insta] = await Promise.all([
    fetchSource(personId, "linkedin", person.linkedin_url),
    fetchSource(personId, "instagram", ig.url, ig.handle),
  ]);

  if ((insta as Any).private === true) {
    throw new PrivateInstagramError(`@${ig.handle} is a private Instagram account. Proxy only reads public profiles, so this person can't be added.`);
  }

  const liEv = normalizeLinkedIn(li as Any);
  const igEv = normalizeInstagram(insta as Any);
  const roles = liEv.filter((e) => e.kind === "experience").length;
  const edu = liEv.filter((e) => e.kind === "education").length;
  const posts = igEv.filter((e) => e.kind === "post").length;
  await logEvent(personId, "evidence", `Reading LinkedIn: ${roles} role${roles === 1 ? "" : "s"}, ${edu} degree${edu === 1 ? "" : "s"}${liEv.some((e) => e.kind === "skills") ? ", skills" : ""}`);
  await logEvent(personId, "evidence", `Reading Instagram: bio${posts ? ` + ${posts} posts` : ", no public posts"}`);
  if (liEv.length + igEv.length < 2) throw new Error("Both profiles are nearly empty, so there's nothing honest to analyze.");

  // Cache avatar + the first MAX_IMAGES post images to Storage, in parallel.
  const avatarSrc = str((insta as Any).profilePicUrlHD, (insta as Any).profilePicUrl);
  const withImages = igEv.filter((e) => e.image_url).slice(0, MAX_IMAGES);
  const [avatar, ...cached] = await Promise.all([
    avatarSrc ? cacheImage(personId, "avatar", avatarSrc) : Promise.resolve(null),
    ...withImages.map((e) => cacheImage(personId, e.id.replace(/:/g, "_"), e.image_url!)),
  ]);
  withImages.forEach((e, i) => {
    if (cached[i]) e.image_url = cached[i];
  });
  await logEvent(personId, "evidence", `Cached ${cached.filter(Boolean).length} post images`);

  const rows = [...liEv, ...igEv].map((e) => ({ ...e, person_id: personId }));
  must(await db().from("evidence").delete().eq("person_id", personId), "clear evidence");
  must(await db().from("evidence").insert(rows), "save evidence");
  if (avatar || avatarSrc) must(await db().from("people").update({ avatar_url: avatar ?? avatarSrc }).eq("id", personId), "save avatar");
  await logEvent(personId, "evidence", `Evidence store: ${rows.length} cited facts`);
  return rows;
}
