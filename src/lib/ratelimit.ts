import { db } from "./db";

export function clientIp(req: Request) {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const LIMITS = {
  add: { perIpHour: num(process.env.ADD_LIMIT_PER_IP_PER_HOUR, 5), perDay: num(process.env.ADD_LIMIT_PER_DAY, 40) },
  date: { perIpHour: num(process.env.DATE_LIMIT_PER_IP_PER_HOUR, 10), perDay: num(process.env.DATE_LIMIT_PER_DAY, 80) },
};

/** Per-IP hourly + global daily cap, backed by Postgres so it holds across serverless instances. Returns an error message or null. */
export async function checkRate(kind: keyof typeof LIMITS, ip: string): Promise<string | null> {
  const lim = LIMITS[kind];
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const dayAgo = new Date(Date.now() - 86400_000).toISOString();
  const [mine, all] = await Promise.all([
    db().from("rate_events").select("id", { count: "exact", head: true }).eq("kind", kind).eq("ip", ip).gte("created_at", hourAgo),
    db().from("rate_events").select("id", { count: "exact", head: true }).eq("kind", kind).gte("created_at", dayAgo),
  ]);
  const what = kind === "add" ? "new people" : "new dates";
  if ((all.count ?? 0) >= lim.perDay) return `The site has hit today's limit for ${what} (it protects the API credits). Please try again tomorrow, or browse the existing pool.`;
  if ((mine.count ?? 0) >= lim.perIpHour) return `You've started ${lim.perIpHour} ${what} in the last hour. Please wait a bit before starting more.`;
  await db().from("rate_events").insert({ kind, ip });
  return null;
}
