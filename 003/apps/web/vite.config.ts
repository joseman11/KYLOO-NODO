import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// En desarrollo, /api y /ws se reenvían al servidor local 003
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      "/api": "http://localhost:3003",
      "/ws": { target: "ws://localhost:3003", ws: true },
    },
  },
});
