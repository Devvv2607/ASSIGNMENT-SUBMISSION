import { db, must, logEvent } from "./db";
import { buildEvidence, NotFoundError, parseInstagram, PrivateInstagramError, scrapeInstagram, scrapeLinkedIn } from "./ingest";
import { perceiveBatch, synthesize } from "./reader";
import { prescreenPerson, topByPrior } from "./prescreen";
import { createDate, stepDate } from "./date";
import { errMsg } from "./util";

export const DATES_PER_PERSON = 3;
const LOCK_MS = 280_000;

/** The /add pipeline. Each stage is one bounded request; state lives in people.stage. */
export const STAGES = ["scrape_linkedin", "scrape_instagram", "cache_images", "vision_1", "vision_2", "synthesize", "prescreen", "date_1", "date_2", "date_3", "done"] as const;
export type Stage = (typeof STAGES)[number];

type PersonRow = { id: string; name: string; linkedin_url: string; instagram_url: string; status: string; stage: Stage; planned_dates: string[] };

async function claim(personId: string): Promise<PersonRow | null> {
  const now = new Date();
  const { data } = await db()
    .from("people")
    .update({ lock_until: new Date(now.getTime() + LOCK_MS).toISOString() })
    .eq("id", personId)
    .not("status", "in", "(error,rejected)")
    .neq("stage", "done")
    .or(`lock_until.is.null,lock_until.lt.${now.toISOString()}`)
    .select("id, name, linkedin_url, instagram_url, status, stage, planned_dates");
  return (data?.[0] as PersonRow) ?? null;
}

const nextStage = (s: Stage): Stage => STAGES[Math.min(STAGES.indexOf(s) + 1, STAGES.length - 1)];

/**
 * Advance one person by one stage (date stages advance their date by one step per call).
 * `stopBefore` lets the seed script stop at the prescreen stage and schedule dates globally.
 */
export async function stepPerson(personId: string, opts: { stopBefore?: Stage } = {}): Promise<{ stage: string; status: string; worked: boolean }> {
  const p = await claim(personId);
  if (!p) {
    const { data } = await db().from("people").select("stage, status").eq("id", personId).maybeSingle();
    return { stage: data?.stage ?? "missing", status: data?.status ?? "missing", worked: false };
  }
  const set = (patch: Record<string, unknown>) => db().from("people").update(patch).eq("id", personId);
  if (opts.stopBefore && p.stage === opts.stopBefore) {
    await set({ lock_until: null });
    return { stage: p.stage, status: p.status, worked: false };
  }
  try {
    let stage = p.stage;
    let status = p.status;
    switch (p.stage) {
      case "scrape_linkedin":
        status = "ingesting";
        await set({ status });
        await scrapeLinkedIn(personId, p.linkedin_url);
        break;
      case "scrape_instagram":
        await scrapeInstagram(personId, parseInstagram(p.instagram_url)!.handle);
        break;
      case "cache_images":
        await buildEvidence(personId);
        break;
      case "vision_1":
        status = "reading";
        await set({ status });
        await perceiveBatch(personId, 0);
        break;
      case "vision_2":
        await perceiveBatch(personId, 1);
        break;
      case "synthesize":
        await synthesize(personId);
        status = "ready";
        break;
      case "prescreen": {
        const priors = await prescreenPerson(personId);
        await logEvent(personId, "prescreen", `Pre-screened against ${priors.length} people by interest + value overlap`);
        const planned: string[] = [];
        for (const other of await topByPrior(personId, DATES_PER_PERSON)) planned.push((await createDate(personId, other)).id);
        await set({ planned_dates: planned });
        await logEvent(personId, "dates", planned.length ? `Sending their Proxy on ${planned.length} dates with their top matches…` : "No one else in the pool yet to date");
        break;
      }
      case "date_1":
      case "date_2":
      case "date_3": {
        const dateId = p.planned_dates[Number(p.stage.slice(5)) - 1];
        if (dateId) {
          const r = await stepDate(dateId);
          if (r.status !== "done" && r.status !== "error" && r.status !== "missing") {
            await set({ lock_until: null });
            return { stage: p.stage, status: p.status, worked: r.worked };
          }
        }
        break;
      }
    }
    stage = nextStage(p.stage);
    if (stage === "done") await logEvent(personId, "done", "done");
    await set({ stage, status, lock_until: null, error: null });
    return { stage, status, worked: true };
  } catch (e) {
    const rejected = e instanceof PrivateInstagramError || e instanceof NotFoundError;
    const msg = errMsg(e);
    // A private account is rejected outright: keep nothing scraped about it.
    if (e instanceof PrivateInstagramError) await db().from("raw_sources").delete().eq("person_id", personId);
    await logEvent(personId, "error", msg);
    // Rejections are final; other failures keep their stage so the next call retries it.
    await set({ ...(rejected ? { status: "rejected" } : {}), error: msg, lock_until: null });
    if (!rejected) throw e;
    return { stage: p.stage, status: "rejected", worked: true };
  }
}

/** Mark a person as permanently failed (used after repeated retries). */
export async function failPerson(personId: string, msg: string) {
  must(await db().from("people").update({ status: "error", error: msg, lock_until: null }).eq("id", personId), "fail person");
}
