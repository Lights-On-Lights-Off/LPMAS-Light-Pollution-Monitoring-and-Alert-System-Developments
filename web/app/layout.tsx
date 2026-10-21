import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";

const inter = localFont({
  src: [
    { path: "../../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2", weight: "400" },
    { path: "../../node_modules/@fontsource/inter/files/inter-latin-500-normal.woff2", weight: "500" },
    { path: "../../node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2", weight: "600" },
    { path: "../../node_modules/@fontsource/inter/files/inter-latin-700-normal.woff2", weight: "700" }
  ],
  variable: "--font-inter",
  display: "swap"
});

const mono = localFont({
  src: "../../node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2",
  variable: "--font-mono",
  display: "swap",
  preload: false
});

export const metadata: Metadata = {
  title: "LPMAS | Greenhouse Light Monitoring",
  description: "Light pollution and intrusion monitoring for controlled-environment horticulture",
  icons: {
    icon: { url: "/Hayag-logo.png", type: "image/png", sizes: "567x567" },
    apple: "/Hayag-logo.png"
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={`${inter.variable} ${mono.variable}`}>
    <body><ThemeProvider>{children}</ThemeProvider></body>
  </html>;
}