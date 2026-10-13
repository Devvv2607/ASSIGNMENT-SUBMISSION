# Proxy: agents that date on your behalf

Paste someone's **LinkedIn** and **public Instagram**. Proxy reads only those two sources, builds an evidence-cited profile, and sends that person's AI Proxy on real, multi-turn dates with other Proxies. Each Proxy then writes an honest private debrief to its own human.

## What happens to each person

1. **Ingest:** Apify (`harvestapi/linkedin-profile-scraper` and `apify/instagram-profile-scraper`) runs in parallel. Private Instagram accounts are rejected. Raw output is cached for 7 days.
2. **Evidence store:** every fact becomes a row with an ID (`li:exp:2`, `ig:post:7`). The avatar and up to 6 post images are copied to Supabase Storage, because Instagram CDN URLs expire.
3. **Reader:**
   - Pass A is one batched vision call on the photos: activities, setting, hobbies. Looks are never assessed.
   - Pass B is a Sonnet synthesis into a Zod-validated profile. A validator drops uncited claims and anything touching protected attributes.
4. **Pre-screen:** a free Jaccard overlap of hobby, interest and value terms gives a prior for every pair.
5. **Dates:** each person gets a full date with their top 3 by prior. Any other pair can be dated live with **Send on a date**.
6. **Rankings** use each person's own Proxy's scores and are computed from live data on every view.

### The date protocol
- **Prep:** each Proxy sees only the other's public card and writes private goals.
- **Venue:** both Proxies propose a date idea and agree on one.
- **Conversation:** 8–12 alternating Haiku turns. Each turn is `{ say, inner_thought, signals }`, and either side may end the date after turn 8.
- **Debriefs:** two independent Sonnet debriefs, each giving an overall score, 5 dimensions, flags tied to turns, a second-date yes/no and a note.
- **Mutual score:** the geometric mean of both scores × 0.8 if one side says no, or × 0.65 if both do.

## Stack
Next.js 15 (App Router), TypeScript, Tailwind v4, Supabase (Postgres + Storage), Apify, Anthropic via the Vercel AI SDK (`src/lib/llm.ts`; models can be swapped with `MODEL_SMART` / `MODEL_FAST`), Zod. Deployed on Vercel.

**Long jobs:**
- **Web app:** `/api/people` returns at once and runs the pipeline in `after()`. Each date runs in its own invocation (`/api/dates/[id]/run`, `maxDuration = 300`). Pages poll every 1.5s, so any viewer can watch a date live, and a refresh doesn't lose it.
- **Seed:** `scripts/seed.ts` runs everything locally with concurrency 5 and retries.

## Setup
```bash
npm install
cp .env.example .env.local      # fill in the keys
# Run supabase/schema.sql in the Supabase SQL editor (tables, RLS read policies, 'media' bucket)
npx tsx scripts/fixtures.ts <linkedin_url> <instagram_url>   # check the real actor output shape
# Fill seed/people.csv: name,linkedin_url,instagram_url,consent_source,gender(optional: man|woman)
npx tsx scripts/seed.ts          # ingest + analyze everyone, then top-3 dates each
npx tsx scripts/verify.ts        # acceptance checks
npm run dev
```

| Env var | Purpose |
|---|---|
| `APIFY_TOKEN` | Apify actors |
| `ANTHROPIC_API_KEY` | Claude |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Database + storage (server-side only) |
| `MODEL_SMART`, `MODEL_FAST` | Optional model overrides |

## Layout
```
src/lib/ingest.ts     URL validation, Apify, normalizers, image caching
src/lib/reader.ts     vision + synthesis, citation validator, forbidden-attribute filter
src/lib/prescreen.ts  pair priors
src/lib/date.ts       the date protocol + scoring
src/lib/pipeline.ts   per-person orchestration
src/lib/rankings.ts   rankings computed from live data
src/app/…             pages: /, /add, /p/[id], /date/[id], /how-it-works
scripts/              seed, verify, fixtures
supabase/schema.sql   schema
```

## Consent and safety
- Seed people opted in, and `consent_source` is stored for each person. The add form requires a consent checkbox.
- **Remove this person** deletes their data, cached images and every date involving them.
- The analysis never infers orientation, religion, caste, ethnicity, health, politics, income or looks. Orientation is not inferred; the rankings filter uses only self-reported gender and defaults to "everyone".
- No contact details are scraped. The Instagram external URL is ignored because it would be a third source.

## Known limitations
- The pre-screen is lexical, not embeddings.
- Live updates use polling, not websockets.
- Proxies can only know what the two profiles show; this is stated in each profile's "unknowns".
