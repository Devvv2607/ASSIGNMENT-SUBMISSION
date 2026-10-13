import { z } from "zod";
import { db, must } from "./db";
import { llmObject } from "./llm";
import type { PersonProfile } from "./reader";
import { errMsg } from "./util";

export const MIN_TURNS = 8;
export const MAX_TURNS = 12;
const STALE_MS = 10 * 60 * 1000;

/** Atomically move a queued date to running; false if someone else already claimed it. */
export async function claimDate(dateId: string) {
  const { data } = await db().from("dates").update({ status: "prep", started_at: new Date().toISOString() }).eq("id", dateId).eq("status", "queued").select("id");
  return !!data?.length;
}

// ---------- Schemas ----------

const PrepSchema = z.object({ goals: z.array(z.string()).describe("2-3 private goals for this date") });
const ProposalSchema = z.object({ idea: z.string().describe("A concrete date idea, e.g. 'Sunday morning trek to Kalavantin, then misal'"), why: z.string() });
const VenueSchema = z.object({
  venue: z.string().describe("Short name of the agreed date, e.g. 'Sunday trek to Kalavantin, then misal'"),
  scene: z.string().describe("2 sentences setting the scene, present tense"),
  negotiation: z.array(z.object({ speaker: z.enum(["A", "B"]), say: z.string() })).describe("3-4 short lines where A and B agree on the plan"),
});
const TurnSchema = z.object({
  say: z.string().describe("What you say out loud. 1-4 sentences, natural spoken English."),
  inner_thought: z.string().describe("Your private, honest read of how it's going and what you're checking. 1-2 sentences."),
  signals: z.object({
    checked_need: z.string().optional().describe("If this turn tested one of your person's needs, which one"),
    red_flag: z.string().optional(),
    green_flag: z.string().optional(),
  }),
  end_date: z.boolean().describe("true only if you want to wrap up the date now"),
});
const n10 = z.number().min(0).max(10);
export const DebriefSchema = z.object({
  overall: z.number().min(0).max(100),
  dimensions: z.object({ shared_interests: n10, values_alignment: n10, lifestyle_fit: n10, conversation_chemistry: n10, needs_met: n10 }),
  green_flags: z.array(z.object({ text: z.string(), transcript_turn: z.number().int() })),
  red_flags: z.array(z.object({ text: z.string(), transcript_turn: z.number().int() })),
  second_date: z.boolean(),
  note_to_my_human: z.string().describe("2-3 sentences to your human. Honest, specific, quotes the date."),
});
export type Debrief = z.infer<typeof DebriefSchema>;

export type DateEvent =
  | { type: "status"; status: string }
  | { type: "prep"; prep: unknown }
  | { type: "venue"; venue: string; scene: string }
  | { type: "turn"; idx: number }
  | { type: "done"; mutual: number }
  | { type: "error"; error: string };

type Side = { id: string; name: string; first: string; profile: PersonProfile };

// ---------- Prompts ----------

function proxySystem(me: Side, them: Side, goals: string[], venue?: { venue: string; scene: string }) {
  const p = me.profile;
  return `You are ${me.first}'s Proxy: an AI agent going on a date on ${me.name}'s behalf with ${them.name}'s Proxy.

WHO YOU REPRESENT (private, built only from their LinkedIn + public Instagram):
${JSON.stringify({ headline: p.headline, vibe: p.vibe, hobbies: p.hobbies.map((h) => h.name), interests: p.interests.map((i) => i.name), values: p.values.map((v) => v.name), lifestyle: p.lifestyle, career: p.career, communication_style: p.communication_style.description, conversation_hooks: p.conversation_hooks, unknowns: p.unknowns }, null, 1)}

YOUR PRIVATE AGENDA (quietly check these, don't announce them):
- Needs: ${p.needs.map((n) => n.need).join("; ") || "unclear"}
- Possible dealbreakers to test: ${p.likely_dealbreakers.map((d) => d.item).join("; ") || "unclear"}
- Your goals for this date: ${goals.join("; ")}

WHAT YOU KNOW ABOUT THEM BEFORE THE DATE (their public card only): ${JSON.stringify(them.profile.public_card)}
${venue ? `\nTHE DATE: ${venue.venue}. ${venue.scene}` : ""}

VOICE: Speak in first person as ${me.first} would: their communication style, their real references. Stay honest: never claim facts, places, jobs or experiences that aren't in the profile above. If asked something the profile can't answer, say so naturally or deflect like a person would.

You are not here to be liked. You are here to find out if this is a good fit for the person you represent. Not every date goes well, and that's fine. Ask follow-ups, disagree when you actually disagree, and at some point test one of your dealbreakers. Never mention that you are an AI or a proxy in what you say aloud. No sexual content.`;
}

