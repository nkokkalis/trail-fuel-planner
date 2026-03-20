import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
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
});
