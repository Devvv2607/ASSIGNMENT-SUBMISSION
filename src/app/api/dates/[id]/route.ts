import { NextResponse } from "next/server";
import { getDate } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const date = await getDate(id);
  if (!date) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(date);
}
