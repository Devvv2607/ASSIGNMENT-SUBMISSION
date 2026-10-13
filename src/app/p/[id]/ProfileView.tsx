"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Avatar } from "@/components/Avatar";
import type { Person, EvidenceRow } from "@/lib/db";
import type { PersonProfile } from "@/lib/reader";
import type { Debrief } from "@/lib/date";
import type { RankingRow } from "@/lib/rankings";

type Ev = Pick<EvidenceRow, "id" | "source" | "kind" | "text" | "image_url" | "meta">;
type DateItem = { id: string; status: string; venue: string | null; mutual_score: number | null; other: { id: string; name: string; avatar_url: string | null }; mine: Debrief | null; theirs: Debrief | null };
type Selected = { title: string; why?: string; ids: string[] } | null;

export function ProfileView(props: { person: Person; profile: PersonProfile; model: string | null; evidence: Ev[]; dates: DateItem[]; rankings: RankingRow[]; initialTab: "analysis" | "dates" | "rankings" }) {
  const { person, profile: p, evidence, dates, rankings } = props;
  const [tab, setTab] = useState(props.initialTab);
  const [sel, setSel] = useState<Selected>(null);
  const evMap = useMemo(() => new Map(evidence.map((e) => [e.id, e])), [evidence]);
  const doneDates = dates.filter((d) => d.status === "done").length;

  const open = (title: string, ids: string[], why?: string) => setSel({ title, ids, why });

  return (
    <div>
      {/* Header */}
      <section className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <Avatar src={person.avatar_url} name={person.name} size={104} />
        <div className="min-w-0 flex-1">
          <h1 className="font-serif text-4xl sm:text-5xl">{person.name}</h1>
          <p className="mt-2 font-serif text-xl italic text-accent">{p.headline}</p>
          <p className="mt-4 max-w-3xl leading-relaxed text-ink/90">{p.vibe}</p>
          <div className="mt-5 flex flex-wrap items-center gap-3 text-sm">
            <a href={person.linkedin_url} target="_blank" rel="noreferrer" className="btn-ghost">LinkedIn ↗</a>
            <a href={person.instagram_url} target="_blank" rel="noreferrer" className="btn-ghost">Instagram ↗</a>
            <RemoveButton id={person.id} />
          </div>
          <p className="mt-3 text-xs text-muted">Consent: {person.consent_source} · Sources: LinkedIn + Instagram only · {evidence.length} evidence items</p>
        </div>
      </section>

      {/* Tabs */}
      <div className="sticky top-[57px] z-20 -mx-4 mt-10 border-b border-line bg-bg/90 px-4 backdrop-blur sm:mx-0 sm:px-0">
        <div className="flex gap-6">
          {(
            [
              ["analysis", "Analysis"],
              ["dates", `Dates (${doneDates})`],
              ["rankings", "Rankings"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={`-mb-px border-b-2 py-3 text-sm font-semibold transition ${tab === k ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-8">
        {tab === "analysis" && <Analysis p={p} open={open} />}
        {tab === "dates" && <Dates dates={dates} />}
        {tab === "rankings" && <Rankings rows={rankings} personId={person.id} />}
      </div>

      {sel && <EvidencePanel sel={sel} evMap={evMap} onClose={() => setSel(null)} />}
    </div>
  );
}

// ---------- Analysis ----------

function Analysis({ p, open }: { p: PersonProfile; open: (t: string, ids: string[], why?: string) => void }) {
  return (
    <div className="space-y-10">
      <p className="text-sm text-muted">Every claim is cited. Click any chip or card to see the exact post or LinkedIn line behind it.</p>
      <Section title="Hobbies">
        <Chips items={p.hobbies.map((h) => ({ label: h.name, ids: h.evidence, conf: h.confidence }))} open={open} />
      </Section>
      <Section title="Interests">
        <Chips items={p.interests.map((h) => ({ label: h.name, ids: h.evidence, conf: h.confidence }))} open={open} />
      </Section>
      <Section title="Values">
        <div className="grid gap-3 sm:grid-cols-2">
          {p.values.map((v) => (
            <ClaimCard key={v.name} title={v.name} body={v.why} ids={v.evidence} conf={v.confidence} open={open} />
          ))}
        </div>
      </Section>
      <div className="grid gap-4 md:grid-cols-3">
        <InfoCard title="Lifestyle" ids={p.lifestyle.evidence} open={open} rows={[["Rhythm", p.lifestyle.rhythm], ["Social energy", p.lifestyle.social_energy], ["Travel", p.lifestyle.travel], ["Fitness", p.lifestyle.fitness]]} />
        <InfoCard title="Career" ids={p.career.evidence} open={open} rows={[["Now", p.career.current], ["Trajectory", p.career.trajectory], ["Ambition", p.career.ambition_level]]} />
        <InfoCard title="Communication style" ids={p.communication_style.evidence} open={open} rows={[["", p.communication_style.description]]} />
      </div>
      <Section title="What they'd likely need in a partner" note="Inferences, with reasoning">
        <div className="grid gap-3 sm:grid-cols-2">
          {p.needs.map((n) => (
            <ClaimCard key={n.need} title={n.need} body={n.why} ids={n.evidence} conf={n.confidence} open={open} />
          ))}
        </div>
      </Section>
      <Section title="Likely dealbreakers" note="Inferences, with reasoning">
        <div className="grid gap-3 sm:grid-cols-2">
          {p.likely_dealbreakers.map((n) => (
            <ClaimCard key={n.item} title={n.item} body={n.why} ids={n.evidence} conf={n.confidence} open={open} tone="bad" />
          ))}
        </div>
      </Section>
      <div className="grid gap-4 md:grid-cols-2">
        <ListCard title="What would make them light up" items={p.green_flags_for_them} />
        <ListCard title="Ask them about" items={p.conversation_hooks} />
      </div>
      <div className="card border-dashed p-5">
        <p className="label mb-3">Unknowns — what two sources couldn&apos;t tell us</p>
        <ul className="list-disc space-y-1.5 pl-5 text-muted">
          {p.unknowns.map((u) => (
            <li key={u}>{u}</li>
          ))}
        </ul>
      </div>
      <div className="card p-5">
        <p className="label mb-2">Public card (the only thing other Proxies see before a date)</p>
        <p className="font-serif text-lg">{p.public_card.headline}</p>
        <p className="mt-1 text-muted">{p.public_card.one_liner}</p>
      </div>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="font-serif text-2xl">{title}</h2>
        {note && <span className="text-xs text-muted">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function ConfDot({ c }: { c: number }) {
  return <span title={`confidence ${Math.round(c * 100)}%`} className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: c >= 0.7 ? "var(--good)" : c >= 0.4 ? "var(--accent)" : "var(--muted)" }} />;
}

function Chips({ items, open }: { items: { label: string; ids: string[]; conf: number }[]; open: (t: string, ids: string[]) => void }) {
  if (!items.length) return <p className="text-muted">Not enough evidence.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((i) => (
        <button key={i.label} onClick={() => open(i.label, i.ids)} className="chip">
          <ConfDot c={i.conf} /> {i.label} <span className="text-xs text-muted">· {i.ids.length}</span>
        </button>
      ))}
    </div>
  );
}

function ClaimCard({ title, body, ids, conf, open, tone }: { title: string; body: string; ids: string[]; conf: number; open: (t: string, ids: string[], why?: string) => void; tone?: "bad" }) {
  return (
    <button onClick={() => open(title, ids, body)} className={`card p-4 text-left transition hover:border-accent/60 ${tone === "bad" ? "border-bad/30" : ""}`}>
      <div className="flex items-center gap-2 font-semibold">
        <ConfDot c={conf} /> {title}
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">{body}</p>
      <p className="mt-2 text-xs text-accent">{ids.length} source{ids.length === 1 ? "" : "s"} →</p>
    </button>
  );
}

function InfoCard({ title, rows, ids, open }: { title: string; rows: [string, string][]; ids: string[]; open: (t: string, ids: string[]) => void }) {
  return (
    <button onClick={() => ids.length && open(title, ids)} className="card p-5 text-left transition hover:border-accent/60">
      <p className="label mb-3">{title}</p>
      <dl className="space-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k + v}>
            {k && <dt className="text-muted">{k}</dt>}
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {ids.length > 0 && <p className="mt-3 text-xs text-accent">{ids.length} sources →</p>}
    </button>
  );
}

function ListCard({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="card p-5">
      <p className="label mb-3">{title}</p>
      <ul className="space-y-1.5 text-sm">
        {items.map((i) => (
          <li key={i}>· {i}</li>
        ))}
      </ul>
    </div>
  );
}

function EvidencePanel({ sel, evMap, onClose }: { sel: NonNullable<Selected>; evMap: Map<string, Ev>; onClose: () => void }) {
  const items = sel.ids.map((id) => evMap.get(id)).filter(Boolean) as Ev[];
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <aside className="rise h-full w-full max-w-md overflow-y-auto border-l border-line bg-panel p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="label">Evidence for</p>
            <h3 className="mt-1 font-serif text-2xl">{sel.title}</h3>
          </div>
          <button onClick={onClose} className="btn-ghost !px-3 !py-1">✕</button>
        </div>
        {sel.why && <p className="mt-3 text-sm italic text-muted">{sel.why}</p>}
        <div className="mt-6 space-y-4">
          {items.map((e) => (
            <div key={e.id} className="rounded-xl border border-line bg-panel-2 p-4">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className={`rounded-full px-2 py-0.5 font-mono ${e.source === "linkedin" ? "bg-sky-900/50 text-sky-200" : "bg-pink-900/40 text-pink-200"}`}>{e.id}</span>
                {typeof e.meta?.url === "string" && (
                  <a href={e.meta.url} target="_blank" rel="noreferrer" className="text-accent">open post ↗</a>
                )}
              </div>
              {e.image_url && <img src={e.image_url} alt="" referrerPolicy="no-referrer" className="mb-3 max-h-80 w-full rounded-lg object-cover" />}
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{e.text}</p>
            </div>
          ))}
          {!items.length && <p className="text-muted">No evidence rows found.</p>}
        </div>
      </aside>
    </div>
  );
}

// ---------- Dates ----------

function Dates({ dates }: { dates: DateItem[] }) {
  if (!dates.length) return <p className="text-muted">No dates yet. Open the Rankings tab and send their Proxy on one.</p>;
  return (
    <div className="space-y-3">
      {dates.map((d) => (
        <Link key={d.id} href={`/date/${d.id}`} className="card flex flex-col gap-3 p-4 transition hover:border-accent/60 sm:flex-row sm:items-center">
          <Avatar src={d.other.avatar_url} name={d.other.name} size={44} />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{d.other.name}</div>
            <div className="text-sm text-muted">{d.venue ?? "Picking a venue…"}</div>
            {d.mine && <p className="mt-1 text-sm italic text-ink/80">&ldquo;{d.mine.note_to_my_human}&rdquo;</p>}
          </div>
          <div className="shrink-0 text-right text-sm">
            {d.status === "done" && d.mine && d.theirs ? (
              <>
                <div className="font-serif text-2xl">{d.mutual_score}</div>
                <div className="text-xs text-muted">
                  mine {d.mine.overall} · theirs {d.theirs.overall}
                </div>
                <div className="text-xs">{d.mine.second_date && d.theirs.second_date ? <span className="text-good">mutual yes</span> : <span className="text-muted">{d.mine.second_date ? "they passed" : d.theirs.second_date ? "we passed" : "both passed"}</span>}</div>
              </>
            ) : d.status === "error" ? (
              <span className="text-bad">failed</span>
            ) : (
              <span className="text-accent">live: {d.status}…</span>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}

// ---------- Rankings ----------

function Rankings({ rows, personId }: { rows: RankingRow[]; personId: string }) {
  const [filter, setFilter] = useState<"everyone" | "man" | "woman">("everyone");
  const shown = rows.filter((r) => filter === "everyone" || r.candidate.gender === filter);
  let rank = 0;
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Ordered by this person&apos;s Proxy&apos;s own score after a real date. Undated people follow, ordered by the cheap pre-screen.</p>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted">Show:</span>
          {(["everyone", "man", "woman"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`rounded-full border px-3 py-1 ${filter === f ? "border-accent text-accent" : "border-line text-muted"}`}>
              {f === "everyone" ? "Everyone" : f === "man" ? "Men" : "Women"}
            </button>
          ))}
        </div>
      </div>
      {filter !== "everyone" && <p className="mb-4 text-xs text-muted">Filter uses self-reported gender only; people who didn&apos;t provide it are hidden under this filter. Nothing is inferred.</p>}
      <ol className="space-y-3">
        {shown.map((r) => {
          if (r.source === "date") rank++;
          return (
            <li key={r.candidate.id} className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <div className="w-8 shrink-0 font-serif text-2xl text-muted">{r.source === "date" ? rank : "–"}</div>
              <Link href={`/p/${r.candidate.id}`}>
                <Avatar src={r.candidate.avatar_url} name={r.candidate.name} size={48} />
              </Link>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/p/${r.candidate.id}`} className="font-semibold hover:text-accent">{r.candidate.name}</Link>
                  {r.mutual_match && <span className="rounded-full bg-good/20 px-2 py-0.5 text-xs text-good">♥ mutual match</span>}
                  {r.source === "prior" && <span className="rounded-full bg-panel-2 px-2 py-0.5 text-xs text-muted">Not dated yet — prior only</span>}
                </div>
                <p className="text-sm text-muted">{r.headline}</p>
                <p className={`mt-1 text-sm ${r.source === "date" ? "italic text-ink/85" : "text-muted"}`}>{r.source === "date" ? `“${r.reason}”` : r.reason}</p>
              </div>
              <div className="flex shrink-0 items-center gap-4 sm:flex-col sm:items-end sm:gap-1">
                {r.source === "date" ? (
                  <>
                    <div className="font-serif text-3xl">{r.own_score}</div>
                    <div className="text-xs text-muted">
                      their side {r.their_score} · mutual {r.mutual_score}
                    </div>
                    <Link href={`/date/${r.date_id}`} className="text-xs text-accent">read the date →</Link>
                  </>
                ) : (
                  <>
                    <div className="text-xs text-muted">prior {r.prior_score}</div>
                    {r.date_id && r.date_status !== "done" ? (
                      <Link href={`/date/${r.date_id}`} className="btn-ghost !py-1.5 text-xs">Date in progress →</Link>
                    ) : (
                      <SendOnDate a={personId} b={r.candidate.id} />
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {!shown.length && <p className="text-muted">No one to show yet.</p>}
    </div>
  );
}

function SendOnDate({ a, b }: { a: string; b: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end">
      <button
        className="btn !px-4 !py-1.5 text-xs"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const r = await fetch("/api/dates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aId: a, bId: b }) });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error);
            router.push(`/date/${j.id}`);
          } catch (e) {
            setErr((e as Error).message);
            setBusy(false);
          }
        }}
      >
        {busy ? "Starting…" : "Send on a date"}
      </button>
      {err && <span className="mt-1 text-xs text-bad">{err}</span>}
    </div>
  );
}

function RemoveButton({ id }: { id: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<"idle" | "confirm" | "busy">("idle");
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        className={`btn-ghost ${stage === "confirm" ? "!border-bad !text-bad" : ""}`}
        disabled={stage === "busy"}
        onClick={async () => {
          if (stage === "idle") return setStage("confirm");
          setStage("busy");
          const r = await fetch(`/api/people/${id}`, { method: "DELETE" });
          if (r.ok) {
            router.push("/");
            router.refresh();
          } else {
            setErr((await r.json()).error ?? "Failed");
            setStage("idle");
          }
        }}
      >
        {stage === "confirm" ? "Click again: delete everything" : stage === "busy" ? "Removing…" : "Remove this person"}
      </button>
      {stage === "confirm" && (
        <button className="text-xs text-muted underline" onClick={() => setStage("idle")}>cancel</button>
      )}
      {err && <span className="text-xs text-bad">{err}</span>}
    </span>
  );
}
