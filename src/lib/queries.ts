import { db, must, type EvidenceRow, type Person } from "./db";
import type { PersonProfile } from "./reader";
import type { Debrief } from "./date";

export type GridPerson = Pick<Person, "id" | "name" | "avatar_url" | "status"> & { card: PersonProfile["public_card"] | null };

export async function getGrid() {
  const [people, profiles, dateCount, turnCount] = await Promise.all([
    db().from("people").select("id, name, avatar_url, status").in("status", ["ready", "queued", "ingesting", "reading"]).order("created_at"),
    db().from("profiles").select("person_id, profile"),
    db().from("dates").select("id", { count: "exact", head: true }).eq("status", "done"),
    db().from("date_turns").select("date_id", { count: "exact", head: true }),
  ]);
  const cards = new Map((must(profiles, "profiles") as { person_id: string; profile: PersonProfile }[]).map((p) => [p.person_id, p.profile.public_card]));
  const grid: GridPerson[] = (must(people, "people") as GridPerson[]).map((p) => ({ ...p, card: cards.get(p.id) ?? null }));
  return { grid, dates: dateCount.count ?? 0, turns: turnCount.count ?? 0 };
}

export type DatePayload = {
  date: {
    id: string;
    a_id: string;
    b_id: string;
    status: string;
    venue: string | null;
    scene: string | null;
    prep: { goals?: Record<string, string[]>; proposals?: Record<string, { idea: string; why: string }>; negotiation?: { speaker: string; say: string }[] } | null;
    ended_early_by: string | null;
    mutual_score: number | null;
    error: string | null;
    started_at: string;
  };
  people: Record<string, { id: string; name: string; avatar_url: string | null; headline: string }>;
  turns: { idx: number; speaker_id: string; say: string; inner_thought: string; signals: { checked_need?: string; red_flag?: string; green_flag?: string } }[];
  debriefs: { person_id: string; report: Debrief }[];
};

export async function getDate(id: string): Promise<DatePayload | null> {
  const { data: date } = await db().from("dates").select("*").eq("id", id).maybeSingle();
  if (!date) return null;
  const [people, profiles, turns, debriefs] = await Promise.all([
    db().from("people").select("id, name, avatar_url").in("id", [date.a_id, date.b_id]),
    db().from("profiles").select("person_id, profile").in("person_id", [date.a_id, date.b_id]),
    db().from("date_turns").select("idx, speaker_id, say, inner_thought, signals").eq("date_id", id).order("idx"),
    db().from("debriefs").select("person_id, report").eq("date_id", id),
  ]);
  const heads = new Map((profiles.data ?? []).map((p) => [p.person_id, (p.profile as PersonProfile).public_card.headline]));
  return {
    date,
    people: Object.fromEntries((people.data ?? []).map((p) => [p.id, { ...p, headline: heads.get(p.id) ?? "" }])),
    turns: turns.data ?? [],
    debriefs: debriefs.data ?? [],
  } as DatePayload;
}

export async function getProfilePage(id: string) {
  const { data: person } = await db().from("people").select("*").eq("id", id).maybeSingle();
  if (!person) return null;
  const [profile, evidence, dates] = await Promise.all([
    db().from("profiles").select("profile, model, created_at").eq("person_id", id).maybeSingle(),
    db().from("evidence").select("id, source, kind, text, image_url, meta").eq("person_id", id),
    db().from("dates").select("id, a_id, b_id, status, venue, mutual_score, started_at").or(`a_id.eq.${id},b_id.eq.${id}`).order("started_at", { ascending: false }),
  ]);
  const ds = dates.data ?? [];
  const otherIds = ds.map((d) => (d.a_id === id ? d.b_id : d.a_id));
  const [others, debs] = await Promise.all([
    otherIds.length ? db().from("people").select("id, name, avatar_url").in("id", otherIds) : Promise.resolve({ data: [] as { id: string; name: string; avatar_url: string | null }[] }),
    ds.length ? db().from("debriefs").select("date_id, person_id, report").in("date_id", ds.map((d) => d.id)) : Promise.resolve({ data: [] as { date_id: string; person_id: string; report: Debrief }[] }),
  ]);
  const otherMap = new Map((others.data ?? []).map((o) => [o.id, o]));
  return {
    person: person as Person,
    profile: (profile.data?.profile as PersonProfile) ?? null,
    model: profile.data?.model ?? null,
    evidence: (evidence.data ?? []) as Pick<EvidenceRow, "id" | "source" | "kind" | "text" | "image_url" | "meta">[],
    dates: ds.map((d) => {
      const otherId = d.a_id === id ? d.b_id : d.a_id;
      const mine = debs.data?.find((x) => x.date_id === d.id && x.person_id === id)?.report as Debrief | undefined;
      const theirs = debs.data?.find((x) => x.date_id === d.id && x.person_id === otherId)?.report as Debrief | undefined;
      return { ...d, other: otherMap.get(otherId) ?? { id: otherId, name: "Removed", avatar_url: null }, mine: mine ?? null, theirs: theirs ?? null };
    }),
  };
}
