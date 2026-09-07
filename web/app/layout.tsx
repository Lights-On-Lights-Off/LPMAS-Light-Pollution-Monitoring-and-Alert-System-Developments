import type { Metadata } from "next";

// Self-hosted via @fontsource — no runtime/build-time fetch to Google's CDN,
// which is more reliable for CI/sandboxed builds and avoids an external
// dependency in production. Weights match what's actually used in the app
// (400/500 body, 600/700 semibold/bold, 800/900 for the landing hero).
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
import "@fontsource/inter/900.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";

import "./globals.css";

export const metadata: Metadata = {
  title: "LPMAS | Greenhouse Light Monitoring",
  description: "Light pollution and intrusion monitoring for controlled-environment horticulture"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en">
    <body>{children}</body>
  </html>;
}
