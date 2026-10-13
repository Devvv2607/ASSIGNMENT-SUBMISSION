import { NextResponse, after } from "next/server";
import { claimDate, runDate } from "@/lib/date";

export const maxDuration = 300;

/** Runs a queued date in its own invocation. Idempotent: only the first caller claims it. */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const claimed = await claimDate(id);
  if (claimed) after(() => runDate(id).catch(() => undefined));
  return NextResponse.json({ id, started: claimed }, { status: 202 });
}
