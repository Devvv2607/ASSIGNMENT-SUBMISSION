import { NextResponse } from "next/server";
import { stepPerson } from "@/lib/pipeline";

export const maxDuration = 300;

/** Advance this person's pipeline by one stage. Lock-guarded and idempotent: safe to call from a refreshed page. */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(await stepPerson(id));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
