import { z } from "zod";
import { db, must, logEvent, type EvidenceRow } from "./db";
import { llmObject, MODELS, MAX_IMAGES_PER_VISION_CALL } from "./llm";

// ---------- Schemas ----------

const ev = z.array(z.string()).describe("evidence IDs from the list, e.g. ['ig:post:3','li:exp:0']");
const conf = z.number().min(0).max(1);

export const PersonProfileSchema = z.object({
  headline: z.string().describe("one specific human line"),
  vibe: z.string().describe("2-3 warm, specific sentences, no clichés"),
  hobbies: z.array(z.object({ name: z.string(), evidence: ev, confidence: conf })),
  interests: z.array(z.object({ name: z.string(), evidence: ev, confidence: conf })),
  values: z.array(z.object({ name: z.string(), why: z.string(), evidence: ev, confidence: conf })),
  lifestyle: z.object({ rhythm: z.string(), social_energy: z.string(), travel: z.string(), fitness: z.string(), evidence: ev }),
  career: z.object({ current: z.string(), trajectory: z.string(), ambition_level: z.string(), evidence: ev }),
  communication_style: z.object({ description: z.string(), evidence: ev }),
  needs: z.array(z.object({ need: z.string(), why: z.string().describe("reasoning; this is an inference"), evidence: ev, confidence: conf })),
  likely_dealbreakers: z.array(z.object({ item: z.string(), why: z.string().describe("reasoning; this is an inference"), evidence: ev, confidence: conf })),
  green_flags_for_them: z.array(z.string()),
  conversation_hooks: z.array(z.string()),
  unknowns: z.array(z.string()).describe("what the two sources could NOT tell us"),
  public_card: z.object({ headline: z.string(), top_interests: z.array(z.string()).describe("exactly 3"), one_liner: z.string() }),
});
export type PersonProfile = z.infer<typeof PersonProfileSchema>;

const VisionSchema = z.object({
  images: z.array(
    z.object({
      image_number: z.number().int(),
      activities: z.array(z.string()),
      setting: z.enum(["outdoors", "city", "home", "event", "travel", "work", "other"]),
      hobby_signals: z.array(z.string()).describe("objects/scenes that signal hobbies, e.g. 'film camera'"),
      social_context: z.enum(["solo", "pair", "group", "no people"]),
      caption: z.string().describe("short neutral description of the scene"),
    }),
  ),
});

// ---------- Safety: forbidden attributes ----------

export const FORBIDDEN = [
  /\b(gay|lesbian|bisexual|queer|heterosexual|homosexual|sexual orientation|orientation)\b/i,
  /\b(religio\w*|hindu|muslim|islam\w*|christian\w*|sikh|jain|buddhis\w*|jewish|church|temple|mosque|god-fearing|faith)\b/i,
  /\b(caste|brahmin|dalit|ethnic\w*|racial|skin colou?r)\b/i,
  /\b(health condition|illness|disease|disorder|disabilit\w*|diagnos\w*|mental health|depress\w*|anxiety|pregnan\w*)\b/i,
  /\b(politic\w*|left-wing|right-wing|bjp|congress party)\b/i,
  /\b(income|salary|wealthy|rich|net worth|affluent)\b/i,
  /\b(attractive|beautiful|handsome|pretty|hot|sexy|good-looking|body type|slim|thin|fat|overweight|physique)\b/i,
];
export const isForbidden = (s: string) => FORBIDDEN.some((r) => r.test(s));

const READER_SYSTEM = `You are "the Reader": you build a dating profile of ONE person from exactly two sources, their LinkedIn and their public Instagram, given as an evidence list. Nothing else exists; use no outside knowledge about this person.
Rules:
- Every claim cites evidence IDs from the list. Uncited claims are deleted.
- Specific beats generic: "Runs half marathons, posted 3 race bibs in 2025" not "likes fitness". Name places, counts, years when shown.
- Low evidence → low confidence, and say so in "unknowns". Never invent biography.
- Evidence marked "lower weight" (recommendations) is what others said; weigh it less.
- needs and likely_dealbreakers are inferences: phrase "why" as reasoning.
- NEVER infer or mention sexual orientation, gender preference, religion, caste, ethnicity, health, politics, income/wealth, or looks/attractiveness/body. Photos only show activities, settings, hobbies, aesthetic.
- public_card is the ONLY thing other people's agents see before a date: friendly, specific, no private inferences.
- English, third person, warm but not flattering. Keep each string concise. 3-6 items per list.`;

/** Drop citations that don't exist, claims that end up uncited, and anything touching forbidden attributes. */
export function validateProfile(p: PersonProfile, validIds: Set<string>): PersonProfile {
  const keep = (ids: string[]) => ids.filter((id) => validIds.has(id));
  const clean = <T extends { evidence: string[] }>(items: T[], text: (t: T) => string) =>
    items.map((i) => ({ ...i, evidence: keep(i.evidence) })).filter((i) => i.evidence.length > 0 && !isForbidden(text(i)));
  const safe = (xs: string[]) => xs.filter((x) => !isForbidden(x));
  const safeText = (s: string) => (isForbidden(s) ? "" : s);
  return {
    ...p,
    headline: safeText(p.headline),
    vibe: safeText(p.vibe),
    hobbies: clean(p.hobbies, (h) => h.name),
    interests: clean(p.interests, (h) => h.name),
    values: clean(p.values, (v) => `${v.name} ${v.why}`),
    needs: clean(p.needs, (n) => `${n.need} ${n.why}`),
    likely_dealbreakers: clean(p.likely_dealbreakers, (d) => `${d.item} ${d.why}`),
    lifestyle: { ...p.lifestyle, evidence: keep(p.lifestyle.evidence) },
    career: { ...p.career, evidence: keep(p.career.evidence) },
    communication_style: { ...p.communication_style, evidence: keep(p.communication_style.evidence) },
    green_flags_for_them: safe(p.green_flags_for_them),
    conversation_hooks: safe(p.conversation_hooks),
    unknowns: safe(p.unknowns),
    public_card: { headline: safeText(p.public_card.headline), one_liner: safeText(p.public_card.one_liner), top_interests: safe(p.public_card.top_interests).slice(0, 3) },
  };
}

