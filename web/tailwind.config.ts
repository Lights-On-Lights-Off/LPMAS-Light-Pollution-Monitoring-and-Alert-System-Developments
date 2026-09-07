import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "Helvetica Neue", "Helvetica", "Arial", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
      },
      colors: {
        ink: "var(--theme-background)",
        metal: {
          50: "var(--theme-text)",
          100: "var(--theme-text-secondary)",
          200: "#c6c8cd",
          300: "var(--theme-text-secondary)",
          400: "var(--theme-text-muted)",
          500: "var(--theme-text-subtle)",
          600: "var(--theme-border)",
          700: "var(--theme-border)",
          800: "var(--theme-surface)",
          900: "var(--theme-surface-secondary)"
        },
        leaf: {
          50: "var(--theme-accent-soft)",
          100: "var(--theme-accent-soft)",
          500: "var(--theme-accent)",
          600: "var(--theme-accent-hover)",
          700: "var(--theme-accent-hover)",
          900: "var(--theme-surface-secondary)"
        },
        theme: {
          background: "var(--theme-background)",
          surface: "var(--theme-surface)",
          secondary: "var(--theme-surface-secondary)",
          hover: "var(--theme-surface-hover)",
          border: "var(--theme-border)",
          text: "var(--theme-text)",
          "secondary-text": "var(--theme-text-secondary)",
          muted: "var(--theme-text-muted)",
          subtle: "var(--theme-text-subtle)",
          accent: "var(--theme-accent)",
          "accent-hover": "var(--theme-accent-hover)",
          "accent-soft": "var(--theme-accent-soft)",
          "accent-border": "var(--theme-accent-border)",
          "accent-foreground": "var(--theme-accent-foreground)",
          success: "var(--theme-success)",
          warning: "var(--theme-warning)",
          danger: "var(--theme-danger)",
          info: "var(--theme-info)",
        }
      },
      backgroundImage: {
        "metal-sheen": "linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0) 14%, rgba(255,255,255,0) 86%, rgba(0,0,0,0.25) 100%)"
      },
      boxShadow: {
        soft: "0 18px 45px var(--theme-shadow)",
        glow: "0 0 24px var(--theme-accent-shadow)",
        metal: "inset 0 1px 0 rgba(255,255,255,.06), 0 1px 0 rgba(0,0,0,.4)"
      }
    }
  },
  plugins: []
} satisfies Config;