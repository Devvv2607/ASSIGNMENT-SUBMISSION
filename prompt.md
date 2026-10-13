# BUILD PROMPT — "Proxy": an agentic dating site where agents date on your behalf

> Paste this whole file into Claude Code as the first message (or save it as `CLAUDE.md` in the repo root).
> Fill in the `<<...>>` placeholders first.

---

## ⏱️ TIME-BOXED MODE: 2.5-HOUR BUILD (this section OVERRIDES everything below)

We have ~2.5 hours total, including deploy. Ship the core loop flawlessly; skip everything else.

**CUT (do not build):**
- Inngest → run batch jobs from a local script `scripts/seed.ts` (sequential, with retries). The `/add` flow runs in one streaming API route.
- pgvector/embeddings → pre-screen = Jaccard overlap of interests + values from profiles (no extra API calls)
- `harvestapi/linkedin-profile-posts` → skip, profile scraper only
- Supabase Realtime → stream directly with SSE / AI SDK streaming on the page that triggered the job
- Image download to Storage → store IG image URLs as-is; vision on max 6 images per person, in ONE batched call
- `/how-it-works` as a fancy page → one static page with a Mermaid diagram + bullets
- `verify.ts` → a 10-line script that counts people, profiles, dates, rankings
- Remove-person re-ranking → delete cascades only

**KEEP (non-negotiable):**
- Apify ingestion (LinkedIn + Instagram), private-IG rejection, consent checkbox
- Reader agent with evidence-cited claims (the citation chips on the profile page)
- Dates: venue pick → 8 turns with `inner_thought` → two independent debriefs → verdict
- Each person gets **3 full dates** (top 3 by prior, ~40 dates total); everyone else ranked by prior with a working **"Send on a date"** button
- Pages: Home grid, `/add` with live step log, Profile (Analysis/Dates/Rankings tabs), Date page with streaming + thoughts toggle
- Deployed on Vercel, working when graders paste new links

**Use parallel tool calls and parallel LLM calls (Promise.all, concurrency 5) everywhere.** Run the 25-person seed in the background while building UI.

**Time plan:**
| Min | Milestone |
|---|---|
| 0–15 | Scaffold Next.js + Supabase schema + env, deploy blank page to Vercel |
| 15–45 | Apify ingestion + evidence normalizer (test on 1 real person, save fixtures) |
| 45–75 | Reader agent + Profile page with real data |
| 75–105 | Single streaming date + debriefs + Date page |
| 105–125 | `seed.ts` for 25 people + 3 dates each (kick off, runs in background) + Rankings tab |
| 125–145 | `/add` live flow, "Send on a date", Home grid, How-it-works |
| 145–150 | Deploy, test the full grader flow on production |

If a milestone runs >10 min over, cut polish from the next one, never cut a KEEP item.

---

## 0. Role

You are a senior AI engineer and product engineer. You are building a take-home assignment that will be judged by people who will **use the live site themselves** and watch a **3-minute video**. Every feature must actually work end-to-end. A styled page that fakes behavior is an automatic fail. Prefer fewer features that work flawlessly over many that half-work.

Work in milestones (Section 9). After each milestone: run it, verify it, commit, then continue. Never mock data in the final build.

---

## 1. The assignment (non-negotiable requirements)

1. **Find the people.** At least 25 real people. Each person = exactly two official links: their **LinkedIn** and their **public Instagram**.
2. **Each agent reads its person.** Using ONLY those two sources, the agent analyzes needs, hobbies, interests and other qualities, shown on a **profile page**.
3. **The agents date each other.** Each person is represented by an agent; the agents go on dates on their person's behalf. The dates must be real, watchable, multi-turn interactions, not a score computed in a loop.
4. **Each person gets a ranking** of who fits them best.
5. **Information boundary:** for every person and every agent, the only two sources are LinkedIn + Instagram. Nothing else. No web search about the person, no other platforms.
6. Graders will paste links into the site themselves. Pasting links → analysis → profile → dates → rankings must work for a brand-new person, live.

