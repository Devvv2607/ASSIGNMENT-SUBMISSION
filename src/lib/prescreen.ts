import { db, must } from "./db";
import type { PersonProfile } from "./reader";

const STOP = new Set("and or the a an of in on for to with at by from their them they is are as into about over under very lots lot more most love loves loving likes like enjoy enjoys".split(" "));

function stem(w: string) {
  return w.replace(/(ing|ers|er|es|s)$/, "");
}

function features(p: PersonProfile) {
  const names = [...p.hobbies.map((h) => h.name), ...p.interests.map((i) => i.name), ...p.values.map((v) => v.name), ...p.public_card.top_interests];
  const tokens = new Set(
    names
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map(stem),
  );
  return { tokens, names };
}

const jaccard = (a: Set<string>, b: Set<string>) => {
  const inter = [...a].filter((x) => b.has(x));
  const union = new Set([...a, ...b]).size;
  return { score: union ? inter.length / union : 0, shared: inter };
};

/** Cheap compatibility prior (0-100) from token overlap of hobbies + interests + values. No API calls. */
export function prior(a: PersonProfile, b: PersonProfile) {
  const j = jaccard(features(a).tokens, features(b).tokens);
  return { score: Math.min(100, Math.round(j.score * 300)), shared: j.shared.slice(0, 8) };
}

/** Recompute priors between `personId` and everyone else with a profile. */
export async function prescreenPerson(personId: string) {
  const rows = must(await db().from("profiles").select("person_id, profile"), "load profiles") as { person_id: string; profile: PersonProfile }[];
  const me = rows.find((r) => r.person_id === personId);
  if (!me) throw new Error("No profile to pre-screen");
  const upserts = rows
    .filter((r) => r.person_id !== personId)
    .map((r) => {
      const [a_id, b_id] = [personId, r.person_id].sort();
      const pr = prior(me.profile, r.profile);
      return { a_id, b_id, prior_score: pr.score, shared: pr.shared };
    });
  if (upserts.length) must(await db().from("pair_priors").upsert(upserts), "save priors");
  return upserts;
}

/** Recompute all pairs (used by the seed script). */
export async function prescreenAll() {
  const rows = must(await db().from("profiles").select("person_id, profile"), "load profiles") as { person_id: string; profile: PersonProfile }[];
  const upserts: { a_id: string; b_id: string; prior_score: number; shared: string[] }[] = [];
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      const [a_id, b_id] = [rows[i].person_id, rows[j].person_id].sort();
      const pr = prior(rows[i].profile, rows[j].profile);
      upserts.push({ a_id, b_id, prior_score: pr.score, shared: pr.shared });
    }
  for (let i = 0; i < upserts.length; i += 500) must(await db().from("pair_priors").upsert(upserts.slice(i, i + 500)), "save priors");
  return upserts.length;
}

/** The top-k partners for a person by prior. */
export async function topByPrior(personId: string, k: number) {
  const pr = must(
    await db().from("pair_priors").select("a_id, b_id, prior_score").or(`a_id.eq.${personId},b_id.eq.${personId}`).order("prior_score", { ascending: false }).limit(k),
    "load priors",
  ) as { a_id: string; b_id: string; prior_score: number }[];
  return pr.map((r) => (r.a_id === personId ? r.b_id : r.a_id));
}
