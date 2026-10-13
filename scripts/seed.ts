/**
 * Seed the pool from seed/people.csv and run everything locally (no serverless time limits).
 *   npx tsx scripts/seed.ts            # ingest + read everyone, prescreen, top-3 dates each
 *   npx tsx scripts/seed.ts --dates    # skip ingestion, only (re)run missing dates
 * Idempotent: people already "ready" are skipped, finished dates are not re-run.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { readFileSync } from "node:fs";
import { db, must } from "../src/lib/db";
import { parseInstagram, parseLinkedIn } from "../src/lib/ingest";
import { processPerson, DATES_PER_PERSON } from "../src/lib/pipeline";
import { prescreenAll, topByPrior } from "../src/lib/prescreen";
import { claimDate, createDate, runDate } from "../src/lib/date";
import { pool } from "../src/lib/util";

function parseCsv(text: string) {
  const rows = text.trim().split(/\r?\n/).map((line) => {
    const out: string[] = [];
    let cur = "", q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) (out.push(cur), (cur = ""));
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  });
  const [head, ...body] = rows;
  return body.filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const runQueued = async (dateId: string) => {
  if (await claimDate(dateId)) await runDate(dateId);
};

async function main() {
  const onlyDates = process.argv.includes("--dates");

  if (!onlyDates) {
    const people = parseCsv(readFileSync("seed/people.csv", "utf8"));
    console.log(`CSV: ${people.length} people`);
    const ids: string[] = [];
    for (const p of people) {
      const li = parseLinkedIn(p.linkedin_url);
      const ig = parseInstagram(p.instagram_url);
      if (!li || !ig) {
        console.error(`✗ ${p.name}: bad URL(s)`);
        continue;
      }
      const { data: existing } = await db().from("people").select("id, status").eq("linkedin_url", li).maybeSingle();
      if (existing?.status === "ready") {
        ids.push(existing.id);
        continue;
      }
      const row = existing
        ? existing
        : must(
            await db()
              .from("people")
              .insert({ name: p.name, linkedin_url: li, instagram_url: ig.url, consent_source: p.consent_source || "opted in via form", gender: ["man", "woman"].includes(p.gender) ? p.gender : null })
              .select("id, status")
              .single(),
            "insert person",
          );
      ids.push(row.id);
    }

    // Ingest + read, 5 at a time. Dates are created later, once everyone has a profile.
    const todo = (must(await db().from("people").select("id, name, status").in("id", ids), "load") as { id: string; name: string; status: string }[]).filter((p) => p.status !== "ready");
    console.log(`Ingesting + reading ${todo.length} people…`);
    const res = await pool(todo, 5, async (p) => {
      await processPerson(p.id, null); // dates are scheduled globally below
      const { data } = await db().from("people").select("status, error").eq("id", p.id).single();
      console.log(`${data?.status === "ready" ? "✓" : "✗"} ${p.name}${data?.error ? `: ${data.error}` : ""}`);
    });
    res.forEach((r, i) => !r.ok && console.error(`✗ ${todo[i].name}: ${r.error}`));
  }

  console.log("Pre-screening all pairs…");
  console.log(`${await prescreenAll()} pair priors`);

  // Each person's top-k by prior, deduplicated pairs.
  const ready = must(await db().from("people").select("id").eq("status", "ready"), "ready") as { id: string }[];
  const dateIds = new Set<string>();
  for (const p of ready) {
    for (const other of await topByPrior(p.id, DATES_PER_PERSON)) {
      const { id } = await createDate(p.id, other);
      dateIds.add(id);
    }
  }
  const pending = (must(await db().from("dates").select("id, status").in("id", [...dateIds]), "dates") as { id: string; status: string }[]).filter((d) => d.status === "queued");
  console.log(`Running ${pending.length} dates (of ${dateIds.size} planned), 5 at a time…`);
  let n = 0;
  const out = await pool(pending, 5, async (d) => {
    await runQueued(d.id);
    console.log(`  date ${++n}/${pending.length} done`);
  });
  out.forEach((r, i) => !r.ok && console.error(`✗ date ${pending[i].id}: ${r.error}`));
  console.log("Seed complete. Run: npx tsx scripts/verify.ts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
