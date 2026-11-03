import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import PwaBootstrap from "@/components/pwa/PwaBootstrap";

// Font files live in the repo (Google Fonts, latin subset, variable weight).
// next/font/google fetches them at build time, and that fetch broke Vercel
// builds on 2026-11-03 with nothing changed on our side.
const inter = localFont({
  src: "./fonts/inter-latin.woff2",
  weight: "100 900",
  variable: "--font-sans",
  display: "swap",
});

const notoSerif = localFont({
  src: "./fonts/noto-serif-latin.woff2",
  weight: "100 900",
  variable: "--font-serif",
  display: "swap",
});

const publicSans = localFont({
  src: "./fonts/public-sans-latin.woff2",
  weight: "100 900",
  variable: "--font-label",
  display: "swap",
});

export const metadata: Metadata = {
  title: "SiteFlow | Premium Construction Management & Operations Portal",
  description: "Next-generation site tracking, resource coordination, and real-time ledger sync.",
  manifest: "/manifest.json",
  applicationName: "SiteFlow",
  appleWebApp: {
    capable: true,
    title: "SiteFlow",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#E8184C",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${notoSerif.variable} ${publicSans.variable} h-full antialiased`}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("theme");if(t==="light"||(!t&&window.matchMedia("(prefers-color-scheme: light)").matches)){document.documentElement.classList.add("light-theme");}}catch(e){}})()`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground font-sans">
        {children}
        <PwaBootstrap />
      </body>
    </html>
  );
}

// Trigger Vercel rebuild for Render backend URL updated
