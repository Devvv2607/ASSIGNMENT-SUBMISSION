import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [person, events, dates] = await Promise.all([
    db().from("people").select("id, name, status, stage, error, avatar_url, planned_dates").eq("id", id).maybeSingle(),
    db().from("job_events").select("id, step, message, created_at").eq("person_id", id).order("id"),
    db().from("dates").select("id, a_id, b_id, status, venue, mutual_score, error").or(`a_id.eq.${id},b_id.eq.${id}`).order("started_at"),
  ]);
  if (!person.data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ person: person.data, events: events.data ?? [], dates: dates.data ?? [] });
}
