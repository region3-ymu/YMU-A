import { SerwistProvider } from "@serwist/turbopack/react";
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import InstallPrompt from "@/components/install-prompt";
import SwUpdatePrompt from "@/components/sw-update-prompt";
import "./globals.css";

// Sets data-theme on <html> before hydration, straight from localStorage —
// avoids a flash of the wrong theme and a hydration mismatch (this attribute
// is never written by React itself, so there's nothing for React to
// reconcile against). beforeInteractive scripts must live in the root
// layout; see src/app/(app)/settings/dark-mode-toggle.tsx for the write side.
const THEME_INIT_SCRIPT = `
try {
  var t = localStorage.getItem("ymu-a-theme");
  if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
`;

// Inter is the Stitch design system's sole typeface (see the export's
// DESIGN.md). Self-hosted via next/font so it still works offline in the PWA.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  applicationName: "YMU-A",
  title: {
    default: "YMU-A — YMU Attendance",
    template: "%s | YMU-A",
  },
  description:
    "Clock-in/clock-out attendance app for Young Musicians Unite teachers.",
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "YMU-A",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: "#4648d4",
  width: "device-width",
  initialScale: 1,
  // The app is used at arm's length while walking to a school; keep pinch-zoom
  // available for accessibility (no userScalable: false).
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} h-full antialiased`}
    >
      <head>
        {/* Material Symbols — the Stitch design's icon set. Loaded as a
            stylesheet link (not a metadata field); degrades to the ligature
            text name if unavailable offline. */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block"
        />
      </head>
      <body className="min-h-full flex flex-col bg-background text-on-surface">
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
        <SerwistProvider swUrl="/serwist/sw.js">
          {children}
          <SwUpdatePrompt />
        </SerwistProvider>
        <InstallPrompt />
      </body>
    </html>
  );
}
