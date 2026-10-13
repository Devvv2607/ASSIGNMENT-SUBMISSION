/* eslint-disable @next/next/no-img-element */
export function Avatar({ src, name, size = 48 }: { src: string | null | undefined; name: string; size?: number }) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return src ? (
    <img src={src} alt={name} width={size} height={size} referrerPolicy="no-referrer" className="shrink-0 rounded-full border border-line object-cover" style={{ width: size, height: size }} />
  ) : (
    <div className="flex shrink-0 items-center justify-center rounded-full border border-line bg-panel-2 font-serif text-muted" style={{ width: size, height: size, fontSize: size / 2.6 }}>
      {initials}
    </div>
  );
}
