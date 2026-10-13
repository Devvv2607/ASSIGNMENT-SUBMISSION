import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { parseInstagram, parseLinkedIn } from "@/lib/ingest";
import { checkRate, clientIp } from "@/lib/ratelimit";

export const maxDuration = 30;

/** Register a person. The client then drives the pipeline via POST /api/people/[id]/step. */
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

  // Dedupe by normalized LinkedIn URL: an existing live entry is returned as-is (no new credits spent).
  const { data: dupes } = await db().from("people").select("id, status").or(`linkedin_url.eq."${linkedin}",instagram_url.eq."${ig.url}"`);
  const live = dupes?.find((d) => !["error", "rejected"].includes(d.status));
  if (live) return NextResponse.json({ id: live.id, existing: true });

  const limited = await checkRate("add", clientIp(req));
  if (limited) return NextResponse.json({ error: limited }, { status: 429 });

  if (dupes?.length) await db().from("people").delete().in("id", dupes.map((d) => d.id)); // replace a failed/rejected attempt

  const { data, error } = await db()
    .from("people")
    .insert({ name, linkedin_url: linkedin, instagram_url: ig.url, gender, consent_source: `confirmed via /add form, ${new Date().toISOString().slice(0, 10)}`, status: "queued", stage: "scrape_linkedin" })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: data.id });
}