---

## 2. Consent and safety (build these in, they are features, not footnotes)

- The seed set of 25 people are **people who opted in** (friends/classmates/colleagues who agreed). Store `consent_source` per person ("opted in via form, <date>").
- The "Add person" form has a required checkbox: *"I confirm this person has agreed to be included."*
- Every profile has a **Remove this person** action that deletes their data, cached images and all dates involving them, and re-ranks everyone else.
- Reject private Instagram accounts with a clear message (the actor returns `private: true`). Never try to get around it.
- The analysis must **never infer or display**: sexual orientation, religion, caste, ethnicity, health, political views, income, or attractiveness/body ratings from photos. Vision is used only for activities, settings, hobbies, and aesthetic/vibe (e.g., "lots of trekking", "café hopping", "film photography").
- Orientation/gender preference is **not inferred**. The rankings page has a viewer-side filter ("Show: everyone / men / women") that defaults to everyone. Mention this design choice on the How-it-works page.
- No contact details are scraped or shown (do not use email-finding modes of any actor).

---

## 3. Stack (use exactly this unless something is impossible)

- **Next.js 15 (App Router) + TypeScript + Tailwind + shadcn/ui**, deployed on **Vercel**
- **Supabase**: Postgres (data), Storage (cached Instagram images, since IG CDN URLs expire), Realtime (live date streaming to other viewers)
- **Apify** via `apify-client` (JS) — token in `APIFY_TOKEN`
- **LLM**: Anthropic API via Vercel AI SDK (`@ai-sdk/anthropic`)
  - `claude-sonnet-5-5` for person analysis, date planning, and post-date debriefs (quality matters here)
  - `claude-haiku-5-5` for individual date turns (speed + cost)
  - Wrap all calls in one `lib/llm.ts` so models are swappable via env vars
- **Embeddings** for the cheap pre-screen: any embedding model, stored with `pgvector`
- **Long jobs**: Inngest (free tier) for batch ingestion and batch dating. Each step is idempotent and retryable.
- Zod schemas for every LLM output. Use structured output / tool calling, never regex-parse prose.

---

## 4. Apify ingestion

### Actors
| Source | Actor | Input | Notes |
|---|---|---|---|
| LinkedIn | `harvestapi/linkedin-profile-scraper` | `{ urls: [linkedinUrl] }` | No cookies needed. Do NOT enable the email-search mode. |
| LinkedIn posts (optional, adds personality) | `harvestapi/linkedin-profile-posts` | `{ targetUrls: [linkedinUrl], maxPosts: 10 }` | Their own posts reveal voice and values. |
| Instagram | `apify/instagram-profile-scraper` | `{ usernames: [handle] }` | Returns bio, counts, `private` flag, latest posts with captions, hashtags, image URLs. |

Before writing code, call each actor once on a test profile and save the raw JSON to `/fixtures` so you can see the real output shape. Build the normalizers against that real shape.

### Ingestion rules
- Validate URLs: LinkedIn must match `linkedin.com/in/<slug>`, Instagram must match `instagram.com/<handle>`. Normalize handles.
- Run both actors in parallel with `client.actor(id).call(input)`, then read `defaultDatasetId`.
- Store raw actor output in `raw_sources` (jsonb) so analysis is reproducible and you never re-scrape unnecessarily. Cache for 7 days.
- Download up to 12 post images per person to Supabase Storage immediately.
- Normalize into an **Evidence Store**: every atomic fact becomes a row with an ID, e.g.
  - `li:exp:2` → "Data Analyst at X, 2024–present"
  - `li:post:4` → text of a LinkedIn post
  - `ig:bio` → Instagram bio
  - `ig:post:7` → caption + hashtags + stored image path + timestamp
- Show ingestion progress live in the UI (Section 7).

---

## 5. The agent pipeline

