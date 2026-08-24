"use client";

import Link from "next/link";
import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowRight, BellRing, CloudSun, Database, Menu, ShieldCheck, Sprout, X
} from "lucide-react";

const features = [
  { icon: <CloudSun strokeWidth={1.75} />, title: "Continuous light monitoring", text: "BH1750FVI lux readings every five seconds through the full crop cycle.", wide: true },
  { icon: <Sprout strokeWidth={1.75} />, title: "Phase-aware detection", text: "One range check for illumination, one ceiling check for the dark period." },
  { icon: <BellRing strokeWidth={1.75} />, title: "Instant alerts", text: "Staff notified the moment a reading breaches its phase." },
  { icon: <ShieldCheck strokeWidth={1.75} />, title: "Role-based access", text: "Admins, managers, technicians, each scoped to what they need." },
  { icon: <Database strokeWidth={1.75} />, title: "Full event history", text: "Every reading and incident kept for review." }
];

const pipeline = [
  { title: "Measure", text: "The ESP32 and BH1750FVI send a timestamped lux reading every five seconds." },
  { title: "Evaluate", text: "LPMAS checks the active phase, an illumination range or a dark ceiling, against it." },
  { title: "Respond", text: "An incident opens, the technician is alerted, the resolution gets recorded." }
];

const stats = [
  { value: "70-100", label: "Target lux range" },
  { value: "6:30-11", label: "Nightly window, PM" },
  { value: "3", label: "Sensors online" },
  { value: "5s", label: "Reporting interval" }
];

function LuxGauge() {
  // Illustrative reading, not a live feed. Maps 0-150 lux onto the track,
  // shades the 70-100 target band, marks a sample value at 88.4.
  const min = 0, max = 150, bandLow = 70, bandHigh = 100, reading = 88.4;
  const pct = (v: number) => ((v - min) / (max - min)) * 100;

  return <div className="rounded-3xl border border-metal-700 bg-metal-800/60 p-8">
    <div className="flex items-baseline justify-between">
      <div>
        <p className="text-xs uppercase tracking-wide text-metal-500">Sample reading</p>
        <p className="mt-1 font-mono text-4xl font-bold text-metal-50">{reading}<span className="ml-1 text-lg text-metal-500">lux</span></p>
      </div>
      <span className="rounded-full bg-leaf-500/15 px-3 py-1 text-xs font-semibold text-leaf-500">In range</span>
    </div>

    <div className="relative mt-8 h-2 rounded-full bg-white/10">
      <div
        className="absolute top-0 h-2 rounded-full bg-leaf-500/25"
        style={{ left: `${pct(bandLow)}%`, width: `${pct(bandHigh) - pct(bandLow)}%` }}
      />
      <div
        className="absolute -top-1.5 h-5 w-1 rounded-full bg-leaf-500"
        style={{ left: `${pct(reading)}%` }}
      />
    </div>
    <div className="mt-3 flex justify-between font-mono text-xs text-metal-500">
      <span>0</span>
      <span className="text-leaf-500/70">70</span>
      <span className="text-leaf-500/70">100</span>
      <span>150</span>
    </div>

    <dl className="mt-8 grid grid-cols-2 gap-4 border-t border-metal-700 pt-6 text-sm">
      <div><dt className="text-metal-500">Phase</dt><dd className="mt-1 font-mono">Illumination</dd></div>
      <div><dt className="text-metal-500">Window</dt><dd className="mt-1 font-mono">6:30-11 PM</dd></div>
    </dl>
  </div>;
}

