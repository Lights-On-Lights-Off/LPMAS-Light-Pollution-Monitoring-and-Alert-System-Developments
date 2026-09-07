import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";

const everett = localFont({
  src: "../public/fonts/Everett Regular/Everett Regular.woff2",
  variable: "--font-everett",
  display: "swap"
});

const helvetica = localFont({
  src: "../public/fonts/Helvetica/Helvetica.woff2",
  variable: "--font-helvetica",
  display: "swap"
});

export const metadata: Metadata = {
  title: "LPMAS | Greenhouse Light Monitoring",
  description: "Light pollution and intrusion monitoring for controlled-environment horticulture"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={`${everett.variable} ${helvetica.variable}`}>
    <body><ThemeProvider>{children}</ThemeProvider></body>
  </html>;
}