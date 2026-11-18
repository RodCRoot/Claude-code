import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Teamwork Hub", template: "%s · Teamwork Hub" },
  description: "Teamwork Bloomington — scheduling, training, sports science, and family portal.",
  // Home-screen install (manifest from app/manifest.ts; iOS uses these).
  appleWebApp: { capable: true, title: "Teamwork", statusBarStyle: "default" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1d4ed8",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Every page renders per request so Next.js can attach this request's CSP nonce (src/proxy.ts)
  // to its scripts; a prerendered page would carry no nonce and be blocked.
  await connection();
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} h-full`}>
      <body className="min-h-full">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
