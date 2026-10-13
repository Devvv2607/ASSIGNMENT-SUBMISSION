import { db, logEvent } from "./db";
import { ingestPerson, PrivateInstagramError } from "./ingest";
import { readPerson } from "./reader";
import { prescreenPerson, topByPrior } from "./prescreen";
import { createDate } from "./date";
import { errMsg } from "./util";

export const DATES_PER_PERSON = 3;

/**
 * Full pipeline for one person: Apify → evidence → Reader → pre-screen → create top-k dates.
 * `startDate` decides how each created date is run (in-process for the seed script, a separate
 * serverless invocation for the web app so each date gets its own time budget).
 */
export async function processPerson(personId: string, startDate: ((dateId: string) => Promise<void>) | null) {
  const setStatus = (status: string, error: string | null = null) => db().from("people").update({ status, error }).eq("id", personId);
  try {
    await setStatus("ingesting");
    await ingestPerson(personId);
    await setStatus("reading");
    await readPerson(personId);
    await setStatus("ready");
    const priors = await prescreenPerson(personId);
    await logEvent(personId, "prescreen", `Pre-screened against ${priors.length} people by interest + value overlap`);
    if (!startDate) return; // batch mode: the seed script schedules dates once the whole pool is read
    const top = await topByPrior(personId, DATES_PER_PERSON);
    const ids: string[] = [];
    for (const other of top) {
      const { id, existing } = await createDate(personId, other);
      if (!existing) ids.push(id);
    }
    await logEvent(personId, "dates", ids.length ? `Sending their Proxy on ${ids.length} dates with their top matches…` : "No one else in the pool yet to date");
    await Promise.all(ids.map((id) => startDate(id).catch(() => undefined)));
    await logEvent(personId, "done", "done");
  } catch (e) {
    const isPrivate = e instanceof PrivateInstagramError;
    const msg = isPrivate ? e.message : errMsg(e);
    // A private account is rejected outright: keep nothing we scraped about it.
    if (isPrivate) await db().from("raw_sources").delete().eq("person_id", personId);
    await setStatus(isPrivate ? "rejected" : "error", msg);
    await logEvent(personId, "error", msg);
    if (!(e instanceof PrivateInstagramError)) throw e;
  }
}
