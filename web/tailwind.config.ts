import type { Config } from "tailwindcss";
export default {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Inter is self-hosted via @fontsource (see app/layout.tsx) — the closest
        // professional, widely-available match to Helvetica's proportions/x-height,
        // with far more reliable rendering than shipping "Helvetica Neue" as a bare
        // system-font name and hoping the OS has it.
        sans: ["Inter", "Helvetica Neue", "Helvetica", "Arial", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
      },
      colors: {
        // Metallic dark / gunmetal base — replaces the old navy "ink"
        ink: "#0a0a0b",

        // Graphite / brushed-steel scale used for surfaces, borders, and de-emphasized text
        metal: {
          50:  "#f4f5f6",
          100: "#e3e4e7",
          200: "#c6c8cd",
          300: "#9a9da4",
          400: "#6f7278",
          500: "#4d4f55",
          600: "#34363b",
          700: "#232427",
          800: "#18191b",
          900: "#0e0f10"
        },

        // Brand accent — brushed gold/amber (Hayag = "glow"), kept but slightly
        // desaturated for a more restrained, professional feel against the metal palette
        leaf: {
          50:  "#f6ecd8",
          100: "#ecdcb3",
          500: "#d9a441",
          600: "#b9842c",
          700: "#8f631f",
          900: "#171208"   // deep bronze-black, used for sidebar/login panels
        }
      },
      backgroundImage: {
        // subtle brushed-metal sheen for panels/sidebars
        "metal-sheen": "linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0) 14%, rgba(255,255,255,0) 86%, rgba(0,0,0,0.25) 100%)"
      },
      boxShadow: {
        soft: "0 18px 45px rgba(0, 0, 0, .45)",
        glow: "0 0 24px rgba(217, 164, 65, .35)",       // gold glow, dialed back from the old bright version
        metal: "inset 0 1px 0 rgba(255,255,255,.06), 0 1px 0 rgba(0,0,0,.4)"
      }
    }
  },
  plugins: []
} satisfies Config;