### 5.1 Analysis agent ("the Reader")
Runs per person. Two passes:

**Pass A — Perception.** For each Instagram post image, a vision call returns: activities, setting (outdoors/city/home/event), objects that signal hobbies, social context (solo/group), and a short neutral caption. No judgments about appearance. Stored as evidence `ig:img:7`.

**Pass B — Synthesis.** Sonnet reads the full Evidence Store and returns this Zod-validated object. **Every claim must cite evidence IDs.** Claims without citations are dropped by the validator.

```ts
PersonProfile = {
  headline: string,                 // one human line, e.g. "Product engineer who disappears into the Sahyadris every monsoon"
  vibe: string,                     // 2–3 sentences, warm, specific, no clichés
  hobbies:   { name, evidence: string[], confidence: 0-1 }[],
  interests: { name, evidence: string[], confidence: 0-1 }[],
  values:    { name, why, evidence: string[], confidence }[],  // e.g. ambition, community, craft, adventure
  lifestyle: { rhythm, social_energy, travel, fitness, evidence: string[] },
  career:    { current, trajectory, ambition_level, evidence: string[] },
  communication_style: { description, evidence: string[] },  // from caption + post tone
  needs:      { need, why, evidence: string[], confidence }[], // what they'd likely need in a partner
  likely_dealbreakers: { item, why, evidence: string[], confidence }[],
  green_flags_for_them: string[],   // what would make them light up on a date
  conversation_hooks: string[],     // specific things to ask them about
  unknowns: string[],               // what the two sources could NOT tell us (be honest)
  public_card: { headline, top_interests: string[3], one_liner }  // the ONLY thing other agents see before a date
}
```

Rules for the Reader:
- Specific beats generic. "Runs half marathons, posted 3 race bibs in 2025" not "likes fitness".
- Low evidence → low confidence → say so in `unknowns`. Never invent biography.
- Needs and dealbreakers are explicitly marked as *inferences* with reasoning.

Stream the Reader's progress to the UI as a step log ("Reading LinkedIn: 3 roles, 2 degrees… Reading 12 Instagram posts… Seeing trekking in 4 photos… Synthesizing…").

### 5.2 Dating agents ("the Proxies")
Each person gets a Proxy. Its system prompt contains:
- Its person's full `PersonProfile` (private)
- A **private agenda**: the person's top needs and dealbreakers as things to quietly check for on the date
- Voice instructions: speak as the person would (first person, their communication style, their real references), but stay honest. Never claim facts not in the profile.
- Instruction: *You are not here to be liked. You are here to find out if this is a good fit for the person you represent. Not every date goes well, and that's fine.*

### 5.3 The date (this is the centerpiece of the video, make it great)

A date between A and B has 5 stages, each stored and streamed:

1. **Pre-date prep (private).** Each Proxy sees only the other's `public_card` and writes 2–3 private goals ("find out if she actually wants to stay in Mumbai long-term").
2. **Pick the venue.** Each Proxy proposes a date idea grounded in its person's interests; they agree on one that fits both (e.g., "Sunday morning trek to Kalavantin, then misal"). The venue sets the scene for the conversation.
3. **The conversation.** 10–14 alternating turns. Every turn returns:
   ```ts
   { say: string, inner_thought: string, signals: { checked_need?: string, red_flag?: string, green_flag?: string } }
   ```
   `inner_thought` is private to that Proxy and shown in the UI behind a "Show what they're thinking" toggle. This is the single most compelling thing on screen.
   Add natural dynamics: follow-ups, disagreement allowed, a moment where a dealbreaker gets tested. Either Proxy may end the date early if it's going badly.
4. **Debrief (independent, private).** Each Proxy writes a report *to its own human*:
   ```ts
   {
     overall: 0-100,
     dimensions: { shared_interests, values_alignment, lifestyle_fit, conversation_chemistry, needs_met }, // each 0-10
     green_flags: { text, transcript_turn: number }[],
     red_flags:   { text, transcript_turn: number }[],
     second_date: boolean,
     note_to_my_human: string   // 2–3 sentences, honest, specific, quotes the date
   }
   ```
