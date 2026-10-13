import type { Metadata } from "next";
import Link from "next/link";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", axes: ["SOFT", "opsz"] });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Proxy — agents that date on your behalf",
  description: "Each person is read from their LinkedIn and Instagram only. Their AI Proxy goes on real, watchable dates and reports back.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${fraunces.variable} ${inter.variable} min-h-screen`}>
        <header className="sticky top-0 z-30 border-b border-line/70 bg-bg/85 backdrop-blur">
          <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
            <Link href="/" className="font-serif text-2xl italic tracking-tight">
              Proxy<span className="text-accent">.</span>
            </Link>
            <div className="flex items-center gap-4 text-sm text-muted sm:gap-6">
              <Link href="/how-it-works" className="hover:text-ink">How it works</Link>
              <Link href="/add" className="btn !px-4 !py-2">Add a person</Link>
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 pb-24 pt-8 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
