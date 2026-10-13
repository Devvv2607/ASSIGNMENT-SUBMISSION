/** Create the public 'media' bucket and report which tables exist.  npx tsx scripts/setup-storage.ts */
import { config } from "dotenv";
config({ path: ".env.local" });
import { db } from "../src/lib/db";

async function main() {
  const { data: buckets, error } = await db().storage.listBuckets();
  if (error) throw error;
  if (!buckets.some((b) => b.id === "media")) {
    const r = await db().storage.createBucket("media", { public: true });
    console.log(r.error ? `bucket error: ${r.error.message}` : "created public bucket 'media'");
  } else console.log("bucket 'media' exists");
  for (const t of ["people", "raw_sources", "evidence", "profiles", "pair_priors", "dates", "date_turns", "debriefs", "job_events", "llm_usage", "rate_events"]) {
    const { error } = await db().from(t).select("*").limit(1);
    console.log(`${error ? "✗" : "✓"} ${t}${error ? `  (${error.message})` : ""}`);
  }
  const { error: colErr } = await db().from("people").select("stage, lock_until, planned_dates").limit(1);
  console.log(`${colErr ? "✗" : "✓"} people v2 columns${colErr ? `  (${colErr.message})` : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