5. **Verdict.** Mutual score = geometric mean of both `overall` scores, with a penalty if either says no to a second date. Store both one-sided scores; asymmetry ("he liked her more than she liked him") is interesting and should be visible.

**Calibration check:** after a batch, if the score distribution is too flat or too generous (e.g., mean > 75), the debrief prompt is too soft. Fix the prompt, don't fudge numbers.

### 5.4 Who dates whom (cost-aware matchmaking)
25 people = 300 possible pairs. Don't brute-force full dates for all.
1. **Pre-screen all 300 pairs** cheaply: embedding similarity on interests/values + a lightweight compatibility prior. Store as `prior_score`.
2. **Full dates** for each person's top 6 by prior (deduplicated pairs, roughly 75–90 dates).
3. On every profile, any un-dated candidate shows a **"Send on a date"** button that runs a full date live. This is both a feature and a great video moment.
4. When a new person is added via the form: ingest → analyze → pre-screen against everyone → run their top 6 dates → update rankings for everyone affected.

### 5.5 Rankings
For every person: list all others ordered by **that person's Proxy's score** (their perspective), with:
- mutual score and a "mutual match" badge when both said yes
- the one-line `note_to_my_human` as the reason
- link to the full date transcript
- "Not dated yet — prior only" label for pre-screen-only entries, with the "Send on a date" button
- viewer-side gender filter (Section 2)

---

## 6. Data model (Supabase)

`people` (id, name, linkedin_url, instagram_url, consent_source, status, created_at)
`raw_sources` (person_id, source, actor_id, run_id, payload jsonb, fetched_at)
`evidence` (id text, person_id, source, kind, text, image_path, meta jsonb)
`profiles` (person_id, profile jsonb, model, created_at)
`embeddings` (person_id, vector)
`pair_priors` (a_id, b_id, prior_score)
`dates` (id, a_id, b_id, venue, status, started_at, ended_at, ended_early_by)
`date_turns` (date_id, idx, speaker_id, say, inner_thought, signals jsonb)
`debriefs` (date_id, person_id, report jsonb)
`rankings` (person_id, candidate_id, own_score, mutual_score, source: 'date'|'prior', reason)
`job_events` (job_id, person_id, step, message, created_at) — powers live progress logs

Enable RLS with a public read policy for the demo; writes only via server routes.

---

## 7. Pages

1. **`/` Home** — one-line pitch, the pool as a grid of cards (avatar from IG, headline, top 3 interests), a counter ("25 people · 84 dates · 1,120 turns"), and a big **"Add a person"** button.
2. **`/add`** — paste LinkedIn + Instagram, consent checkbox, submit → live pipeline view: Apify runs → evidence extracted → Reader thinking log → profile ready → dates starting. Each step lights up as it completes (driven by `job_events` + Realtime).
3. **`/p/[id]` Profile page** (graders see this first) — headline and vibe; hobbies, interests, values, lifestyle, career, communication style, needs, likely dealbreakers, unknowns. Every chip/claim is hoverable/clickable to show its **evidence** (the actual post image or LinkedIn line). Tabs: *Analysis · Dates · Rankings*. Plus the two source links and "Remove this person".
4. **`/date/[id]` Date page** — two avatars, the venue as a scene header, chat-style transcript that **streams live** when the date is running, "Show what they're thinking" toggle, signals shown as small tags, then both debriefs side by side and the verdict.
5. **`/p/[id]/rankings`** — the ranked list described in 5.5.
6. **`/how-it-works`** — the architecture diagram, the information boundary, the pipeline, the date protocol, how scoring works, the consent and safety choices, and known limitations. Graded second after the video, so make it clear and visual.

Design: dark, warm, editorial (serif display font, cream text on near-black) to feel like a premium product, not a hackathon template. Mobile responsive. Loading and error states everywhere.

