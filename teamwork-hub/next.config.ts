import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Completed-form PDFs embed these fonts (src/lib/pdf/fonts.ts reads them at runtime).
  outputFileTracingIncludes: {
    "/documents/**": ["./assets/fonts/*.ttf"],
  },
};

export default nextConfig;
