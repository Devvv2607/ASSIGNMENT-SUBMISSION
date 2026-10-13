/**
 * Checkpoint 1: run the real pipeline for ONE person up to their profile.
 * Saves the raw (stripped) actor output to /fixtures, prints evidence counts by source and the profile.
 *   npx tsx scripts/fixtures.ts "<name>" <linkedin_url> <instagram_url> [gender]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { writeFileSync } from "node:fs";
import { db, must } from "../src/lib/db";
import { parseInstagram, parseLinkedIn } from "../src/lib/ingest";
import { stepPerson } from "../src/lib/pipeline";

async function main() {
  const [name, li, igUrl, gender] = process.argv.slice(2);
  const linkedin = parseLinkedIn(li ?? "");
  const ig = parseInstagram(igUrl ?? "");
  if (!name || !linkedin || !ig) throw new Error('usage: npx tsx scripts/fixtures.ts "<name>" <linkedin_url> <instagram_url> [man|woman]');

  let { data: person } = await db().from("people").select("id, status").eq("linkedin_url", linkedin).maybeSingle();
  if (!person) {
    person = must(
      await db()
        .from("people")
        .insert({ name, linkedin_url: linkedin, instagram_url: ig.url, consent_source: `self (project owner), ${new Date().toISOString().slice(0, 10)}`, gender: gender === "man" || gender === "woman" ? gender : null })
        .select("id, status")
        .single(),
      "insert",
    );
  }
  const id = person.id;
  console.log(`person ${id}`);

  for (let i = 0; i < 12; i++) {
    const r = await stepPerson(id, { stopBefore: "prescreen" });
    console.log(`  → stage ${r.stage} (${r.status})`);
    if (r.stage === "prescreen" || r.status === "rejected") break;
  }

  const raws = must(await db().from("raw_sources").select("source, payload, usage_usd").eq("person_id", id), "raw") as { source: string; payload: unknown; usage_usd: number | null }[];
  for (const r of raws) {
    writeFileSync(`fixtures/${r.source}.json`, JSON.stringify(r.payload, null, 2));
    console.log(`saved fixtures/${r.source}.json (Apify cost $${r.usage_usd ?? "?"})`);
  }
  const ev = must(await db().from("evidence").select("id, source, kind").eq("person_id", id), "ev") as { id: string; source: string; kind: string }[];
  const by = ev.reduce<Record<string, number>>((m, e) => ((m[`${e.source}/${e.kind}`] = (m[`${e.source}/${e.kind}`] ?? 0) + 1), m), {});
  console.log(`\nEvidence: ${ev.length} rows`, by);
  const { data: prof } = await db().from("profiles").select("profile").eq("person_id", id).maybeSingle();
  const { data: p } = await db().from("people").select("status, error").eq("id", id).single();
  if (p?.error) console.log(`\nERROR: ${p.error}`);
  console.log("\nProfile:\n" + JSON.stringify(prof?.profile ?? null, null, 2));
  const { data: usage } = await db().from("llm_usage").select("model, step, prompt_tokens, completion_tokens").eq("person_id", id);
  console.log("\nLLM usage:", usage);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