---

## 8. Quality bar / acceptance tests

Write a `scripts/verify.ts` that checks, and run it before calling the build done:
- [ ] ≥ 25 people with both links, all ingested, all with profiles
- [ ] Every profile claim has ≥ 1 valid evidence ID that exists in `evidence`
- [ ] No profile contains forbidden attributes (scan for orientation/religion/caste/health/income/looks terms)
- [ ] Every person has ≥ 6 completed dates and a complete ranking of all others
- [ ] Every date has 8+ turns, two debriefs, a venue
- [ ] Score distribution is spread (std dev > 12) and not inflated (mean < 70)
- [ ] Adding a new person through `/add` completes end-to-end with no manual steps
- [ ] Private Instagram → clear rejection message; bad URL → clear validation message
- [ ] "Send on a date" works from a profile and streams live
- [ ] "Remove this person" deletes everything and re-ranks
- [ ] Apify or LLM failure on one person doesn't break the batch (retry + visible error state)

---

## 9. Milestones (build in this order, commit after each)

1. Scaffold Next.js + Supabase + env + schema migrations. Deploy a blank page to Vercel immediately.
2. Apify ingestion for one person, raw JSON in `/fixtures`, normalizers, Evidence Store, image caching.
3. Reader agent (vision + synthesis) with evidence validation. Profile page rendering real data.
4. Single live date between two people with streaming, inner thoughts, debriefs.
5. Pre-screen + batch dating via Inngest + rankings.
6. `/add` live pipeline view + "Send on a date" + Remove.
7. Seed all 25 from `seed/people.csv`, run everything, run `verify.ts`, fix calibration.
8. Home, How-it-works, polish, empty/error states, mobile.
9. README: setup, env vars, architecture diagram, cost per person and per date, design decisions, limitations.

---

## 10. Inputs I'm providing

- `seed/people.csv` → columns: `name, linkedin_url, instagram_url, consent_source`  <<fill with your 25+ opted-in people>>
- `APIFY_TOKEN=<<...>>`
- `ANTHROPIC_API_KEY=<<...>>`
- `NEXT_PUBLIC_SUPABASE_URL=<<...>>`, `SUPABASE_SERVICE_ROLE_KEY=<<...>>`
- `INNGEST_EVENT_KEY=<<...>>`, `INNGEST_SIGNING_KEY=<<...>>`

---

## 11. Don'ts

- Don't use any information source beyond the two links.
- Don't fake progress bars, dates, or scores. If something is loading, it's because it's actually running.
- Don't rate looks. Don't infer protected attributes.
- Don't let every date be lovely. Honest bad dates make the good ones believable.
- Don't over-scope. A flawless core loop beats extra features.

---

## Appendix: 3-minute video plan (the most heavily graded part)

| Time | Show |
|---|---|
| 0:00–0:15 | Hook: "25 real people. 25 AI agents. They went on 84 dates so their humans didn't have to." Home grid. |
| 0:15–0:50 | **Add a person live:** paste LinkedIn + Instagram → pipeline lights up → Reader log streams ("seeing trekking in 4 photos…"). |
| 0:50–1:25 | **Profile page:** walk through needs, hobbies, interests, dealbreakers. Click a claim → the actual post that proves it. Show "unknowns". |
| 1:25–2:20 | **A date, live:** hit "Send on a date". Venue gets picked. Turns stream in. Toggle inner thoughts on, show one agent quietly testing a dealbreaker. Debriefs side by side, one says yes, one says no. |
| 2:20–2:45 | **Rankings:** that person's top 5, mutual-match badges, reasons quoted from dates. |
| 2:45–3:00 | How-it-works diagram in one breath: two sources only, evidence-cited analysis, private agendas, independent debriefs, consent built in. |

Record at 1080p, cursor highlighted, no dead air (cut waiting time, but say "running live"). Voiceover, not music-only.