import { z } from "zod";
import { db, must } from "./db";
import { llmObject } from "./llm";
import type { PersonProfile } from "./reader";
import { errMsg } from "./util";

export const MIN_TURNS = 8;
export const MAX_TURNS = 12;
const LOCK_MS = 150_000;

// ---------- Schemas ----------

const PrepSchema = z.object({ goals: z.array(z.string()).describe("2-3 private goals for this date") });
const ProposalSchema = z.object({ idea: z.string().describe("a concrete first-date plan, e.g. 'Sunday morning trek to Kalavantin, then misal'"), why: z.string() });
const VenueSchema = z.object({
  venue: z.string().describe("short name of the agreed plan"),
  scene: z.string().describe("2 sentences setting the scene, present tense"),
  negotiation: z.array(z.object({ speaker: z.enum(["A", "B"]), say: z.string() })).describe("3-4 short lines where A and B agree"),
});
const TurnSchema = z.object({
  say: z.string().describe("what you say out loud, 1-4 natural sentences"),
  inner_thought: z.string().describe("your private, honest read of how it's going and what you're checking, 1-2 sentences"),
  signals: z.object({
    checked_need: z.string().optional().describe("if this turn tested one of your person's needs, which"),
    red_flag: z.string().optional(),
    green_flag: z.string().optional(),
  }),
  end_date: z.boolean().describe("true only if you want to wrap up now"),
});
const n10 = z.number().min(0).max(10);
export const DebriefSchema = z.object({
  overall: z.number().min(0).max(100),
  dimensions: z.object({ shared_interests: n10, values_alignment: n10, lifestyle_fit: n10, conversation_chemistry: n10, needs_met: n10 }),
  green_flags: z.array(z.object({ text: z.string(), transcript_turn: z.number().int().describe("1-based turn number") })),
  red_flags: z.array(z.object({ text: z.string(), transcript_turn: z.number().int().describe("1-based turn number") })),
  second_date: z.boolean(),
  note_to_my_human: z.string().describe("2-3 sentences to your human: honest, specific, quotes the date"),
});
export type Debrief = z.infer<typeof DebriefSchema>;

type Side = { id: string; name: string; first: string; profile: PersonProfile };
type DateRow = {
  id: string;
  a_id: string;
  b_id: string;
  status: string;
  venue: string | null;
  scene: string | null;
  prep: { goals?: Record<string, string[]>; proposals?: Record<string, { idea: string; why: string }>; negotiation?: { speaker: string; say: string }[] } | null;
  ended_early_by: string | null;
};

// ---------- Prompts (kept compact: the provider has a tight per-minute token budget) ----------

function proxySystem(me: Side, them: Side, goals: string[], venue?: { venue: string | null; scene: string | null }) {
  const p = me.profile;
  const facts = {
    headline: p.headline,
    vibe: p.vibe,
    hobbies: p.hobbies.map((h) => h.name),
    interests: p.interests.map((i) => i.name),
    values: p.values.map((v) => v.name),
    lifestyle: [p.lifestyle.rhythm, p.lifestyle.social_energy, p.lifestyle.travel, p.lifestyle.fitness].join(" | "),
    career: `${p.career.current}; ${p.career.trajectory}`,
    talks_like: p.communication_style.description,
    hooks: p.conversation_hooks,
    unknown: p.unknowns,
  };
  return `You are ${me.first}'s Proxy: an AI agent on a first date on ${me.name}'s behalf with ${them.name}'s Proxy.
WHO YOU REPRESENT (from their LinkedIn + public Instagram only): ${JSON.stringify(facts)}
PRIVATE AGENDA (check quietly, never announce): needs: ${p.needs.map((n) => n.need).join("; ") || "unclear"}. Possible dealbreakers to test: ${p.likely_dealbreakers.map((d) => d.item).join("; ") || "unclear"}. Your goals: ${goals.join("; ")}.
ALL YOU KNEW ABOUT THEM BEFOREHAND (their public card): ${JSON.stringify(them.profile.public_card)}${venue?.venue ? `\nTHE DATE: ${venue.venue}. ${venue.scene ?? ""}` : ""}
VOICE: first person, as ${me.first} talks. Use their real references. Never claim facts, places, jobs or experiences not listed above; if asked, deflect like a person would.
You are not here to be liked. You are here to find out if this is a good fit for the person you represent. Not every date goes well, and that's fine. Follow up, disagree when you disagree, and at some point test a dealbreaker. Never say you are an AI or a proxy. No sexual content.`;
}

