"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import type { DatePayload } from "@/lib/queries";
import type { Debrief } from "@/lib/date";

const LIVE = ["queued", "prep", "venue", "talking", "debrief"];
const STATUS_TEXT: Record<string, string> = {
  queued: "Both Proxies are privately preparing…",
  prep: "Both Proxies are privately preparing…",
  venue: "Picking a place…",
  talking: "On the date",
  debrief: "Writing private debriefs…",
};

export function DateView({ initial }: { initial: DatePayload }) {
  const [d, setD] = useState(initial);
  const [thoughts, setThoughts] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const live = LIVE.includes(d.date.status);
  const prevTurns = useRef(initial.turns.length);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/dates/${d.date.id}`, { cache: "no-store" });
        if (r.ok) setD(await r.json());
      } catch {}
    }, 1500);
    return () => clearInterval(t);
  }, [live, d.date.id]);

  // Drive the date one stage/turn per request while it's unfinished. The server lock makes
  // concurrent viewers safe, and a refresh resumes from the stored stage.
  const [driveError, setDriveError] = useState<string | null>(null);
  const [driveKey, setDriveKey] = useState(0);
  useEffect(() => {
    if (!live) return;
    let stop = false;
    (async () => {
      let failures = 0;
      setDriveError(null);
      while (!stop) {
        const r = await fetch(`/api/dates/${d.date.id}/step`, { method: "POST" }).catch(() => null);
        const j = r ? await r.json().catch(() => ({})) : { error: "Network error" };
        if (!r || !r.ok) {
          if (++failures >= 3) return setDriveError(j.error ?? "Step failed");
          await new Promise((res) => setTimeout(res, 3000 * failures));
          continue;
        }
        failures = 0;
        if (["done", "error", "missing"].includes(j.status)) return;
        if (!j.worked) await new Promise((res) => setTimeout(res, 2500));
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.date.id, driveKey]);

  useEffect(() => {
    if (live && d.turns.length > prevTurns.current) bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    prevTurns.current = d.turns.length;
  }, [d.turns.length, live]);

  const A = d.people[d.date.a_id] ?? { id: d.date.a_id, name: "Removed", avatar_url: null, headline: "" };
  const B = d.people[d.date.b_id] ?? { id: d.date.b_id, name: "Removed", avatar_url: null, headline: "" };
  const first = (n: string) => n.split(" ")[0];
  const goals = d.date.prep?.goals ?? {};
  const debA = d.debriefs.find((x) => x.person_id === A.id)?.report;
  const debB = d.debriefs.find((x) => x.person_id === B.id)?.report;

  return (
    <div className="mx-auto max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-center gap-4 sm:gap-8">
        <PersonHead p={A} />
        <span className="font-serif text-3xl italic text-accent">&</span>
        <PersonHead p={B} />
      </div>

      <div className="card mt-8 p-6 text-center">
        <p className="label">The date</p>
        <h1 className="mt-2 font-serif text-3xl sm:text-4xl">{d.date.venue ?? (live ? "Choosing a place…" : "—")}</h1>
        {d.date.scene && <p className="mx-auto mt-3 max-w-2xl italic text-muted">{d.date.scene}</p>}
        {live && (
          <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-accent/50 px-3 py-1 text-sm text-accent">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" /> Running live · {STATUS_TEXT[d.date.status]}
          </p>
        )}
        {d.date.status === "error" && <p className="mt-4 text-bad">This date failed: {d.date.error}</p>}
        {live && driveError && (
          <div className="mt-4 text-sm text-bad">
            <p className="break-words">Paused after 3 failed attempts: {driveError}</p>
            <button onClick={() => setDriveKey((k) => k + 1)} className="btn-ghost mt-2">Resume</button>
          </div>
        )}
      </div>

      {/* Toggle */}
      <div className="sticky top-[57px] z-20 -mx-4 mt-6 flex items-center justify-between border-b border-line bg-bg/90 px-4 py-3 backdrop-blur sm:mx-0 sm:px-0">
        <span className="text-sm text-muted">{d.turns.length} turns</span>
        <label className="flex cursor-pointer items-center gap-3 text-sm">
          <span className={thoughts ? "text-think" : "text-muted"}>Show what they&apos;re thinking</span>
          <button role="switch" aria-checked={thoughts} onClick={() => setThoughts(!thoughts)} className={`relative h-6 w-11 rounded-full transition ${thoughts ? "bg-think" : "bg-panel-2 border border-line"}`}>
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-ink transition ${thoughts ? "left-[22px]" : "left-0.5"}`} />
          </button>
        </label>
      </div>

      {/* Private prep */}
      {thoughts && Object.keys(goals).length > 0 && (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {[A, B].map((p) => (
            <div key={p.id} className="rise rounded-xl border border-think/30 bg-think/5 p-4 text-sm">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-think">{first(p.name)}&apos;s Proxy · private goals</p>
              <ul className="space-y-1 text-ink/85">
                {(goals[p.id] ?? []).map((g) => (
                  <li key={g}>· {g}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* Venue negotiation */}
      {d.date.prep?.negotiation && (
        <div className="mt-6 space-y-2 border-l-2 border-line pl-4 text-sm text-muted">
          <p className="label">Picking the place</p>
          {d.date.prep.negotiation.map((n, i) => (
            <p key={i}>
              <span className="text-ink">{first(d.people[n.speaker]?.name ?? "")}:</span> {n.say}
            </p>
          ))}
        </div>
      )}

      {/* Transcript */}
      <div className="mt-8 space-y-5">
        {d.turns.map((t) => {
          const isA = t.speaker_id === A.id;
          const who = isA ? A : B;
          return (
            <div key={t.idx} className={`rise flex gap-3 ${isA ? "" : "flex-row-reverse"}`}>
              <Avatar src={who.avatar_url} name={who.name} size={36} />
              <div className={`max-w-[85%] sm:max-w-[75%] ${isA ? "" : "items-end text-right"} flex flex-col`}>
                <span className="mb-1 text-xs text-muted">
                  {first(who.name)} · turn {t.idx + 1}
                </span>
                <div className={`rounded-2xl px-4 py-3 text-left leading-relaxed ${isA ? "rounded-tl-sm bg-panel-2" : "rounded-tr-sm bg-accent/15"}`}>{t.say}</div>
                {thoughts && (
                  <div className="rise mt-2 rounded-xl border border-think/30 bg-think/5 px-3 py-2 text-left text-sm italic text-think">💭 {t.inner_thought}</div>
                )}
                <Signals s={t.signals} />
              </div>
            </div>
          );
        })}
        {live && ["prep", "venue", "talking", "queued"].includes(d.date.status) && (
          <div className="typing flex gap-1 pl-12 text-accent">
            <span>●</span>
            <span>●</span>
            <span>●</span>
          </div>
        )}
        {d.date.ended_early_by && <p className="text-center text-sm text-bad">{first(d.people[d.date.ended_early_by]?.name ?? "One side")}&apos;s Proxy ended the date early.</p>}
        <div ref={bottom} />
      </div>

      {/* Debriefs + verdict */}
      {(debA || debB) && (
        <div className="mt-12">
          <p className="label text-center">Private debriefs, written independently</p>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {debA && <DebriefCard who={A.name} about={B.name} r={debA} />}
            {debB && <DebriefCard who={B.name} about={A.name} r={debB} />}
          </div>
        </div>
      )}
      {d.date.status === "done" && debA && debB && <Verdict a={A.name} b={B.name} ra={debA} rb={debB} mutual={d.date.mutual_score ?? 0} />}

      <div className="mt-10 flex justify-center gap-3">
        <Link href={`/p/${A.id}`} className="btn-ghost">{first(A.name)}&apos;s profile</Link>
        <Link href={`/p/${B.id}`} className="btn-ghost">{first(B.name)}&apos;s profile</Link>
      </div>
    </div>
  );
}

function PersonHead({ p }: { p: { id: string; name: string; avatar_url: string | null; headline: string } }) {
  return (
    <Link href={`/p/${p.id}`} className="flex max-w-[11rem] flex-col items-center text-center">
      <Avatar src={p.avatar_url} name={p.name} size={72} />
      <span className="mt-2 font-serif text-xl">{p.name}</span>
      <span className="line-clamp-2 text-xs text-muted">{p.headline}</span>
    </Link>
  );
}

function Signals({ s }: { s: { checked_need?: string; red_flag?: string; green_flag?: string } }) {
  if (!s || (!s.checked_need && !s.red_flag && !s.green_flag)) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
      {s.checked_need && <span className="rounded-full bg-sky-900/40 px-2 py-0.5 text-sky-200">checking: {s.checked_need}</span>}
      {s.green_flag && <span className="rounded-full bg-good/15 px-2 py-0.5 text-good">✓ {s.green_flag}</span>}
      {s.red_flag && <span className="rounded-full bg-bad/15 px-2 py-0.5 text-bad">⚑ {s.red_flag}</span>}
    </div>
  );
}

const DIMS: [keyof Debrief["dimensions"], string][] = [
  ["shared_interests", "Shared interests"],
  ["values_alignment", "Values"],
  ["lifestyle_fit", "Lifestyle"],
  ["conversation_chemistry", "Chemistry"],
  ["needs_met", "Needs met"],
];

function DebriefCard({ who, about, r }: { who: string; about: string; r: Debrief }) {
  return (
    <div className="card rise p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="label">To {who.split(" ")[0]}</p>
          <p className="text-sm text-muted">about {about.split(" ")[0]}</p>
        </div>
        <div className="text-right">
          <div className="font-serif text-4xl">{r.overall}</div>
          <div className={`text-sm font-semibold ${r.second_date ? "text-good" : "text-bad"}`}>{r.second_date ? "Second date: yes" : "Second date: no"}</div>
        </div>
      </div>
      <p className="mt-4 font-serif text-lg italic leading-snug">&ldquo;{r.note_to_my_human}&rdquo;</p>
      <div className="mt-4 space-y-1.5">
        {DIMS.map(([k, label]) => (
          <div key={k} className="flex items-center gap-3 text-xs">
            <span className="w-28 shrink-0 text-muted">{label}</span>
            <div className="h-1.5 flex-1 rounded-full bg-panel-2">
              <div className="h-1.5 rounded-full bg-accent" style={{ width: `${r.dimensions[k] * 10}%` }} />
            </div>
            <span className="w-5 text-right">{r.dimensions[k]}</span>
          </div>
        ))}
      </div>
      <div className="mt-4 space-y-1 text-sm">
        {r.green_flags.map((f, i) => (
          <p key={"g" + i} className="text-good">✓ {f.text} <span className="text-xs text-muted">(turn {f.transcript_turn})</span></p>
        ))}
        {r.red_flags.map((f, i) => (
          <p key={"r" + i} className="text-bad">⚑ {f.text} <span className="text-xs text-muted">(turn {f.transcript_turn})</span></p>
        ))}
      </div>
    </div>
  );
}

function Verdict({ a, b, ra, rb, mutual }: { a: string; b: string; ra: Debrief; rb: Debrief; mutual: number }) {
  const fa = a.split(" ")[0];
  const fb = b.split(" ")[0];
  const both = ra.second_date && rb.second_date;
  const gap = ra.overall - rb.overall;
  return (
    <div className="card mt-6 p-6 text-center">
      <p className="label">Verdict</p>
      <div className="mt-2 font-serif text-6xl">{mutual}</div>
      <p className="text-sm text-muted">mutual score · geometric mean of both sides, penalized for each &ldquo;no&rdquo;</p>
      <p className={`mt-3 text-lg ${both ? "text-good" : "text-ink"}`}>
        {both ? "♥ Mutual match: both want a second date." : ra.second_date || rb.second_date ? `${ra.second_date ? fa : fb} would go again; ${ra.second_date ? fb : fa} would not.` : "Neither side wants a second date."}
      </p>
      {Math.abs(gap) >= 12 && (
        <p className="mt-1 text-sm text-muted">
          Asymmetry: {gap > 0 ? fa : fb}&apos;s Proxy liked this date more ({Math.max(ra.overall, rb.overall)} vs {Math.min(ra.overall, rb.overall)}).
        </p>
      )}
    </div>
  );
}
