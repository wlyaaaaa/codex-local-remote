import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: 18792,
    proxy: {
      "/api": "http://127.0.0.1:39393",
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