async function loadSide(id: string): Promise<Side> {
  const person = must(await db().from("people").select("id, name").eq("id", id).single(), "load person");
  const prof = must(await db().from("profiles").select("profile").eq("person_id", id).single(), `load profile for ${person.name}`);
  return { id, name: person.name, first: person.name.split(" ")[0], profile: prof.profile as PersonProfile };
}

// ---------- Creation + locking ----------

/** Create a queued date for a pair, or return the existing non-failed one. */
export async function createDate(aId: string, bId: string): Promise<{ id: string; existing: boolean }> {
  if (aId === bId) throw new Error("A person can't date themselves");
  const { data: existing } = await db()
    .from("dates")
    .select("id")
    .or(`and(a_id.eq.${aId},b_id.eq.${bId}),and(a_id.eq.${bId},b_id.eq.${aId})`)
    .neq("status", "error")
    .limit(1)
    .maybeSingle();
  if (existing) return { id: existing.id, existing: true };
  const row = must(await db().from("dates").insert({ a_id: aId, b_id: bId, status: "queued" }).select("id").single(), "create date");
  return { id: row.id, existing: false };
}

async function claim(dateId: string): Promise<DateRow | null> {
  const now = new Date();
  const { data } = await db()
    .from("dates")
    .update({ lock_until: new Date(now.getTime() + LOCK_MS).toISOString() })
    .eq("id", dateId)
    .not("status", "in", "(done,error)")
    .or(`lock_until.is.null,lock_until.lt.${now.toISOString()}`)
    .select("id, a_id, b_id, status, venue, scene, prep, ended_early_by");
  return (data?.[0] as DateRow) ?? null;
}

const update = (id: string, patch: Record<string, unknown>) => db().from("dates").update(patch).eq("id", id);

// ---------- One step ----------

/**
 * Advance a date by one bounded unit of work: prep → venue → one conversation turn (repeated) → debriefs + verdict.
 * Idempotent and lock-guarded, so any client (the /add page, the date page, the seed script) can drive it, and a
 * refresh resumes where it left off. Returns the status after the step and whether this call did any work.
 */
export async function stepDate(dateId: string): Promise<{ status: string; worked: boolean }> {
  const d = await claim(dateId);
  if (!d) {
    const { data } = await db().from("dates").select("status").eq("id", dateId).maybeSingle();
    return { status: data?.status ?? "missing", worked: false };
  }
  try {
    const [A, B] = await Promise.all([loadSide(d.a_id), loadSide(d.b_id)]);
    const tag = (step: string) => ({ date_id: dateId, step });
    let next = d.status;

    if (d.status === "queued" || d.status === "prep") {
      const [ga, gb] = await Promise.all(
        [
          [A, B],
          [B, A],
        ].map(([me, them]) =>
          llmObject({
            tier: "smart",
            schema: PrepSchema,
            system: proxySystem(me, them, ["(writing them now)"]),
            user: `Before the date, write 2-3 private goals: specific things to find out about ${them.first} given what your person needs. Example: "find out if she actually wants to stay in Mumbai long-term".`,
            maxOutputTokens: 700,
            tag: tag("prep"),
          }),
        ),
      );
      next = "venue";
      must(await update(dateId, { prep: { goals: { [A.id]: ga.goals, [B.id]: gb.goals } }, status: next, error: null }), "save prep");
    } else if (d.status === "venue") {
      const goals = d.prep?.goals ?? {};
      const [pa, pb] = await Promise.all(
        [
          [A, B],
          [B, A],
        ].map(([me, them]) =>
          llmObject({
            tier: "smart",
            schema: ProposalSchema,
            system: proxySystem(me, them, goals[me.id] ?? []),
            user: `Propose one concrete, realistic first-date plan grounded in your person's real interests that ${them.first} might also enjoy given their card.`,
            maxOutputTokens: 500,
            tag: tag("venue"),
          }),
        ),
      );
      const v = await llmObject({
        tier: "smart",
        schema: VenueSchema,
        system: "You write the moment two dating agents agree on a first-date plan. Pick or blend the proposal that fits both best. Grounded and concrete.",
        user: `A = ${A.first} (${A.profile.public_card.one_liner}) proposed: ${pa.idea} (${pa.why})\nB = ${B.first} (${B.profile.public_card.one_liner}) proposed: ${pb.idea} (${pb.why})\nWrite a 3-4 line negotiation and the agreed plan.`,
        maxOutputTokens: 700,
        tag: tag("venue"),
      });
      const negotiation = v.negotiation.map((n) => ({ speaker: n.speaker === "A" ? A.id : B.id, say: n.say }));
      next = "talking";
      must(await update(dateId, { venue: v.venue, scene: v.scene, prep: { ...d.prep, proposals: { [A.id]: pa, [B.id]: pb }, negotiation }, status: next, error: null }), "save venue");
    } else if (d.status === "talking") {
      next = await takeTurn(d, A, B, tag("turn"));
    } else if (d.status === "debrief") {
      await debrief(d, A, B, tag("debrief"));
      next = "done";
    }
    await update(dateId, { lock_until: null });
    return { status: next, worked: true };
  } catch (e) {
    // Keep the stage so the next step call retries it; surface the error to viewers.
    await update(dateId, { lock_until: null, error: errMsg(e) });
    throw e;
  }
}

