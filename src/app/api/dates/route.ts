import { NextResponse, after } from "next/server";
import { db } from "@/lib/db";
import { claimDate, createDate, runDate } from "@/lib/date";

export const maxDuration = 300;

/** "Send on a date": create the date and run it in the background; the page polls for turns. */
export async function POST(req: Request) {
  const { aId, bId } = await req.json().catch(() => ({}));
  if (!aId || !bId) return NextResponse.json({ error: "aId and bId are required" }, { status: 400 });
  const { data: ready } = await db().from("people").select("id").in("id", [aId, bId]).eq("status", "ready");
  if ((ready?.length ?? 0) < 2) return NextResponse.json({ error: "Both people need a finished profile first." }, { status: 400 });
  try {
    const { id } = await createDate(aId, bId);
    if (await claimDate(id)) after(() => runDate(id).catch(() => undefined));
    return NextResponse.json({ id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
