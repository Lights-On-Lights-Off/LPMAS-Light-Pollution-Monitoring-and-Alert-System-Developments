"use client";

import { Check, Moon, Monitor, Palette, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { THEME_MODES, THEME_PALETTES } from "@/lib/theme";

const MODE_ICONS = {
  light: Sun,
  dark: Moon,
  system: Monitor
};

export function Appearance() {
  const { mode, palette, setMode, setPalette } = useTheme();
  const selectedPalette = THEME_PALETTES.find(item => item.id === palette) ?? THEME_PALETTES[0];

  return <div className="w-full p-5 md:p-6 lg:p-8">
    <div className="mx-auto max-w-5xl">
      <div className="mb-8">
        <p className="text-sm font-semibold text-[var(--accent)]">Appearance</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-primary">Customize your interface</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-secondary">Choose how LPMAS looks across the system. Your selections are saved automatically.</p>
      </div>

      <div className="space-y-6">
        <section className="glass-card rounded-2xl p-5 md:p-6">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
              <Sun size={19} />
            </div>
            <div>
              <h2 className="font-bold text-primary">Theme mode</h2>
              <p className="mt-1 text-sm text-secondary">Choose light, dark, or follow your system setting.</p>
            </div>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {THEME_MODES.map(item => {
              const Icon = MODE_ICONS[item.id];
              const selected = mode === item.id;

              return <button key={item.id} type="button" onClick={() => setMode(item.id)} className={`flex items-center gap-3 rounded-xl border p-4 text-left transition ${selected ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)] shadow-sm" : "border-[var(--surface-border)] bg-glass text-secondary hover:bg-glass-strong hover:text-primary"}`}>
                <Icon size={19} />
                <span className="flex-1 text-sm font-semibold">{item.name}</span>
                {selected && <Check size={17} />}
              </button>;
            })}
          </div>

          <div className="mt-4 rounded-xl border border-[var(--surface-border)] bg-glass px-4 py-3 text-xs text-secondary">
            {mode === "light" && "Light mode uses bg.png as the page background."}
            {mode === "dark" && "Dark mode uses bgd.png as the page background."}
            {mode === "system" && "System mode automatically follows your device preference."}
          </div>
        </section>

        <section className="glass-card rounded-2xl p-5 md:p-6">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
              <Palette size={19} />
            </div>
            <div>
              <h2 className="font-bold text-primary">Accent color</h2>
              <p className="mt-1 text-sm text-secondary">Choose the accent color used throughout the interface.</p>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {THEME_PALETTES.map(item => {
              const selected = palette === item.id;

              return <button key={item.id} type="button" onClick={() => setPalette(item.id)} className={`group flex items-center gap-3 rounded-xl border p-3 text-left transition ${selected ? "border-[var(--accent-border)] bg-[var(--accent-soft)] shadow-sm" : "border-[var(--surface-border)] bg-glass hover:bg-glass-strong"}`}>
                <span className="h-8 w-8 shrink-0 rounded-full shadow-sm ring-2 ring-white/70" style={{ backgroundColor: item.color }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-primary">{item.name}</span>
                </span>
                {selected && <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-white"><Check size={14} /></span>}
              </button>;
            })}
          </div>

          <div className="mt-6 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-soft)] p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="h-3 w-3 rounded-full ring-2 ring-white/70" style={{ backgroundColor: selectedPalette.color }} />
              <p className="text-sm text-secondary">Current accent: <span className="font-semibold text-[var(--accent)]">{selectedPalette.name}</span></p>
              <span className="ml-auto rounded-full bg-[var(--accent)] px-3 py-1 text-xs font-semibold text-white">Active</span>
            </div>
          </div>
        </section>

        <section className="glass-card-strong rounded-2xl p-5 md:p-6">
          <div>
            <h2 className="font-bold text-primary">Preview</h2>
            <p className="mt-1 text-sm text-secondary">Preview of the current Liquid Glass interface.</p>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-3">
            <div className="glass-card rounded-xl p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-secondary">KPI</p>
              <p className="mt-2 font-mono text-3xl font-bold text-primary">88.4</p>
              <p className="mt-1 text-sm text-secondary">Lux intensity</p>
            </div>

            <div className="glass-card-strong rounded-xl p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-secondary">Status</p>
              <div className="mt-3 inline-flex rounded-full bg-emerald-500/12 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-500/25">Safe</div>
            </div>

            <div className="glass-card rounded-xl p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-secondary">Accent</p>
              <button type="button" className="glass-button mt-3 rounded-full px-4 py-2 text-xs font-semibold">Active accent</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>;
}