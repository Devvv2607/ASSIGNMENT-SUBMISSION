export async function retry<T>(fn: () => Promise<T>, tries = 3, label = "op"): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1500 * 2 ** i));
    }
  }
  throw new Error(`${label} failed after ${tries} tries: ${(last as Error)?.message ?? last}`);
}

/** Run fn over items with at most `limit` in flight. Never rejects; returns per-item results. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<({ ok: true; value: R } | { ok: false; error: string })[]> {
  const out: ({ ok: true; value: R } | { ok: false; error: string })[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { ok: true, value: await fn(items[i], i) };
      } catch (e) {
        out[i] = { ok: false, error: (e as Error).message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