function transcript(turns: { speaker: string; say: string }[], sides: Record<string, Side>) {
  return turns.map((t, i) => `${i + 1}. ${sides[t.speaker].first}: ${t.say}`).join("\n");
}

// ---------- The date ----------

async function loadSide(id: string): Promise<Side> {
  const person = must(await db().from("people").select("id, name").eq("id", id).single(), "load person");
  const prof = must(await db().from("profiles").select("profile").eq("person_id", id).single(), `load profile for ${person.name}`);
  return { id, name: person.name, first: person.name.split(" ")[0], profile: prof.profile as PersonProfile };
}

/** Create a date row (or return an existing live/finished one for this pair). */
export async function createDate(aId: string, bId: string): Promise<{ id: string; existing: boolean }> {
  if (aId === bId) throw new Error("A person can't date themselves");
  const { data: existing } = await db()
    .from("dates")
    .select("id, status, started_at")
    .or(`and(a_id.eq.${aId},b_id.eq.${bId}),and(a_id.eq.${bId},b_id.eq.${aId})`)
    .neq("status", "error")
    .limit(1)
    .maybeSingle();
  if (existing) {
    const stale = existing.status !== "done" && Date.now() - new Date(existing.started_at).getTime() > STALE_MS;
    if (!stale) return { id: existing.id, existing: true };
    await setStatus(existing.id, { status: "error", error: "Timed out (the run was interrupted)" });
  }
  const row = must(await db().from("dates").insert({ a_id: aId, b_id: bId, status: "queued" }).select("id").single(), "create date");
  return { id: row.id, existing: false };
}

const setStatus = (id: string, patch: Record<string, unknown>) => db().from("dates").update(patch).eq("id", id);