async function takeTurn(d: DateRow, A: Side, B: Side, tag: { date_id: string; step: string }) {
  const sides: Record<string, Side> = { [A.id]: A, [B.id]: B };
  const turns = (must(await db().from("date_turns").select("idx, speaker_id, say, inner_thought").eq("date_id", d.id).order("idx"), "load turns") as {
    idx: number;
    speaker_id: string;
    say: string;
    inner_thought: string;
  }[]);
  const idx = turns.length;
  const me = idx % 2 === 0 ? A : B; // strict alternation, A opens
  const them = me === A ? B : A;
  const canEnd = idx >= MIN_TURNS - 1;
  const phase =
    idx === 0
      ? "Open the date naturally, grounded in the setting."
      : idx >= MAX_TURNS - 2
        ? "The date is winding down. Wrap up honestly, reflecting how you actually feel."
        : idx >= 4 && idx <= 7
          ? "Around now, steer toward one of your dealbreakers or needs and test it, naturally."
          : "Respond to what they said, follow up, share something real.";
  const transcript = turns.map((t, i) => `${i + 1}. ${sides[t.speaker_id].first}: ${t.say}`).join("\n") || "(nothing yet)";
  const mine = turns.filter((t) => t.speaker_id === me.id).map((t) => `after turn ${t.idx + 1}: ${t.inner_thought}`).join("\n") || "(none)";
  const t = await llmObject({
    tier: "fast",
    schema: TurnSchema,
    system: proxySystem(me, them, d.prep?.goals?.[me.id] ?? [], d),
    user: `TRANSCRIPT:\n${transcript}\n\nYOUR PRIVATE THOUGHTS SO FAR:\n${mine}\n\nTurn ${idx + 1}. ${phase} ${canEnd ? "You may set end_date=true if the date has run its course or is going badly." : "Set end_date=false."}`,
    maxOutputTokens: 900,
    tag,
  });
  const signals = Object.fromEntries(Object.entries(t.signals).filter(([, v]) => v && String(v).trim()));
  // Primary key (date_id, idx) makes a duplicate turn from a racing request fail instead of double-writing.
  must(await db().from("date_turns").insert({ date_id: d.id, idx, speaker_id: me.id, say: t.say, inner_thought: t.inner_thought, signals }), "save turn");
  const last = idx + 1 >= MAX_TURNS || (t.end_date && canEnd);
  if (!last) return "talking";
  const endedEarly = idx + 1 < MAX_TURNS - 1 ? me.id : null;
  must(await update(d.id, { status: "debrief", ended_early_by: endedEarly, error: null }), "advance to debrief");
  return "debrief";
}

