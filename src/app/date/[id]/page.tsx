import { notFound } from "next/navigation";
import { getDate } from "@/lib/queries";
import { DateView } from "./DateView";

export const dynamic = "force-dynamic";

export default async function DatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const initial = await getDate(id);
  if (!initial) notFound();
  return <DateView initial={initial} />;
}
