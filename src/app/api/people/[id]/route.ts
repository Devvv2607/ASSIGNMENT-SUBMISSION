import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/** Remove a person: their data, cached images, and every date involving them (FK cascade). */
export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data: files } = await db().storage.from("media").list(id);
  if (files?.length) await db().storage.from("media").remove(files.map((f) => `${id}/${f.name}`));
  const { error } = await db().from("people").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
