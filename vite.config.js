import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { sentryVitePlugin } from "@sentry/vite-plugin";

export default defineConfig({
  plugins: [
    react(),
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      disable: !process.env.SENTRY_AUTH_TOKEN,  // skip silently if not configured
    }),
    VitePWA({
      registerType: "autoUpdate",
      workbox: {
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.open-meteo\.com\//,
            handler: "NetworkOnly",
          },
          {
            urlPattern: /^https:\/\/nominatim\.openstreetmap\.org\//,
            handler: "NetworkOnly",
          },
        ],
      },
      manifest: {
        name: "Fuel Planner",
        short_name: "Fuel",
        description: "Science-based race nutrition planner for road, trail & ultra",
        theme_color: "#0c140b",
        background_color: "#090f09",
        display: "standalone",
        start_url: "/trail-fuel-planner/",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
    }),
  ],
  base: "/trail-fuel-planner/",
  build: {
    sourcemap: "hidden",  // generates source maps but doesn't link them in output (Sentry uploads them)
  },
});