// ---------- Pass A: perception, one call per batch of ≤3 cached images ----------

export async function perceiveBatch(personId: string, batch: number) {
  const posts = (must(await db().from("evidence").select("*").eq("person_id", personId).eq("kind", "post"), "load posts") as EvidenceRow[])
    .filter((p) => p.image_url)
    .sort((a, b) => Number(a.id.split(":")[2]) - Number(b.id.split(":")[2]));
  const slice = posts.slice(batch * MAX_IMAGES_PER_VISION_CALL, (batch + 1) * MAX_IMAGES_PER_VISION_CALL);
  if (!slice.length) return logEvent(personId, "reader", batch === 0 ? "No public photos to look at" : "No more photos");
  await logEvent(personId, "reader", `Looking at photos ${batch * 3 + 1}–${batch * 3 + slice.length}…`);

  const content: ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] = [
    { type: "text", text: `Describe each of these ${slice.length} photos: activities, setting, hobby signals, social context, neutral caption. Never comment on anyone's appearance, body, ethnicity, religion or attractiveness.` },
  ];
  slice.forEach((p, i) => {
    content.push({ type: "text", text: `Image ${i + 1}:` });
    content.push({ type: "image_url", image_url: { url: p.image_url! } });
  });
  const res = await llmObject({
    tier: "vision",
    schema: VisionSchema,
    system: "You describe photos neutrally for a hobby/activity profile. No judgments about people's looks or identity.",
    user: content,
    maxOutputTokens: 1200,
    tag: { person_id: personId, step: "vision" },
  });
  const rows = res.images
    .filter((im) => im.image_number >= 1 && im.image_number <= slice.length)
    .map((im) => {
      const post = slice[im.image_number - 1];
      const text = `Photo: ${im.caption}. Activities: ${im.activities.join(", ") || "none"}. Setting: ${im.setting}. Hobby signals: ${im.hobby_signals.join(", ") || "none"}. ${im.social_context}.`;
      return { person_id: personId, id: `ig:img:${post.id.split(":")[2]}`, source: "instagram" as const, kind: "image", text: isForbidden(text) ? `Photo: ${im.setting}, ${im.social_context}.` : text, image_url: post.image_url, meta: { post: post.id, url: post.meta?.url ?? null } };
    });
  if (rows.length) must(await db().from("evidence").upsert(rows), "save image evidence");
  const acts = res.images.flatMap((i) => i.activities.map((a) => a.toLowerCase()));
  const top = Object.entries(acts.reduce<Record<string, number>>((m, a) => ((m[a] = (m[a] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1])[0];
  await logEvent(personId, "reader", top ? `Seeing ${top[0]} in ${top[1]} photo${top[1] > 1 ? "s" : ""}…` : `Described ${rows.length} photos`);
}

// ---------- Pass B: synthesis ----------

export async function synthesize(personId: string): Promise<PersonProfile> {
  const evidence = must(await db().from("evidence").select("id, kind, text").eq("person_id", personId), "load evidence") as Pick<EvidenceRow, "id" | "kind" | "text">[];
  const person = must(await db().from("people").select("name").eq("id", personId).single(), "load person");
  await logEvent(personId, "reader", `Synthesizing profile from ${evidence.length} pieces of evidence…`);
  // Keep the prompt inside the provider's per-minute token window.
  const lines = evidence.map((e) => `[${e.id}] ${e.text.length > 320 ? e.text.slice(0, 320) + "…" : e.text}`).join("\n");
  const raw = await llmObject({
    tier: "smart",
    schema: PersonProfileSchema,
    system: READER_SYSTEM,
    user: `Name: ${person.name}\n\nEVIDENCE (the only things you know):\n${lines}\n\nBuild their profile.`,
    maxOutputTokens: 3500,
    tag: { person_id: personId, step: "synthesize" },
  });
  const profile = validateProfile(raw, new Set(evidence.map((e) => e.id)));
  const count = (p: PersonProfile) => p.hobbies.length + p.interests.length + p.values.length + p.needs.length + p.likely_dealbreakers.length;
  const dropped = count(raw) - count(profile);
  must(await db().from("profiles").upsert({ person_id: personId, profile, model: MODELS.smart, created_at: new Date().toISOString() }), "save profile");
  await logEvent(
    personId,
    "reader",
    `Profile ready: ${profile.hobbies.length} hobbies, ${profile.interests.length} interests, ${profile.values.length} values, ${profile.unknowns.length} honest unknowns${dropped ? ` (validator dropped ${dropped} uncited/unsafe claims)` : ""}`,
  );
  return profile;
}
