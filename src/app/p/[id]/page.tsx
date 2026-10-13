import { notFound, redirect } from "next/navigation";
import { getProfilePage } from "@/lib/queries";
import { rankingsFor } from "@/lib/rankings";
import { ProfileView } from "./ProfileView";

export const dynamic = "force-dynamic";

export default async function ProfilePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params;
  const { tab } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await getProfilePage(id);
  if (!data) notFound();
  if (data.person.status !== "ready" || !data.profile) redirect(`/add?id=${id}`);
  const rankings = await rankingsFor(id);
  return <ProfileView {...data} profile={data.profile} rankings={rankings} initialTab={tab === "dates" || tab === "rankings" ? tab : "analysis"} />;
}
