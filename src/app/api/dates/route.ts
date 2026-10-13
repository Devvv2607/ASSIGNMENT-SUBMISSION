import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createDate } from "@/lib/date";
import { checkRate, clientIp } from "@/lib/ratelimit";

export const maxDuration = 30;

/** "Send on a date": create a queued date. The date page then drives it step by step. */
export async function POST(req: Request) {
  const { aId, bId } = await req.json().catch(() => ({}));
  if (!aId || !bId) return NextResponse.json({ error: "aId and bId are required" }, { status: 400 });
  const { data: ready } = await db().from("people").select("id").in("id", [aId, bId]).eq("status", "ready");
  if ((ready?.length ?? 0) < 2) return NextResponse.json({ error: "Both people need a finished profile first." }, { status: 400 });
  try {
    const { data: existing } = await db()
      .from("dates")
      .select("id")
      .or(`and(a_id.eq.${aId},b_id.eq.${bId}),and(a_id.eq.${bId},b_id.eq.${aId})`)
      .neq("status", "error")
      .maybeSingle();
    if (existing) return NextResponse.json({ id: existing.id });
    const limited = await checkRate("date", clientIp(req));
    if (limited) return NextResponse.json({ error: limited }, { status: 429 });
    const { id } = await createDate(aId, bId);
    return NextResponse.json({ id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
