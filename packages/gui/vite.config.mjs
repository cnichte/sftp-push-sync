import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// packages/gui/vite.config.mjs
export default defineConfig({
  plugins: [react()],
  base: "./", // relative asset paths so the built app loads via file:// in Electron
  build: {
    outDir: "dist",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
