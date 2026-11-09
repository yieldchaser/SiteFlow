import type { NextConfig } from "next";

// Backend API + Supabase Storage hosts the browser must be allowed to reach.
// Keep in sync with src/lib/api.ts (getApiHost) and the Supabase project URL.
const API_HOST = "https://construction-erp-backend-73vm.onrender.com";
const SUPABASE_HOSTS = "https://*.supabase.co";

// Content-Security-Policy. Shipped in Report-Only mode first (see headers below)
// so it cannot break the live app while we watch for violations; promote it to
// the enforcing `Content-Security-Policy` header once reports are clean.
// Notes:
// - 'unsafe-inline' for styles is required by Next.js injected styles and the
//   app's inline style usage (aurora/theme work).
// - script-src keeps 'unsafe-inline' for Next's hydration bootstrap; add
//   'unsafe-eval' only if a client library actually needs it.
// - img-src allows https:, data: and blob: so Supabase Storage images, inline
//   data URIs, and camera-captured blobs (face recognition) all load.
// Firebase Phone Auth (see src/lib/firebase.ts, app/login/page.tsx) loads the
// reCAPTCHA challenge from Google and calls the Identity Toolkit / Secure Token
// APIs directly from the browser. These hosts are required for that flow only;
// nothing else in the app needs them.
const RECAPTCHA_SCRIPT_HOSTS = "https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/";
const RECAPTCHA_FRAME_HOSTS = "https://www.google.com/recaptcha/";
const FIREBASE_CONNECT_HOSTS = "https://identitytoolkit.googleapis.com https://securetoken.googleapis.com";

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline' ${RECAPTCHA_SCRIPT_HOSTS}`,
  `script-src-elem 'self' 'unsafe-inline' ${RECAPTCHA_SCRIPT_HOSTS}`,
  // blob: lets a PDF fetched with the login token show inline (client
  // report preview); the API host itself never needs to be framed.
  `frame-src 'self' blob: ${RECAPTCHA_FRAME_HOSTS}`,
  `connect-src 'self' ${API_HOST} ${SUPABASE_HOSTS} ${FIREBASE_CONNECT_HOSTS}`,
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
].join("; ");

const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // Enforced clickjacking protection even while CSP is report-only.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // The PWA genuinely needs geolocation (geofenced attendance) and camera
    // (face-recognition punch). Scope those to same-origin, deny the rest.
    key: "Permissions-Policy",
    value: "geolocation=(self), camera=(self), microphone=(), payment=(), usb=(), browsing-topics=()",
  },
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy,
  },
];

const nextConfig: NextConfig = {
  images: {
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 31536000,
  },
  turbopack: {},
  experimental: {
    // Consolidate CSS chunks to prevent Next.js from emitting separate <link rel="preload" as="style">
    // tags for unused component CSS chunks on initial page load, resolving Chrome DevTools preload warnings.
    cssChunking: "strict",
  },
  webpack(config, { isServer }) {
    if (!isServer) {
      // Merge client CSS chunks into primary stylesheets rather than loose fragments
      config.optimization = config.optimization || {};
      config.optimization.splitChunks = config.optimization.splitChunks || {};
      config.optimization.splitChunks.cacheGroups = {
        ...config.optimization.splitChunks.cacheGroups,
        styles: {
          name: "styles",
          type: "css/mini-extract",
          chunks: "all",
          enforce: true,
        },
      };
    }
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
