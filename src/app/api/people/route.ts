import { NextResponse, after, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { parseInstagram, parseLinkedIn } from "@/lib/ingest";
import { processPerson } from "@/lib/pipeline";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();
  const linkedin = parseLinkedIn(String(body.linkedin ?? ""));
  const ig = parseInstagram(String(body.instagram ?? ""));
  const gender = body.gender === "man" || body.gender === "woman" ? body.gender : null;

  if (!name || name.length > 80) return NextResponse.json({ error: "Please enter the person's name." }, { status: 400 });
  if (!linkedin) return NextResponse.json({ error: "That doesn't look like a LinkedIn profile link. It should look like https://www.linkedin.com/in/their-name" }, { status: 400 });
  if (!ig) return NextResponse.json({ error: "That doesn't look like an Instagram profile link. It should look like https://www.instagram.com/handle" }, { status: 400 });
  if (body.consent !== true) return NextResponse.json({ error: "Please confirm this person has agreed to be included." }, { status: 400 });

  // Same links already in the pool? Reuse a live entry; replace a failed one.
  const { data: dupes } = await db().from("people").select("id, status").or(`linkedin_url.eq."${linkedin}",instagram_url.eq."${ig.url}"`);
  const live = dupes?.find((d) => !["error", "rejected"].includes(d.status));
  if (live) return NextResponse.json({ id: live.id, existing: true });
  if (dupes?.length) await db().from("people").delete().in("id", dupes.map((d) => d.id));

  const { data, error } = await db()
    .from("people")
    .insert({ name, linkedin_url: linkedin, instagram_url: ig.url, gender, consent_source: `confirmed via /add form, ${new Date().toISOString().slice(0, 10)}`, status: "queued" })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const origin = req.nextUrl.origin;
  // Each date runs in its own invocation so it gets a full time budget.
  const startDate = async (dateId: string) => {
    await fetch(`${origin}/api/dates/${dateId}/run`, { method: "POST" });
  };
  after(() => processPerson(data.id, startDate).catch(() => undefined));
  return NextResponse.json({ id: data.id });
}
