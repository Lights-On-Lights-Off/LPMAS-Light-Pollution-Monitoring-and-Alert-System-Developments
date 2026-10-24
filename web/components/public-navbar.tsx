"use client";
import Image from "next/image";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";

export function PublicNavbar() {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menuOpen]);

  return <header className="glass-navbar public-header sticky top-0 z-50 w-full border-b">
    <nav aria-label="Main navigation" className="flex h-16 lg:h-[72px] w-full items-center justify-between px-4 sm:px-6 lg:px-8">
      <Link href="/" className="flex min-w-0 items-center gap-3">
        <Image width={48} height={48} src="/Hayag-logo.png" alt="Hayag logo" className="h-9 w-9 shrink-0 rounded-xl object-contain" />
        <div className="min-w-0">
          <span className="block truncate text-sm font-bold tracking-tight text-primary">LPMAS Live Monitor</span>
          <span className="block truncate text-xs text-secondary">Smart light pollution monitoring</span>
        </div>
      </Link>

      <div className="hidden items-center gap-7 text-sm text-secondary lg:flex">
        <Link href="/about" className="inline-flex min-h-11 items-center transition hover:text-primary">About</Link>
        <Link href="/about#features" className="inline-flex min-h-11 items-center transition hover:text-primary">Features</Link>
        <Link href="/about#how-it-works" className="inline-flex min-h-11 items-center transition hover:text-primary">How it works</Link>
        <Link href="/" className="inline-flex min-h-11 items-center transition hover:text-primary">Home</Link>
        <Link href="/login" className="glass-button inline-flex min-h-11 items-center rounded-full px-5 py-2 text-xs font-semibold transition">Staff sign in</Link>
      </div>

      <button onClick={() => setMenuOpen(!menuOpen)} className="rounded-xl p-2 text-primary transition hover:bg-white/20 lg:hidden" aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} aria-controls="public-menu">
        {menuOpen ? <X aria-hidden="true" size={20} /> : <Menu aria-hidden="true" size={20} />}
      </button>
    </nav>

    {menuOpen && <div id="public-menu" className="glass-card-strong max-h-[calc(100dvh-64px-env(safe-area-inset-top))] overflow-y-auto space-y-1 border-t px-5 py-4 lg:hidden">
      <Link href="/about" onClick={() => setMenuOpen(false)} className="block rounded-xl px-3 py-3 text-sm text-primary transition hover:bg-white/20">About</Link>
      <Link href="/about#features" onClick={() => setMenuOpen(false)} className="block rounded-xl px-3 py-3 text-sm text-primary transition hover:bg-white/20">Features</Link>
      <Link href="/about#how-it-works" onClick={() => setMenuOpen(false)} className="block rounded-xl px-3 py-3 text-sm text-primary transition hover:bg-white/20">How it works</Link>
      <Link href="/" onClick={() => setMenuOpen(false)} className="block rounded-xl px-3 py-3 text-sm text-primary transition hover:bg-white/20">Home</Link>
      <Link href="/appearance" onClick={() => setMenuOpen(false)} className="block rounded-xl px-3 py-3 text-sm text-primary transition hover:bg-white/20">Appearance</Link>
      <Link href="/login" onClick={() => setMenuOpen(false)} className="glass-button mt-2 block rounded-full px-5 py-3 text-center text-sm font-semibold">Staff sign in</Link>
    </div>}
  </header>;
}