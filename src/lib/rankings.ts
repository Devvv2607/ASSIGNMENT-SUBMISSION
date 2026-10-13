import { db, must, type Person } from "./db";
import type { Debrief } from "./date";
import type { PersonProfile } from "./reader";

export type RankingRow = {
  candidate: Pick<Person, "id" | "name" | "avatar_url" | "gender">;
  headline: string;
  source: "date" | "prior";
  own_score: number | null; // this person's Proxy's score
  their_score: number | null; // the other side's score
  mutual_score: number | null;
  mutual_match: boolean;
  reason: string;
  date_id: string | null;
  date_status: string | null;
  prior_score: number;
};

/**
 * Rankings are computed from live data on every read, so removing a person or finishing a new
 * date re-ranks everyone automatically. Dated candidates are ordered by this person's own score;
 * undated ones follow, ordered by the pre-screen prior.
 */
export async function rankingsFor(personId: string): Promise<RankingRow[]> {
  const [people, profiles, priors, dates] = await Promise.all([
    db().from("people").select("id, name, avatar_url, gender").eq("status", "ready").neq("id", personId),
    db().from("profiles").select("person_id, profile"),
    db().from("pair_priors").select("a_id, b_id, prior_score, shared").or(`a_id.eq.${personId},b_id.eq.${personId}`),
    db().from("dates").select("id, a_id, b_id, status, mutual_score").or(`a_id.eq.${personId},b_id.eq.${personId}`).neq("status", "error"),
  ]);
  const ppl = must(people, "people") as RankingRow["candidate"][];
  const profs = new Map((must(profiles, "profiles") as { person_id: string; profile: PersonProfile }[]).map((p) => [p.person_id, p.profile]));
  const priorMap = new Map(
    (must(priors, "priors") as { a_id: string; b_id: string; prior_score: number; shared: string[] }[]).map((p) => [p.a_id === personId ? p.b_id : p.a_id, p]),
  );
  const ds = must(dates, "dates") as { id: string; a_id: string; b_id: string; status: string; mutual_score: number | null }[];
  const dateIds = ds.filter((d) => d.status === "done").map((d) => d.id);
  const debs = dateIds.length
    ? (must(await db().from("debriefs").select("date_id, person_id, report").in("date_id", dateIds), "debriefs") as { date_id: string; person_id: string; report: Debrief }[])
    : [];

  const rows: RankingRow[] = ppl.map((c) => {
    const d = ds.find((x) => x.a_id === c.id || x.b_id === c.id);
    const mine = d && debs.find((x) => x.date_id === d.id && x.person_id === personId)?.report;
    const theirs = d && debs.find((x) => x.date_id === d.id && x.person_id === c.id)?.report;
    const pr = priorMap.get(c.id);
    const base = { candidate: c, headline: profs.get(c.id)?.public_card.headline ?? "", prior_score: Number(pr?.prior_score ?? 0), date_id: d?.id ?? null, date_status: d?.status ?? null };
    if (d && d.status === "done" && mine && theirs) {
      return { ...base, source: "date", own_score: mine.overall, their_score: theirs.overall, mutual_score: Number(d.mutual_score), mutual_match: mine.second_date && theirs.second_date, reason: mine.note_to_my_human };
    }
    const shared = (pr?.shared ?? []) as string[];
    return {
      ...base,
      source: "prior",
      own_score: null,
      their_score: null,
      mutual_score: null,
      mutual_match: false,
      reason: shared.length ? `Overlap on paper: ${shared.join(", ")}` : "Little overlap on paper",
    };
  });
  return rows.sort((a, b) => {
    if (a.source !== b.source) return a.source === "date" ? -1 : 1;
    if (a.source === "date") return (b.own_score ?? 0) - (a.own_score ?? 0) || (b.mutual_score ?? 0) - (a.mutual_score ?? 0);
    return b.prior_score - a.prior_score;
  });
}