async function debrief(d: DateRow, A: Side, B: Side, tag: { date_id: string; step: string }) {
  const sides: Record<string, Side> = { [A.id]: A, [B.id]: B };
  const turns = must(await db().from("date_turns").select("idx, speaker_id, say, inner_thought").eq("date_id", d.id).order("idx"), "load turns") as {
    idx: number;
    speaker_id: string;
    say: string;
    inner_thought: string;
  }[];
  const full = turns.map((t, i) => `${i + 1}. ${sides[t.speaker_id].first}: ${t.say}`).join("\n");
  const existing = must(await db().from("debriefs").select("person_id, report").eq("date_id", d.id), "load debriefs") as { person_id: string; report: Debrief }[];
  const reports: Record<string, Debrief> = Object.fromEntries(existing.map((x) => [x.person_id, x.report]));

  // Sequential on purpose: each debrief is large and the provider's per-minute token budget is small.
  for (const me of [A, B]) {
    if (reports[me.id]) continue;
    const them = me === A ? B : A;
    const thoughts = turns.filter((t) => t.speaker_id === me.id).map((t) => `turn ${t.idx + 1}: ${t.inner_thought}`).join("\n");
    const r = await llmObject({
      tier: "smart",
      schema: DebriefSchema,
      system: `${proxySystem(me, them, d.prep?.goals?.[me.id] ?? [], d)}
The date is over. Write a private debrief to ${me.first}, your human. Be a tough, honest friend, not a cheerleader.
Calibration: most first dates between strangers are mediocre: a typical overall is 35-65. 70-80 = genuinely promising; above 85 is rare and needs strong evidence on needs AND chemistry; below 30 when values or a dealbreaker clash. Weigh your person's needs and dealbreakers over politeness. second_date=true only if you'd honestly recommend another evening.`,
      user: `TRANSCRIPT (turns 1-${turns.length}):\n${full}\n\nYOUR PRIVATE THOUGHTS:\n${thoughts}${d.ended_early_by ? `\n\n${sides[d.ended_early_by].first}'s side ended the date early.` : ""}\n\nWrite the debrief. transcript_turn must be a turn number from 1 to ${turns.length}. Quote the date in your note.`,
      maxOutputTokens: 1800,
      tag,
    });
    reports[me.id] = cleanFlags(r, turns.length);
    must(await db().from("debriefs").upsert({ date_id: d.id, person_id: me.id, report: reports[me.id] }), "save debrief");
  }
  const mutual = mutualScore(reports[A.id], reports[B.id]);
  must(await update(d.id, { status: "done", mutual_score: mutual, ended_at: new Date().toISOString(), error: null }), "save verdict");
}

/** Drop flags that point at turns that don't exist. */
export function cleanFlags(r: Debrief, nTurns: number): Debrief {
  const ok = (f: { transcript_turn: number }) => Number.isInteger(f.transcript_turn) && f.transcript_turn >= 1 && f.transcript_turn <= nTurns;
  return { ...r, green_flags: r.green_flags.filter(ok), red_flags: r.red_flags.filter(ok) };
}

/** Geometric mean of both one-sided scores, penalized when either side declines a second date. */
export function mutualScore(a: Debrief, b: Debrief) {
  const geo = Math.sqrt(Math.max(0, a.overall) * Math.max(0, b.overall));
  const noes = [a, b].filter((d) => !d.second_date).length;
  return Math.round(geo * (noes === 0 ? 1 : noes === 1 ? 0.8 : 0.65));
}

/** Drive a date to completion in-process (seed script). Retries a failing step a few times before giving up. */
export async function runDateToEnd(dateId: string, onStep?: (status: string) => void) {
  let failures = 0;
  for (let i = 0; i < 40; i++) {
    try {
      const { status, worked } = await stepDate(dateId);
      onStep?.(status);
      if (status === "done" || status === "error" || status === "missing") return status;
      if (!worked) await new Promise((r) => setTimeout(r, 3000));
      failures = 0;
    } catch (e) {
      if (++failures >= 3) {
        await update(dateId, { status: "error", error: errMsg(e) });
        throw e;
      }
      await new Promise((r) => setTimeout(r, 5000 * failures));
    }
  }
  return "incomplete";
}
