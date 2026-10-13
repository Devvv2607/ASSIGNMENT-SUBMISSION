/** Acceptance checks + real cost report against the live database.  npx tsx scripts/verify.ts [--min 25] */
import { config } from "dotenv";
config({ path: ".env.local" });
import { db } from "../src/lib/db";
import { isForbidden, type PersonProfile } from "../src/lib/reader";
import type { Debrief } from "../src/lib/date";
import { rankingsFor } from "../src/lib/rankings";

// Groq list prices, USD per 1M tokens (input, output). Update if Groq changes pricing.
const PRICES: Record<string, [number, number]> = {
  "openai/gpt-oss-120b": [0.15, 0.6],
  "openai/gpt-oss-20b": [0.075, 0.3],
};

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
  const mi = process.argv.indexOf("--min");
  const MIN = mi > 0 ? Number(process.argv[mi + 1]) : 25;
  const people = await all<{ id: string; name: string; status: string }>("people", "id, name, status");
  const ready = people.filter((p) => p.status === "ready");
  const profiles = await all<{ person_id: string; profile: PersonProfile }>("profiles", "person_id, profile");
  const evidence = await all<{ person_id: string; id: string }>("evidence", "person_id, id");
  const dates = await all<{ id: string; a_id: string; b_id: string; status: string; venue: string | null; mutual_score: number | null }>("dates", "id, a_id, b_id, status, venue, mutual_score");
  const turns = await all<{ date_id: string; idx: number; speaker_id: string }>("date_turns", "date_id, idx, speaker_id");
  const debriefs = await all<{ date_id: string; person_id: string; report: Debrief }>("debriefs", "date_id, person_id, report");

  const checks: [string, boolean, string][] = [];
  const withProfile = ready.filter((p) => profiles.some((x) => x.person_id === p.id));
  checks.push([`≥ ${MIN} people ready with profiles`, withProfile.length >= MIN, `${withProfile.length} ready with profiles / ${people.length} rows`]);

  const evSet = new Set(evidence.map((e) => `${e.person_id}|${e.id}`));
  let uncited = 0,
    badRef = 0;
  const flagged: string[] = [];
  for (const { person_id, profile: p } of profiles) {
    const claims = [...p.hobbies, ...p.interests, ...p.values, ...p.needs, ...p.likely_dealbreakers];
    for (const c of claims) {
      if (!c.evidence.length) uncited++;
      badRef += c.evidence.filter((id) => !evSet.has(`${person_id}|${id}`)).length;
    }
    if (isForbidden(JSON.stringify(p))) flagged.push(people.find((x) => x.id === person_id)?.name ?? person_id);
  }
  checks.push(["Every claim cites ≥1 valid evidence ID", uncited === 0 && badRef === 0, `${uncited} uncited, ${badRef} dangling refs`]);
  checks.push(["No protected-attribute content", flagged.length === 0, flagged.length ? `flagged: ${flagged.join(", ")}` : "clean"]);

  const byDate = new Map<string, { idx: number; speaker_id: string }[]>();
  turns.forEach((t) => byDate.set(t.date_id, [...(byDate.get(t.date_id) ?? []), t]));
  const goodDate = (d: (typeof dates)[number]) => {
    const ts = (byDate.get(d.id) ?? []).sort((a, b) => a.idx - b.idx);
    const alternating = ts.every((t, i) => t.idx === i && (i === 0 || t.speaker_id !== ts[i - 1].speaker_id));
    return d.status === "done" && ts.length >= 8 && alternating && debriefs.filter((x) => x.date_id === d.id).length === 2 && !!d.venue && d.mutual_score != null;
  };
  const done = dates.filter((d) => d.status === "done");
  const bad = done.filter((d) => !goodDate(d));
  checks.push(["Every done date: 8+ alternating turns, 2 debriefs, venue, verdict", bad.length === 0, `${done.length} done, ${bad.length} incomplete, ${dates.filter((d) => d.status === "error").length} errored`]);
  const perPerson = withProfile.map((p) => dates.filter((d) => (d.a_id === p.id || d.b_id === p.id) && goodDate(d)).length);
  checks.push(["Every person has ≥ 3 completed dates", perPerson.length > 0 && perPerson.every((n) => n >= 3), `min ${Math.min(...perPerson)}, max ${Math.max(...perPerson)}`]);

  let rankOk = 0;
  for (const p of withProfile) {
    const r = await rankingsFor(p.id);
    const complete = r.length === withProfile.length - 1 && r.every((x) => x.source === "date" || x.source === "prior");
    if (complete) rankOk++;
  }
  checks.push([`Every person ranks all ${withProfile.length - 1} others (date vs prior labelled)`, rankOk === withProfile.length, `${rankOk}/${withProfile.length} complete`]);

  const scores = debriefs.map((d) => d.report.overall);
  const mean = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
  const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / (scores.length || 1));
  checks.push(["Scores spread (sd > 12) and not inflated (mean < 70)", sd > 12 && mean < 70, `mean ${mean.toFixed(1)}, sd ${sd.toFixed(1)}, n=${scores.length}`]);
  const yes = debriefs.filter((d) => d.report.second_date).length;

  for (const [name, ok, detail] of checks) console.log(`${ok ? "✓" : "✗"} ${name}  (${detail})`);
  console.log(`\nSecond-date yes rate: ${((yes / (debriefs.length || 1)) * 100).toFixed(0)}%`);

  // ---- Real cost from logged usage ----
  const usage = await all<{ person_id: string | null; date_id: string | null; model: string; prompt_tokens: number; completion_tokens: number }>("llm_usage", "person_id, date_id, model, prompt_tokens, completion_tokens");
  const cost = (u: (typeof usage)[number]) => {
    const [i, o] = PRICES[u.model] ?? [0, 0];
    return (u.prompt_tokens * i + u.completion_tokens * o) / 1e6;
  };
  const sum = (xs: typeof usage) => ({ usd: xs.reduce((a, u) => a + cost(u), 0), tok: xs.reduce((a, u) => a + u.prompt_tokens + u.completion_tokens, 0) });
  const personU = sum(usage.filter((u) => u.person_id));
  const dateU = sum(usage.filter((u) => u.date_id));
  const nP = new Set(usage.filter((u) => u.person_id).map((u) => u.person_id)).size || 1;
  const nD = new Set(usage.filter((u) => u.date_id).map((u) => u.date_id)).size || 1;
  const raws = await all<{ usage_usd: number | null }>("raw_sources", "usage_usd");
  const apify = raws.reduce((a, r) => a + Number(r.usage_usd ?? 0), 0);
  console.log(`\nCost (from logged usage; vision model priced at $0 if not in PRICES):`);
  console.log(`  per person: LLM ${(personU.tok / nP).toFixed(0)} tokens ≈ $${(personU.usd / nP).toFixed(4)}  + Apify ≈ $${(apify / nP).toFixed(4)}`);
  console.log(`  per date:   LLM ${(dateU.tok / nD).toFixed(0)} tokens ≈ $${(dateU.usd / nD).toFixed(4)}`);

  process.exit(checks.every((c) => c[1]) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
