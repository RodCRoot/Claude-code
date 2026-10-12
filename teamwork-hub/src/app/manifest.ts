import type { MetadataRoute } from "next";

/**
 * Web app manifest: lets athletes "Add to Home Screen" and open straight into today's workout.
 * Offline support comes from the training service worker (scope /training/today only).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/training/today",
    name: "Teamwork Hub — Training",
    short_name: "Teamwork",
    description: "Log today's training at Teamwork Bloomington, even with a weak gym signal.",
    start_url: "/training/today",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#1d4ed8",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
