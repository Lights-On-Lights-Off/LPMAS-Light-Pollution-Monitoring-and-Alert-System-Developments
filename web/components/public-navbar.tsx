"use client";

import Link from "next/link";
import { useState } from "react";
import { Menu, X } from "lucide-react";

export function PublicNavbar() {
  const [menuOpen, setMenuOpen] = useState(false);

  return <header className="glass-navbar sticky top-0 z-50 w-full border-b">
    <nav className="flex h-[72px] w-full items-center justify-between px-4 sm:px-6 lg:px-8">
      <Link href="/" className="flex min-w-0 items-center gap-3">
        <img src="/Hayag-logo.png" alt="Hayag logo" className="h-9 w-9 shrink-0 rounded-xl object-contain" />
        <div className="min-w-0">
          <span className="block truncate text-sm font-bold tracking-tight text-primary">LPMAS Live Monitor</span>
          <span className="block truncate text-[10px] text-secondary">Smart light pollution monitoring</span>
        </div>
      </Link>

      <div className="hidden items-center gap-7 text-sm text-secondary md:flex">
        <Link href="/about" className="transition hover:text-primary">About</Link>
        <Link href="/about#features" className="transition hover:text-primary">Features</Link>
        <Link href="/about#how-it-works" className="transition hover:text-primary">How it works</Link>
        <Link href="/" className="transition hover:text-primary">Home</Link>
        <Link href="/login" className="glass-button rounded-full px-5 py-2 text-xs font-semibold transition">Staff sign in</Link>
      </div>

      <button onClick={() => setMenuOpen(!menuOpen)} className="rounded-xl p-2 text-primary transition hover:bg-white/20 md:hidden" aria-label="Toggle menu">
        {menuOpen ? <X size={20} /> : <Menu size={20} />}
      </button>
    </nav>

    {menuOpen && <div className="glass-card-strong space-y-1 border-t px-5 py-4 md:hidden">
      <Link href="/about" onClick={() => setMenuOpen(false)} className="block rounded-xl px-3 py-2 text-sm text-primary transition hover:bg-white/20">About</Link>
      <Link href="/about#features" onClick={() => setMenuOpen(false)} className="block rounded-xl px-3 py-2 text-sm text-primary transition hover:bg-white/20">Features</Link>
      <Link href="/about#how-it-works" onClick={() => setMenuOpen(false)} className="block rounded-xl px-3 py-2 text-sm text-primary transition hover:bg-white/20">How it works</Link>
      <Link href="/" onClick={() => setMenuOpen(false)} className="block rounded-xl px-3 py-2 text-sm text-primary transition hover:bg-white/20">Home</Link>
      <Link href="/appearance" onClick={() => setMenuOpen(false)} className="block rounded-xl px-3 py-2 text-sm text-primary transition hover:bg-white/20">Appearance</Link>
      <Link href="/login" onClick={() => setMenuOpen(false)} className="glass-button mt-2 block rounded-full px-5 py-3 text-center text-sm font-semibold">Staff sign in</Link>
    </div>}
  </header>;
}