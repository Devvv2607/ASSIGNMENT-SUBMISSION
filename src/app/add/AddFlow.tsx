"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";

type Ev = { id: number; step: string; message: string; created_at: string };
type DateRow = { id: string; a_id: string; b_id: string; status: string; venue: string | null; mutual_score: number | null; error: string | null };
type Person = { id: string; name: string; status: string; stage: string; error: string | null; avatar_url: string | null; planned_dates: string[] };
type Status = { person: Person; events: Ev[]; dates: DateRow[] };

const STEPS: { key: string; label: string }[] = [
  { key: "scrape_linkedin", label: "Scrape LinkedIn (Apify)" },
  { key: "scrape_instagram", label: "Scrape Instagram (Apify)" },
  { key: "cache_images", label: "Extract evidence + cache photos" },
  { key: "vision_1", label: "Look at photos 1–3" },
  { key: "vision_2", label: "Look at photos 4–6" },
  { key: "synthesize", label: "The Reader writes the profile" },
  { key: "prescreen", label: "Pre-screen against the whole pool" },
  { key: "date_1", label: "Date 1" },
  { key: "date_2", label: "Date 2" },
  { key: "date_3", label: "Date 3" },
];
const ORDER = [...STEPS.map((s) => s.key), "done"];

export function AddFlow() {
  const params = useSearchParams();
  const router = useRouter();
  const [id, setId] = useState<string | null>(params.get("id"));
  const [form, setForm] = useState({ name: "", linkedin: "", instagram: "", gender: "", consent: false });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [driveError, setDriveError] = useState<string | null>(null);
  const [driveKey, setDriveKey] = useState(0);
  const driving = useRef(false);

  // Poll the event log + status.
  useEffect(() => {
    if (!id) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/people/${id}/events`, { cache: "no-store" });
        if (r.ok) setStatus(await r.json());
      } catch {}
      if (!stop) setTimeout(tick, 1500);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [id]);

  // Drive the pipeline: one bounded request per stage. A refresh resumes from the stored stage.
  const drive = useCallback(async (pid: string, signal: { stop: boolean }) => {
    if (driving.current) return;
    driving.current = true;
    setDriveError(null);
    let failures = 0;
    try {
      while (!signal.stop) {
        const r = await fetch(`/api/people/${pid}/step`, { method: "POST" });
        const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
        if (!r.ok) {
          if (++failures >= 3) {
            setDriveError(j.error ?? "Step failed");
            return;
          }
          await new Promise((res) => setTimeout(res, 3000 * failures));
          continue;
        }
        failures = 0;
        if (j.stage === "done" || j.stage === "missing" || ["rejected", "error"].includes(j.status)) return;
        if (!j.worked) await new Promise((res) => setTimeout(res, 2500)); // someone else holds the lock
      }
    } finally {
      driving.current = false;
    }
  }, []);

  useEffect(() => {
    if (!id) return;
    const signal = { stop: false };
    drive(id, signal);
    return () => {
      signal.stop = true;
    };
  }, [id, drive, driveKey]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const r = await fetch("/api/people", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Something went wrong");
      if (j.existing) {
        router.push(`/p/${j.id}`);
        return;
      }
      setId(j.id);
      router.replace(`/add?id=${j.id}`);
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!id) {
    return (
      <div className="mx-auto max-w-xl">
        <h1 className="font-serif text-4xl">Add a person</h1>
        <p className="mt-3 text-muted">Paste their two links. Their Proxy reads only these two sources, builds a profile, then goes on dates with their 3 best matches in the pool. Takes a few minutes; you can watch every step.</p>
        <form onSubmit={submit} className="card mt-8 space-y-5 p-6">
          <Field label="Name">
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ananya Rao" className="input" />
          </Field>
          <Field label="LinkedIn profile URL">
            <input required value={form.linkedin} onChange={(e) => setForm({ ...form, linkedin: e.target.value })} placeholder="https://www.linkedin.com/in/…" className="input" />
          </Field>
          <Field label="Instagram profile URL (must be public)">
            <input required value={form.instagram} onChange={(e) => setForm({ ...form, instagram: e.target.value })} placeholder="https://www.instagram.com/…" className="input" />
          </Field>
          <Field label="How do they identify? (optional, self-reported, only used for the viewer-side filter)">
            <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} className="input">
              <option value="">Prefer not to say</option>
              <option value="woman">Woman</option>
              <option value="man">Man</option>
            </select>
          </Field>
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input type="checkbox" required checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} className="mt-0.5 h-4 w-4 accent-[var(--accent)]" />
            <span>I confirm this person has agreed to be included.</span>
          </label>
          {formError && <p className="rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad">{formError}</p>}
          <button className="btn w-full" disabled={submitting || !form.consent}>
            {submitting ? "Starting…" : "Read them & find dates"}
          </button>
        </form>
        <style>{`.input{width:100%;border-radius:.75rem;border:1px solid var(--line);background:var(--panel-2);padding:.65rem .85rem;color:var(--ink);outline:none}.input:focus{border-color:var(--accent)}`}</style>
      </div>
    );
  }

  const p = status?.person;
  const events = status?.events ?? [];
  const failed = p?.status === "error" || p?.status === "rejected";
  const cur = p ? ORDER.indexOf(p.stage) : -1;
  const dateById = new Map((status?.dates ?? []).map((d) => [d.id, d]));
  const planned = (p?.planned_dates ?? []).map((d) => dateById.get(d)).filter(Boolean) as DateRow[];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center gap-4">
        <Avatar src={p?.avatar_url} name={p?.name ?? "…"} size={64} />
        <div>
          <p className="label">Live pipeline</p>
          <h1 className="font-serif text-4xl">{p?.name ?? "Loading…"}</h1>
        </div>
      </div>

      <ol className="mt-8 grid gap-2 sm:grid-cols-2">
        {STEPS.map((s, i) => {
          const done = cur > i;
          const active = cur === i && !failed;
          const date = s.key.startsWith("date_") ? planned[Number(s.key.slice(5)) - 1] : undefined;
          const skipped = s.key.startsWith("date_") && cur > ORDER.indexOf("prescreen") && !date;
          return (
            <li key={s.key} className={`card flex items-center gap-3 px-4 py-3 transition ${done ? "border-good/40" : active ? "border-accent/60" : "opacity-50"}`}>
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${done ? "bg-good text-bg" : active ? "bg-accent text-bg" : "bg-panel-2 text-muted"}`}>
                {done ? (skipped ? "–" : "✓") : active ? "•" : ""}
              </span>
              <span className={`min-w-0 flex-1 truncate ${active ? "text-accent" : ""}`}>
                {s.label}
                {date?.venue ? `: ${date.venue}` : ""}
                {skipped ? " (no one to date yet)" : ""}
              </span>
              {date && (
                <Link href={`/date/${date.id}`} className="shrink-0 text-xs text-accent underline">
                  {date.status === "done" ? `mutual ${date.mutual_score}` : "watch"}
                </Link>
              )}
              {active && !date && <Typing />}
            </li>
          );
        })}
      </ol>

      {failed && (
        <div className="mt-6 rounded-xl border border-bad/50 bg-bad/10 p-5 text-bad">
          <p className="font-semibold">{p?.status === "rejected" ? "Can't add this person" : "This run failed"}</p>
          <p className="mt-1 text-sm">{p?.error}</p>
          <Link href="/add" onClick={() => setId(null)} className="btn-ghost mt-4">Try different links</Link>
        </div>
      )}
      {!failed && driveError && (
        <div className="mt-6 rounded-xl border border-bad/50 bg-bad/10 p-5 text-bad">
          <p className="font-semibold">A step failed after 3 attempts</p>
          <p className="mt-1 break-words text-sm">{driveError}</p>
          <button onClick={() => setDriveKey((k) => k + 1)} className="btn-ghost mt-4">Retry from this step</button>
        </div>
      )}

      {p?.status === "ready" && (
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href={`/p/${id}`} className="btn">Open profile</Link>
          <Link href={`/p/${id}?tab=rankings`} className="btn-ghost">Rankings</Link>
        </div>
      )}

      <div className="card mt-6 p-5">
        <p className="label mb-3">Step log</p>
        <ul className="space-y-1.5 font-mono text-[13px]">
          {events.filter((e) => e.step !== "done").map((e) => (
            <li key={e.id} className="rise flex gap-3">
              <span className="shrink-0 text-muted">{new Date(e.created_at).toLocaleTimeString()}</span>
              <span className={e.step === "error" ? "break-words text-bad" : ""}>{e.message}</span>
            </li>
          ))}
          {!events.length && <li className="text-muted">Starting…</li>}
        </ul>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm text-muted">{label}</span>
      {children}
    </label>
  );
}

function Typing() {
  return (
    <span className="typing ml-auto flex gap-1 text-accent">
      <span>●</span>
      <span>●</span>
      <span>●</span>
    </span>
  );
}
