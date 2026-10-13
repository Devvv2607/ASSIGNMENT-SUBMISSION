/**
 * Seed the pool from seed/people.csv using the same step functions as the web app.
 *   npx tsx scripts/seed.ts             # everyone in the CSV
 *   npx tsx scripts/seed.ts --limit 3   # only the first N rows (checkpoint runs)
 *   npx tsx scripts/seed.ts --dates     # skip people, only (re)run missing dates
 * Idempotent: finished stages and finished dates are never redone.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { readFileSync } from "node:fs";
import { db, must } from "../src/lib/db";
import { parseInstagram, parseLinkedIn } from "../src/lib/ingest";
import { stepPerson, failPerson, DATES_PER_PERSON } from "../src/lib/pipeline";
import { prescreenAll, topByPrior } from "../src/lib/prescreen";
import { createDate, runDateToEnd } from "../src/lib/date";
import { pool, errMsg } from "../src/lib/util";

function parseCsv(text: string) {
  const rows = text
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const out: string[] = [];
      let cur = "",
        q = false;
      for (const ch of line) {
        if (ch === '"') q = !q;
        else if (ch === "," && !q) {
          out.push(cur);
          cur = "";
        }
        else cur += ch;
      }
      out.push(cur);
      return out.map((s) => s.trim());
    });
  const [head, ...body] = rows;
  return body.filter((r) => r.some(Boolean)).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

async function readPerson(id: string, name: string) {
  let failures = 0;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await stepPerson(id, { stopBefore: "prescreen" });
      if (r.status === "rejected") return console.log(`✗ ${name}: rejected`);
      if (r.stage === "prescreen" || r.stage === "done") return console.log(`✓ ${name}`);
      if (!r.worked) await new Promise((res) => setTimeout(res, 3000));
    } catch (e) {
      if (++failures >= 3) {
        await failPerson(id, errMsg(e));
        return console.log(`✗ ${name}: ${errMsg(e)}`);
      }
      await new Promise((res) => setTimeout(res, 5000 * failures));
    }
  }
}

async function main() {
  const onlyDates = process.argv.includes("--dates");
  const li = process.argv.indexOf("--limit");
  const limit = li > 0 ? Number(process.argv[li + 1]) : Infinity;
  const t0 = Date.now();

  if (!onlyDates) {
    const rows = parseCsv(readFileSync("seed/people.csv", "utf8")).slice(0, limit);
    console.log(`CSV: ${rows.length} people`);
    const people: { id: string; name: string }[] = [];
    for (const p of rows) {
      const linkedin = parseLinkedIn(p.linkedin_url);
      const ig = parseInstagram(p.instagram_url);
      if (!linkedin || !ig) {
        console.error(`✗ ${p.name}: bad URL(s)`);
        continue;
      }
      const { data: existing } = await db().from("people").select("id").eq("linkedin_url", linkedin).maybeSingle();
      const row =
        existing ??
        must(
          await db()
            .from("people")
            .insert({ name: p.name, linkedin_url: linkedin, instagram_url: ig.url, consent_source: p.consent_source || "opted in via form", gender: ["man", "woman"].includes(p.gender) ? p.gender : null })
            .select("id")
            .single(),
          "insert person",
        );
      people.push({ id: row.id, name: p.name });
    }
    console.log("Ingesting + reading (3 at a time)…");
    await pool(people, 3, (p) => readPerson(p.id, p.name));
  }

  console.log(`Pre-screening all pairs: ${await prescreenAll()} priors`);

  // Each ready person's top-k by prior, deduplicated pairs. Seeded people's own pipelines end here.
  const ready = must(await db().from("people").select("id, stage").eq("status", "ready"), "ready") as { id: string; stage: string }[];
  const planned = new Set<string>();
  for (const p of ready) {
    const ids: string[] = [];
    for (const other of await topByPrior(p.id, DATES_PER_PERSON)) {
      const { id } = await createDate(p.id, other);
      ids.push(id);
      planned.add(id);
    }
    if (p.stage === "prescreen") must(await db().from("people").update({ stage: "done", planned_dates: ids }).eq("id", p.id), "finish person");
  }
  const todo = (must(await db().from("dates").select("id, status").in("id", [...planned]), "dates") as { id: string; status: string }[]).filter((d) => d.status !== "done");
  console.log(`Running ${todo.length} dates (of ${planned.size} planned)…`);
  let n = 0;
  await pool(todo, 3, async (d) => {
    try {
      const s = await runDateToEnd(d.id);
      console.log(`  date ${++n}/${todo.length}: ${s}  (${d.id})`);
    } catch (e) {
      console.log(`  date ${++n}/${todo.length}: FAILED ${errMsg(e)}  (${d.id})`);
    }
  });
  console.log(`Seed finished in ${((Date.now() - t0) / 60000).toFixed(1)} min. Run: npx tsx scripts/verify.ts`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
