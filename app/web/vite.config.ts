import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// The gateway (Hono) listens on 127.0.0.1:18789 (GATEWAY_PORT, src/config.ts).
// A tunnel to localhost:5173 must be added to allowedHosts below, so this
// dev server must proxy all API + WS traffic to the gateway to stay
// same-origin (cookie auth + zero CORS).
const GATEWAY = `http://127.0.0.1:${process.env.GATEWAY_PORT || 18789}`;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "AHI",
        short_name: "AHI",
        description: "AHI — the bridge between thought and action.",
        // Splash/titlebar = the 'ahi.' icon's own ground (#101b1a, as index.html's theme-color);
        // the runtime meta theme-color still tracks the live --bg token (src/theme.ts).
        theme_color: "#101b1a",
        background_color: "#101b1a",
        display: "standalone",
        // 11/03: one top bar — installed on the desktop, the window's own controls sit inline in
        // the app's top bar (Window Controls Overlay) instead of a separate title bar above it.
        display_override: ["window-controls-overlay", "standalone"],
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Never cache API responses — freshness over offline for chat data.
        navigateFallbackDenylist: [/^\/ui\//, /^\/app\//, /^\/api\//],
        // Web Push handlers (Step 8) ride on the generated SW — the file
        // lives in public/ so it deploys beside sw.js at the app root.
        importScripts: ["push-sw.js"],
      },
    }),
  ],
  // `vite preview` serves the production build with the same same-origin proxy (redesign preview
  // on the existing app-dev route). Started on 127.0.0.1 by redesign/preview/start-web.sh.
  preview: {
    port: 5173,
    strictPort: true,
    allowedHosts: ["localhost"],
    proxy: {
      "/ui": { target: GATEWAY, changeOrigin: false, ws: true },
      "/app": { target: GATEWAY, changeOrigin: false },
      "/api": { target: GATEWAY, changeOrigin: false },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: ["localhost"],
    proxy: {
      // Everything same-origin against the real gateway. (The 3d dev
      // sidecar is gone — cutover A3; the backend delta ships with this
      // branch, so a gateway built from it serves every endpoint.)
      "/ui": { target: GATEWAY, changeOrigin: false, ws: true },
      "/app": { target: GATEWAY, changeOrigin: false },
      "/api": { target: GATEWAY, changeOrigin: false },
    },
  },
});