export function Landing() {
  const [menuOpen, setMenuOpen] = useState(false);
  const reduce = useReducedMotion();
  const fade = reduce ? {} : {
    initial: { opacity: 0, y: 14 },
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, margin: "-80px" },
    transition: { duration: 0.6, ease: "easeOut" as const }
  };

  return <main className="w-full max-w-full overflow-x-hidden bg-ink font-sans text-metal-100 antialiased">

    <header className="sticky top-0 z-30 border-b border-metal-700 bg-ink/80 backdrop-blur-xl">
      <nav className="mx-auto flex h-[72px] max-w-6xl items-center justify-between px-5">
        <Link href="/" className="flex items-center gap-3">
          <img src="/Hayag-logo.png" alt="Hayag logo" className="h-9 w-9 rounded-xl object-contain" />
          <span className="text-sm font-bold tracking-tight">LPMAS</span>
        </Link>
        <div className="hidden items-center gap-8 text-sm text-metal-300 md:flex">
          <a href="#features" className="transition hover:text-metal-50">Features</a>
          <a href="#how-it-works" className="transition hover:text-metal-50">How it works</a>
          <a href="#about" className="transition hover:text-metal-50">About</a>
          <Link href="/monitor" className="transition hover:text-metal-50">Live monitor</Link>
          <Link href="/login" className="rounded-full bg-leaf-500 px-5 py-2 text-sm font-semibold text-ink transition hover:bg-leaf-100">
            Sign in
          </Link>
        </div>
        <button onClick={() => setMenuOpen(!menuOpen)} className="rounded-xl p-2 md:hidden" aria-label="Toggle menu">
          {menuOpen ? <X /> : <Menu />}
        </button>
      </nav>
      {menuOpen && <div className="space-y-1 border-t border-metal-700 px-5 py-4 md:hidden">
        <a href="#features" onClick={() => setMenuOpen(false)} className="block py-2">Features</a>
        <a href="#how-it-works" onClick={() => setMenuOpen(false)} className="block py-2">How it works</a>
        <a href="#about" onClick={() => setMenuOpen(false)} className="block py-2">About</a>
        <Link href="/monitor" onClick={() => setMenuOpen(false)} className="block py-2">Live monitor</Link>
        <Link href="/login" className="mt-2 block rounded-full bg-leaf-500 px-5 py-3 text-center font-semibold text-ink">Sign in</Link>
      </div>}
    </header>

    <section className="relative px-5 pb-24 pt-16 md:pb-32 md:pt-24">
      <div className="pointer-events-none absolute inset-0 [background:radial-gradient(circle_at_15%_25%,rgba(247,183,51,0.08),transparent_40%)]" />
      <div className="relative mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[1.05fr_.95fr]">
        <motion.div initial={reduce ? undefined : { opacity: 0, y: 16 }} animate={reduce ? undefined : { opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: "easeOut" }}>
          <h1 className="max-w-xl text-[clamp(2.5rem,5vw,4.25rem)] font-black leading-[1.05] tracking-tight">
            Keep every phase inside its light.
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-8 text-metal-300">
            LPMAS watches the illumination range and the dark ceiling for every greenhouse phase, and tells your team the moment either one drifts.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link href="/login" className="inline-flex items-center gap-2 rounded-full bg-leaf-500 px-7 py-3.5 font-semibold text-ink transition hover:bg-leaf-100 active:scale-[0.98]">
              Sign in <ArrowRight size={18} />
            </Link>
            <Link href="/monitor" className="rounded-full border border-metal-600 px-7 py-3.5 font-semibold transition hover:bg-white/5 active:scale-[0.98]">
              View live data
            </Link>
          </div>
        </motion.div>

        <motion.div initial={reduce ? undefined : { opacity: 0, scale: 0.95 }} animate={reduce ? undefined : { opacity: 1, scale: 1 }} transition={{ duration: 0.7, ease: "easeOut", delay: 0.15 }}>
          <LuxGauge />
        </motion.div>
      </div>
    </section>

    <section id="features" className="mx-auto max-w-6xl px-5 py-24 md:py-32">
      <h2 className="max-w-xl text-3xl font-bold tracking-tight md:text-4xl">Everything in one system</h2>
      <p className="mt-4 max-w-lg leading-7 text-metal-400">Crop phases, live sensor data, alerts and incident history in one place.</p>
      <div className="mt-12 grid gap-4 md:grid-cols-2">
        {features.map(f => <motion.article
          key={f.title}
          {...fade}
          whileHover={reduce ? undefined : { y: -3 }}
          className={`rounded-2xl border border-metal-700 bg-metal-800/60 p-6 ${f.wide ? "md:col-span-2" : ""}`}
        >
          <div className={f.wide ? "flex items-start gap-6" : ""}>
            <span className="inline-flex rounded-xl bg-leaf-500/10 p-3 text-leaf-500">{f.icon}</span>
            <div className={f.wide ? "flex-1" : ""}>
              <h3 className="mt-6 text-lg font-bold sm:mt-0 sm:mt-6">{f.title}</h3>
              <p className="mt-2 leading-7 text-metal-400">{f.text}</p>
            </div>
          </div>
        </motion.article>)}
      </div>
    </section>

    <section id="how-it-works" className="border-t border-metal-700 px-5 py-24 md:py-32">
      <div className="mx-auto max-w-6xl">
        <h2 className="max-w-xl text-3xl font-bold tracking-tight md:text-4xl">From reading to response</h2>
        <div className="mt-12 grid gap-8 md:grid-cols-3">
          {pipeline.map((step, i) => <motion.div key={step.title} {...fade} transition={{ ...fade.transition, delay: i * 0.1 }}>
            <span className="font-mono text-sm text-leaf-500">{String(i + 1).padStart(2, "0")}</span>
            <h3 className="mt-3 text-xl font-bold">{step.title}</h3>
            <p className="mt-2 leading-7 text-metal-400">{step.text}</p>
          </motion.div>)}
        </div>
      </div>
    </section>

    <section className="border-t border-metal-700 px-5 py-16">
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 md:grid-cols-4">
        {stats.map(s => <div key={s.label}>
          <p className="font-mono text-3xl font-bold text-leaf-500 md:text-4xl">{s.value}</p>
          <p className="mt-2 text-sm text-metal-400">{s.label}</p>
        </div>)}
      </div>
    </section>

    <section id="about" className="mx-auto max-w-6xl px-5 py-24 md:py-32">
      <div className="overflow-hidden rounded-3xl border border-metal-700 bg-gradient-to-br from-leaf-900 to-ink px-8 py-14 md:px-16">
        <div className="grid items-center gap-10 md:grid-cols-[1fr_auto]">
          <div>
            <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Ready for the next crop cycle.</h2>
            <p className="mt-4 max-w-lg leading-7 text-metal-400">Piloting on one greenhouse now, ready to scale across all eighteen as devices are added.</p>
          </div>
          <Link href="/login" className="inline-flex items-center justify-center gap-2 rounded-full bg-leaf-500 px-7 py-3.5 font-semibold text-ink transition hover:bg-leaf-100 active:scale-[0.98]">
            Sign in <ArrowRight size={18} />
          </Link>
        </div>
      </div>
    </section>

    <footer className="border-t border-metal-700 px-5 py-8">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 text-sm text-metal-500">
        <div className="flex items-center gap-2 font-semibold text-metal-50">
          <img src="/Hayag-logo.png" alt="" className="h-5 w-5 object-contain" /> LPMAS
        </div>
        <p>Light Pollution Monitoring and Alert System</p>
      </div>
    </footer>
  </main>;
}