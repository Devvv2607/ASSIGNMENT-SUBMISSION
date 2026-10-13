/** Acceptance checks against the live database.  npx tsx scripts/verify.ts */
import { config } from "dotenv";
config({ path: ".env.local" });
import { db } from "../src/lib/db";
import { isForbidden, type PersonProfile } from "../src/lib/reader";
import type { Debrief } from "../src/lib/date";

const all = async <T>(table: string, cols: string): Promise<T[]> => {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db().from(table).select(cols).range(from, from + 999);
    if (error) throw error;
    out.push(...(data as T[]));
    if (!data || data.length < 1000) return out;
  }
};

async function main() {
  const people = await all<{ id: string; name: string; status: string }>("people", "id, name, status");
  const ready = people.filter((p) => p.status === "ready");
  const profiles = await all<{ person_id: string; profile: PersonProfile }>("profiles", "person_id, profile");
  const evidence = await all<{ person_id: string; id: string }>("evidence", "person_id, id");
  const dates = await all<{ id: string; a_id: string; b_id: string; status: string; venue: string | null }>("dates", "id, a_id, b_id, status, venue");
  const turns = await all<{ date_id: string }>("date_turns", "date_id");
  const debriefs = await all<{ date_id: string; report: Debrief }>("debriefs", "date_id, report");

  const checks: [string, boolean, string][] = [];
  checks.push(["≥ 25 people ready with profiles", ready.length >= 25 && ready.every((p) => profiles.some((x) => x.person_id === p.id)), `${ready.length} ready / ${people.length} total`]);

  const evSet = new Set(evidence.map((e) => `${e.person_id}|${e.id}`));
  let uncited = 0, badRef = 0, forbidden = 0;
  for (const { person_id, profile: p } of profiles) {
    const claims = [...p.hobbies, ...p.interests, ...p.values, ...p.needs, ...p.likely_dealbreakers];
    for (const c of claims) {
      if (!c.evidence.length) uncited++;
      badRef += c.evidence.filter((id) => !evSet.has(`${person_id}|${id}`)).length;
    }
    if (isForbidden(JSON.stringify({ ...p, unknowns: [] }))) forbidden++;
  }
  checks.push(["Every claim cites ≥1 existing evidence ID", uncited === 0 && badRef === 0, `${uncited} uncited, ${badRef} dangling refs`]);
  checks.push(["No forbidden attributes in profiles", forbidden === 0, `${forbidden} profiles flagged`]);

  const done = dates.filter((d) => d.status === "done");
  const perPerson = ready.map((p) => done.filter((d) => d.a_id === p.id || d.b_id === p.id).length);
  checks.push(["Every person has ≥ 3 completed dates", perPerson.every((n) => n >= 3), `min ${Math.min(...perPerson)}, max ${Math.max(...perPerson)}`]);

  const tCount = new Map<string, number>();
  turns.forEach((t) => tCount.set(t.date_id, (tCount.get(t.date_id) ?? 0) + 1));
  const bad = done.filter((d) => (tCount.get(d.id) ?? 0) < 8 || debriefs.filter((x) => x.date_id === d.id).length !== 2 || !d.venue);
  checks.push(["Every done date: 8+ turns, 2 debriefs, venue", bad.length === 0, `${done.length} done, ${bad.length} incomplete`]);

  const scores = debriefs.map((d) => d.report.overall);
  const mean = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
  const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / (scores.length || 1));
  checks.push(["Scores spread (sd > 12) and not inflated (mean < 70)", sd > 12 && mean < 70, `mean ${mean.toFixed(1)}, sd ${sd.toFixed(1)}, n=${scores.length}`]);
  const yes = debriefs.filter((d) => d.report.second_date).length;
  console.log(`\nSecond-date yes rate: ${((yes / (debriefs.length || 1)) * 100).toFixed(0)}%   errored dates: ${dates.filter((d) => d.status === "error").length}\n`);

  for (const [name, ok, detail] of checks) console.log(`${ok ? "✓" : "✗"} ${name}  (${detail})`);
  process.exit(checks.every((c) => c[1]) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
