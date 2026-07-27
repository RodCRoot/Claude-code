import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy API calls to the Express server during dev.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
    },
  },
});
