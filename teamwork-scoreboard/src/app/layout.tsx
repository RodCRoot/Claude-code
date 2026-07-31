import type { Metadata } from "next";
// Self-hosted Geist (bundled in the `geist` package) — no build-time network
// fetch, so builds work offline and inside Docker.
import { GeistSans, GeistMono } from "geist/font";
import "./globals.css";

const geistSans = GeistSans;
const geistMono = GeistMono;

export const metadata: Metadata = {
  title: {
    default: "Teamwork Bloomington — Scoreboard",
    template: "%s · Teamwork Scoreboard",
  },
  description:
    "Business scoreboard and accountability command center for Teamwork Bloomington.",
};

const themeInit = `
try {
  const t = localStorage.getItem("tb-theme");
  if (t === "dark" || (!t && matchMedia("(prefers-color-scheme: dark)").matches)) {
    document.documentElement.classList.add("dark");
  }
} catch {}
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
