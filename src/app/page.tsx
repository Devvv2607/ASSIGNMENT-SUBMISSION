import Link from "next/link";
import { getGrid } from "@/lib/queries";
import { Avatar } from "@/components/Avatar";

export const dynamic = "force-dynamic";

export default async function Home() {
  let data: Awaited<ReturnType<typeof getGrid>> | null = null;
  let error: string | null = null;
  try {
    data = await getGrid();
  } catch (e) {
    error = (e as Error).message;
  }
  const ready = data?.grid.filter((p) => p.status === "ready") ?? [];
  const pending = data?.grid.filter((p) => p.status !== "ready") ?? [];

  return (
    <div>
      <section className="py-10 sm:py-16">
        <p className="label mb-4">An agentic dating experiment</p>
        <h1 className="max-w-3xl font-serif text-4xl leading-[1.05] sm:text-6xl">
          Your agent goes on the date. <span className="italic text-accent">You read the debrief.</span>
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-muted">
          Each person is read from exactly two sources: their LinkedIn and their public Instagram. Their AI Proxy then goes on real, multi-turn dates with other people&apos;s Proxies and reports back honestly.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Link href="/add" className="btn">Add a person</Link>
          <Link href="/how-it-works" className="btn-ghost">How it works</Link>
        </div>
        {data && (
          <p className="mt-8 font-serif text-xl text-muted">
            <span className="text-ink">{ready.length}</span> people · <span className="text-ink">{data.dates}</span> dates · <span className="text-ink">{data.turns.toLocaleString()}</span> turns
          </p>
        )}
      </section>

      {error && <div className="card border-bad/50 p-5 text-bad">Couldn&apos;t load the pool: {error}</div>}

      {data && ready.length === 0 && pending.length === 0 && (
        <div className="card p-10 text-center text-muted">
          The pool is empty. <Link href="/add" className="text-accent underline">Add the first person</Link>.
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ready.map((p) => (
          <Link key={p.id} href={`/p/${p.id}`} className="card group flex flex-col gap-4 p-5 transition hover:border-accent/60">
            <div className="flex items-center gap-3">
              <Avatar src={p.avatar_url} name={p.name} size={52} />
              <div className="min-w-0">
                <div className="font-serif text-xl leading-tight group-hover:text-accent">{p.name}</div>
              </div>
            </div>
            <p className="text-[15px] leading-snug text-ink/90">{p.card?.headline}</p>
            <div className="mt-auto flex flex-wrap gap-2">
              {p.card?.top_interests.map((t) => (
                <span key={t} className="rounded-full bg-panel-2 px-2.5 py-1 text-xs text-muted">{t}</span>
              ))}
            </div>
          </Link>
        ))}
        {pending.map((p) => (
          <Link key={p.id} href={`/add?id=${p.id}`} className="card flex items-center gap-3 border-dashed p-5 text-muted">
            <Avatar src={p.avatar_url} name={p.name} size={52} />
            <div>
              <div className="font-serif text-xl text-ink">{p.name}</div>
              <div className="text-sm">Being read… ({p.status})</div>
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}
