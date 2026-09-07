"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DEFAULT_THEME_MODE, DEFAULT_THEME_PALETTE, type ThemeMode, type ThemePalette } from "@/lib/theme";

type ThemeContextValue = {
  mode: ThemeMode;
  palette: ThemePalette;
  setMode: (mode: ThemeMode) => void;
  setPalette: (palette: ThemePalette) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(DEFAULT_THEME_MODE);
  const [palette, setPaletteState] = useState<ThemePalette>(DEFAULT_THEME_PALETTE);

  useEffect(() => {
    const savedMode = localStorage.getItem("lpmas-theme-mode") as ThemeMode | null;
    const savedPalette = localStorage.getItem("lpmas-theme-palette") as ThemePalette | null;
    if (savedMode === "light" || savedMode === "dark" || savedMode === "system") setModeState(savedMode);
    if (savedPalette) setPaletteState(savedPalette);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const resolvedMode = mode === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
    root.dataset.theme = resolvedMode;
    root.dataset.palette = palette;
    localStorage.setItem("lpmas-theme-mode", mode);
    localStorage.setItem("lpmas-theme-palette", palette);
  }, [mode, palette]);

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

  return <ThemeContext.Provider value={{ mode, palette, setMode, setPalette }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}