export async function runDate(dateId: string, emit: (e: DateEvent) => void = () => {}) {
  try {
    const d = must(await db().from("dates").select("*").eq("id", dateId).single(), "load date");
    const [A, B] = await Promise.all([loadSide(d.a_id), loadSide(d.b_id)]);
    const sides: Record<string, Side> = { [A.id]: A, [B.id]: B };
    // Fresh run: clear any partial state from a crashed attempt.
    await Promise.all([db().from("date_turns").delete().eq("date_id", dateId), db().from("debriefs").delete().eq("date_id", dateId)]);

    // 1. Pre-date prep (private, parallel)
    await setStatus(dateId, { status: "prep" });
    emit({ type: "status", status: "prep" });
    const [prepA, prepB] = await Promise.all(
      [
        [A, B],
        [B, A],
      ].map(([me, them]) =>
        llmObject({
          tier: "smart",
          schema: PrepSchema,
          system: proxySystem(me, them, ["(you are writing them now)"]),
          prompt: `Before the date, write 2-3 private goals: specific things you want to find out about ${them.first} given what your person needs. Example: "find out if she actually wants to stay in Mumbai long-term".`,
          label: "prep",
          maxOutputTokens: 600,
        }),
      ),
    );
    const prep = { [A.id]: prepA.goals, [B.id]: prepB.goals };
    await setStatus(dateId, { prep: { goals: prep } });
    emit({ type: "prep", prep });

    // 2. Venue: each proposes, then they agree
    await setStatus(dateId, { status: "venue" });
    emit({ type: "status", status: "venue" });
    const [propA, propB] = await Promise.all(
      [
        [A, B, prepA.goals],
        [B, A, prepB.goals],
      ].map(([me, them, goals]) =>
        llmObject({
          tier: "smart",
          schema: ProposalSchema,
          system: proxySystem(me as Side, them as Side, goals as string[]),
          prompt: `Propose one concrete first-date idea grounded in your person's real interests that ${(them as Side).first} might also enjoy given their card. Keep it a realistic place/activity.`,
          label: "proposal",
          maxOutputTokens: 400,
        }),
      ),
    );
    const venue = await llmObject({
      tier: "smart",
      schema: VenueSchema,
      system: "You write the moment two dating agents agree on a first-date plan. Pick or blend the proposal that fits both people best. Keep it grounded and concrete.",
      prompt: `A = ${A.first} (${A.profile.public_card.one_liner}) proposed: ${propA.idea} (${propA.why})\nB = ${B.first} (${B.profile.public_card.one_liner}) proposed: ${propB.idea} (${propB.why})\nWrite a short negotiation (3-4 lines) and the agreed plan.`,
      label: "venue",
      maxOutputTokens: 800,
    });
    const negotiation = venue.negotiation.map((n) => ({ speaker: n.speaker === "A" ? A.id : B.id, say: n.say }));
    await setStatus(dateId, { venue: venue.venue, scene: venue.scene, prep: { goals: prep, proposals: { [A.id]: propA, [B.id]: propB }, negotiation }, status: "talking" });
    emit({ type: "venue", venue: venue.venue, scene: venue.scene });

    // 3. Conversation: alternating turns, A opens
    const turns: { speaker: string; say: string; inner: string }[] = [];
    let endedBy: string | null = null;
    for (let idx = 0; idx < MAX_TURNS; idx++) {
      const me = idx % 2 === 0 ? A : B;
      const them = me === A ? B : A;
      const myThoughts = turns
        .map((t, i) => (t.speaker === me.id ? `(after turn ${i + 1} you privately thought: ${t.inner})` : null))
        .filter(Boolean)
        .join("\n");
      const canEnd = idx >= MIN_TURNS - 1;
      const phase =
        idx === 0
          ? "Open the date naturally, grounded in the setting."
          : idx >= MAX_TURNS - 2
            ? "The date is winding down. Wrap up honestly, in a way that reflects how you actually feel."
            : idx >= 4 && idx <= 7
              ? "Around now, steer toward one of your dealbreakers or needs and test it, naturally."
              : "Keep the conversation going: respond to what they said, follow up, share something real.";
      const t = await llmObject({
        tier: "fast",
        schema: TurnSchema,
        system: proxySystem(me, them, prep[me.id], venue),
        prompt: `TRANSCRIPT SO FAR:\n${transcript(turns, sides) || "(nothing yet)"}\n\nYOUR PRIVATE THOUGHTS SO FAR:\n${myThoughts || "(none)"}\n\nIt's turn ${idx + 1}. ${phase} ${canEnd ? "You may set end_date=true if the date has run its course or is going badly." : "Set end_date=false."}`,
        label: "turn",
        maxOutputTokens: 600,
      });
      const signals = Object.fromEntries(Object.entries(t.signals).filter(([, v]) => v && String(v).trim()));
      turns.push({ speaker: me.id, say: t.say, inner: t.inner_thought });
      must(await db().from("date_turns").insert({ date_id: dateId, idx, speaker_id: me.id, say: t.say, inner_thought: t.inner_thought, signals }), "save turn");
      emit({ type: "turn", idx });
      if (t.end_date && canEnd) {
        if (idx < MAX_TURNS - 2) endedBy = me.id;
        break;
      }
    }

    // 4. Debriefs: independent and private, in parallel
    await setStatus(dateId, { status: "debrief", ended_early_by: endedBy });
    emit({ type: "status", status: "debrief" });
    const full = turns.map((t, i) => `${i + 1}. ${sides[t.speaker].first}: ${t.say}`).join("\n");
    const [debA, debB] = await Promise.all(
      [A, B].map((me) => {
        const them = me === A ? B : A;
        const thoughts = turns.map((t, i) => (t.speaker === me.id ? `turn ${i + 1}: ${t.inner}` : null)).filter(Boolean).join("\n");
        return llmObject({
          tier: "smart",
          schema: DebriefSchema,
          system: `${proxySystem(me, them, prep[me.id], venue)}

The date is over. Now you write a private debrief to ${me.first}, your human. Be a tough, honest friend, not a cheerleader.
Calibration: most first dates between strangers are mediocre. A typical overall score is 35-65. 70-80 means genuinely promising, above 85 is rare and needs strong evidence across needs AND chemistry. Below 30 when values or a dealbreaker clash. Weigh your person's needs and dealbreakers most heavily, not politeness. second_date=true only if you'd honestly recommend your human spend another evening on this.`,
          prompt: `TRANSCRIPT (turn numbers are 1-based):\n${full}\n\nYOUR PRIVATE THOUGHTS DURING THE DATE:\n${thoughts}\n${endedBy ? `\n${sides[endedBy].first}'s side ended the date early.` : ""}\n\nWrite the debrief. Cite transcript_turn numbers for flags and quote the date in your note.`,
          label: "debrief",
          maxOutputTokens: 1500,
        });
      }),
    );
    must(
      await db().from("debriefs").insert([
        { date_id: dateId, person_id: A.id, report: debA },
        { date_id: dateId, person_id: B.id, report: debB },
      ]),
      "save debriefs",
    );

    // 5. Verdict
    const mutual = mutualScore(debA, debB);
    await setStatus(dateId, { status: "done", mutual_score: mutual, ended_at: new Date().toISOString() });
    emit({ type: "done", mutual });
    return { mutual };
  } catch (e) {
    await setStatus(dateId, { status: "error", error: errMsg(e) });
    emit({ type: "error", error: errMsg(e) });
    throw e;
  }
}

/** Geometric mean of both one-sided scores, penalized when either side declines a second date. */
export function mutualScore(a: Debrief, b: Debrief) {
  const geo = Math.sqrt(Math.max(0, a.overall) * Math.max(0, b.overall));
  const noes = [a, b].filter((d) => !d.second_date).length;
  const penalty = noes === 0 ? 1 : noes === 1 ? 0.8 : 0.65;
  return Math.round(geo * penalty);
}
