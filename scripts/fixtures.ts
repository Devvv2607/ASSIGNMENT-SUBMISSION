/**
 * Run each Apify actor once on a test person and save raw output to /fixtures, then print the
 * normalized evidence so the normalizers can be checked against the real output shape.
 *   npx tsx scripts/fixtures.ts <linkedin_url> <instagram_url>
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { writeFileSync } from "node:fs";
import { ApifyClient } from "apify-client";
import { ACTORS, normalizeInstagram, normalizeLinkedIn, parseInstagram, parseLinkedIn } from "../src/lib/ingest";

async function main() {
  const [li, igUrl] = process.argv.slice(2);
  const linkedin = parseLinkedIn(li ?? "");
  const ig = parseInstagram(igUrl ?? "");
  if (!linkedin || !ig) throw new Error("usage: npx tsx scripts/fixtures.ts <linkedin_url> <instagram_url>");
  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
  const [a, b] = await Promise.all([
    client.actor(ACTORS.linkedin).call({ urls: [linkedin] }),
    client.actor(ACTORS.instagram).call({ usernames: [ig.handle] }),
  ]);
  const liItems = (await client.dataset(a.defaultDatasetId).listItems()).items;
  const igItems = (await client.dataset(b.defaultDatasetId).listItems()).items;
  writeFileSync("fixtures/linkedin.json", JSON.stringify(liItems, null, 2));
  writeFileSync("fixtures/instagram.json", JSON.stringify(igItems, null, 2));
  console.log("LinkedIn keys:", Object.keys(liItems[0] ?? {}).join(", "));
  console.log("Instagram keys:", Object.keys(igItems[0] ?? {}).join(", "));
  console.log("\nNormalized evidence:");
  for (const e of [...normalizeLinkedIn(liItems[0] ?? {}), ...normalizeInstagram(igItems[0] ?? {})]) console.log(`[${e.id}] ${e.text.slice(0, 140)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
