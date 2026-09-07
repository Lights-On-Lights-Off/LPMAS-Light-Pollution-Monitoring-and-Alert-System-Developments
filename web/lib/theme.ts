export type ThemeMode = "light" | "dark" | "system";
export type ThemePalette = "default" | "lavender" | "dune" | "rosegold" | "forest-dew" | "mountain-sunset" | "crimson" | "mint" | "orange" | "bright-pink" | "veronica" | "tree-frog" | "ying-yang";

export const THEME_MODES: { id: ThemeMode; name: string }[] = [
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
  { id: "system", name: "System" }
];

export const THEME_PALETTES: { id: ThemePalette; name: string; color: string }[] = [
  { id: "default", name: "Blue", color: "#2677d9" },
  { id: "lavender", name: "Lavender", color: "#806bd4" },
  { id: "dune", name: "Dune", color: "#9c856c" },
  { id: "rosegold", name: "Rose Gold", color: "#c67870" },
  { id: "forest-dew", name: "Forest Dew", color: "#4b9876" },
  { id: "mountain-sunset", name: "Mountain Sunset", color: "#b65e73" },
  { id: "crimson", name: "Crimson", color: "#c83f5a" },
  { id: "mint", name: "Mint", color: "#4da98c" },
  { id: "orange", name: "Orange", color: "#d18b32" },
  { id: "bright-pink", name: "Bright Pink", color: "#d63b91" },
  { id: "veronica", name: "Veronica", color: "#8745c7" },
  { id: "tree-frog", name: "Tree Frog", color: "#6c9d35" },
  { id: "ying-yang", name: "Ying Yang", color: "#747b84" }
];

export const DEFAULT_THEME_MODE: ThemeMode = "light";
export const DEFAULT_THEME_PALETTE: ThemePalette = "default";