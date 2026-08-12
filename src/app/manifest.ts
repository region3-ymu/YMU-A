import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "YMU-A — YMU Attendance",
    short_name: "YMU-A",
    description:
      "Clock-in/clock-out attendance app for Young Musicians Unite teachers.",
    id: "/",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    // YMU's own palette (ymu.org/branding): cream behind the splash, brand
    // blue in the browser chrome.
    background_color: "#faf6eb",
    theme_color: "#3a65eb",
    icons: [
      // `any` and `maskable` are DIFFERENT ARTWORK, not the same file listed
      // twice — which is what this was until the real branding landed.
      // Launchers crop a maskable icon to their own shape and only guarantee
      // the middle 80%, so pointing it at the square emblem meant Android was
      // slicing the corners off the logo. See scripts/generate-icons.mjs.
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
