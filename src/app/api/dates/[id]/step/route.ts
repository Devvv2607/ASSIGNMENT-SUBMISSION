import { NextResponse } from "next/server";
import { stepDate } from "@/lib/date";

export const maxDuration = 300;

/** Advance a date by one stage or one turn. Lock-guarded: concurrent viewers can't double-run it. */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(await stepDate(id));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
