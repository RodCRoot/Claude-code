import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/binary packages the server loads at runtime — kept out of the bundle.
  serverExternalPackages: ["better-sqlite3", "playwright"],
};

export default nextConfig;
