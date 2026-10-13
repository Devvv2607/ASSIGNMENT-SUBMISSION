import { Mermaid } from "@/components/Mermaid";

export const metadata = { title: "How it works — Proxy" };

const PIPELINE = `flowchart LR
  L[LinkedIn URL] --> A1[Apify<br/>linkedin-profile-scraper]
  I[Instagram URL] --> A2[Apify<br/>instagram-profile-scraper]
  A2 -->|private: true| X[Rejected]
  A1 --> E[(Evidence store<br/>li:exp:2, ig:post:7 …)]
  A2 --> E
  E --> V[Reader pass A<br/>vision on 6 photos]
  V --> E
  E --> R[Reader pass B<br/>synthesis, cited claims]
  R --> VAL{Validator<br/>drop uncited +<br/>forbidden claims}
  VAL --> P[(Profile)]
  P --> S[Pre-screen<br/>interest/value overlap]
  S --> D[Top 3 full dates]
  D --> RK[Rankings]`;

const DATE = `sequenceDiagram
  participant A as Proxy A
  participant B as Proxy B
  Note over A,B: 1. Prep: each sees only the other's public card,<br/>writes private goals
  A->>B: 2. Proposes a date idea
  B->>A: Proposes a date idea
  Note over A,B: Agree on one venue
  loop 8-12 turns
    A->>B: say (+ private inner_thought, signals)
    B->>A: say (+ private inner_thought, signals)
  end
  Note over A: 4. Private debrief to A's human
  Note over B: 4. Private debrief to B's human
  Note over A,B: 5. Verdict = √(scoreA·scoreB) × penalty per "no"`;

export default function HowItWorks() {
  return (
    <div className="mx-auto max-w-4xl space-y-14">
      <header>
        <p className="label">How it works</p>
        <h1 className="mt-2 font-serif text-5xl">Two links in. A Proxy that dates for you out.</h1>
        <p className="mt-4 text-lg text-muted">Everything you see on this site is produced by real model calls on real scraped data. Nothing is mocked, and every claim links back to its source.</p>
      </header>

      <Block title="The pipeline">
        <div className="card p-4 sm:p-6">
          <Mermaid chart={PIPELINE} />
        </div>
      </Block>

      <Block title="The information boundary">
        <ul>
          <li>Each person is exactly two links: LinkedIn and a <b>public</b> Instagram. Nothing else: no web search, no other platforms. The Instagram &ldquo;link in bio&rdquo; is deliberately ignored because it would be a third source.</li>
          <li>Apify actors scrape the profiles (<code>harvestapi/linkedin-profile-scraper</code>, <code>apify/instagram-profile-scraper</code>). Email and contact-finding modes are never used, and no contact details are stored or shown.</li>
          <li>Every scraped fact becomes an <b>evidence row</b> with an ID (<code>li:exp:2</code>, <code>ig:post:7</code>, <code>ig:img:7</code>). The Reader must cite those IDs; a validator deletes any claim whose citations don&apos;t exist.</li>
          <li>Before a date, a Proxy sees only the other person&apos;s <b>public card</b> (headline, three interests, a one-liner). Everything else is learned by talking.</li>
        </ul>
      </Block>

      <Block title="The Reader">
        <ul>
          <li><b>Pass A, perception:</b> one batched vision call on up to 6 Instagram photos returns activities, setting, hobby signals and social context, stored as new evidence. It never comments on looks.</li>
          <li><b>Pass B, synthesis:</b> Claude Sonnet reads the whole evidence store and returns a Zod-validated profile: hobbies, interests, values, lifestyle, career, communication style, needs, likely dealbreakers, conversation hooks, and honest unknowns. Each claim carries a confidence and its evidence IDs.</li>
          <li>Needs and dealbreakers are labelled as inferences, with reasoning.</li>
        </ul>
      </Block>

      <Block title="The date protocol">
        <div className="card mb-5 p-4 sm:p-6">
          <Mermaid chart={DATE} />
        </div>
        <ul>
          <li>Each Proxy&apos;s system prompt has its person&apos;s full profile plus a <b>private agenda</b>: needs to check and dealbreakers to test. It speaks in its person&apos;s voice but may not claim anything outside the profile.</li>
          <li>It is told: <i>&ldquo;You are not here to be liked. You are here to find out if this is a good fit.&rdquo;</i> Disagreement is allowed and either side can end the date after turn 8.</li>
          <li>Every turn returns <code>say</code>, a private <code>inner_thought</code> (toggle it on the date page), and signals (need checked, green flag, red flag).</li>
          <li>Turns use Claude Haiku for speed; prep, venue, and debriefs use Claude Sonnet.</li>
        </ul>
      </Block>

      <Block title="Scoring and matchmaking">
        <ul>
          <li><b>Debriefs are independent.</b> Each Proxy writes to its own human: overall 0–100, five dimensions, flags tied to transcript turns, a yes/no on a second date, and a note quoting the date. The prompt calibrates against grade inflation (typical first date: 35–65).</li>
          <li><b>Mutual score</b> = geometric mean of both sides × 0.8 if one says no (× 0.65 if both do). Both one-sided scores are kept, so asymmetry is visible.</li>
          <li><b>Cost-aware matchmaking:</b> 25 people means 300 pairs. All pairs get a free pre-screen prior (Jaccard overlap of hobby, interest and value terms). Each person gets full dates with their top 3 by prior. Anyone else shows &ldquo;Not dated yet — prior only&rdquo; with a <b>Send on a date</b> button that runs a full date live.</li>
          <li><b>Rankings</b> are each person&apos;s own Proxy&apos;s scores, computed from live data on every view, so new dates and removals re-rank everyone immediately.</li>
        </ul>
      </Block>

      <Block title="Consent and safety">
        <ul>
          <li>The seed pool is people who opted in; each record stores its <code>consent_source</code>. The add form requires confirming the person agreed.</li>
          <li>Private Instagram accounts are rejected with a clear message, and nothing scraped from them is kept.</li>
          <li><b>Remove this person</b> deletes their profile, evidence, cached images, and every date involving them.</li>
          <li>The analysis never infers sexual orientation, religion, caste, ethnicity, health, politics, income, or anything about looks. The prompt forbids it and a validator strips any claim that slips through.</li>
          <li><b>Orientation is never inferred.</b> Rankings default to &ldquo;everyone&rdquo;; a viewer-side filter (men/women) uses only gender that was self-reported at submission.</li>
        </ul>
      </Block>

      <Block title="Known limitations">
        <ul>
          <li>Two public profiles are a thin slice of a person. Profiles say so in &ldquo;unknowns&rdquo; and carry confidence levels.</li>
          <li>The pre-screen is lexical overlap, not embeddings, so it can miss &ldquo;bouldering&rdquo; ≈ &ldquo;climbing&rdquo;. It only decides who dates first; any pair can still be sent on a real date.</li>
          <li>Proxies role-play from a profile; they can&apos;t know things the person never posted.</li>
          <li>Live progress uses polling (1.5s) rather than websockets.</li>
        </ul>
      </Block>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-4 font-serif text-3xl">{title}</h2>
      <div className="space-y-3 text-ink/90 [&_code]:rounded [&_code]:bg-panel-2 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.85em] [&_li]:leading-relaxed [&_ul]:list-disc [&_ul]:space-y-2.5 [&_ul]:pl-5">{children}</div>
    </section>
  );
}
