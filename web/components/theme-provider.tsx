"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_SURFACE_STYLE, DEFAULT_THEME_MODE, DEFAULT_THEME_PALETTE, type SurfaceStyle, type ThemeMode, type ThemePalette } from "@/lib/theme";

type ThemeContextValue = {
  mode: ThemeMode;
  palette: ThemePalette;
  surfaceStyle: SurfaceStyle;
  setMode: (mode: ThemeMode) => void;
  setPalette: (palette: ThemePalette) => void;
  setSurfaceStyle: (surfaceStyle: SurfaceStyle) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(DEFAULT_THEME_MODE);
  const [palette, setPaletteState] = useState<ThemePalette>(DEFAULT_THEME_PALETTE);
  const [surfaceStyle, setSurfaceStyleState] = useState<SurfaceStyle>(DEFAULT_SURFACE_STYLE);

  useEffect(() => {
    const savedMode = localStorage.getItem("lpmas-theme-mode") as ThemeMode | null;
    const savedPalette = localStorage.getItem("lpmas-theme-palette") as ThemePalette | null;
    const savedSurfaceStyle = localStorage.getItem("lpmas-surface-style") as SurfaceStyle | null;
    if (savedMode === "light" || savedMode === "dark" || savedMode === "system") setModeState(savedMode);
    if (savedPalette) setPaletteState(savedPalette);
    if (savedSurfaceStyle === "clay" || savedSurfaceStyle === "glass") setSurfaceStyleState(savedSurfaceStyle);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const resolvedMode = mode === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
    root.dataset.theme = resolvedMode;
    root.dataset.palette = palette;
    root.dataset.surface = surfaceStyle;
    localStorage.setItem("lpmas-theme-mode", mode);
    localStorage.setItem("lpmas-theme-palette", palette);
    localStorage.setItem("lpmas-surface-style", surfaceStyle);
  }, [mode, palette, surfaceStyle]);

  useEffect(() => {
    if (mode !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => { document.documentElement.dataset.theme = media.matches ? "dark" : "light"; };
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, [mode]);

  function setMode(value: ThemeMode) {
    setModeState(value);
  }

  function setPalette(value: ThemePalette) {
    setPaletteState(value);
  }

  function setSurfaceStyle(value: SurfaceStyle) {
    setSurfaceStyleState(value);
  }

  return <ThemeContext.Provider value={{ mode, palette, surfaceStyle, setMode, setPalette, setSurfaceStyle }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}