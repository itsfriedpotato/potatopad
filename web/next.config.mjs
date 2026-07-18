/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Next.js 16 builds with Turbopack by default. An empty turbopack config is
  // enough here: wagmi/RainbowKit's optional Node-only deps (pino-pretty,
  // lokijs, encoding, @react-native-async-storage) resolve fine without the
  // webpack externals the previous config needed.
  turbopack: {},
  // Baseline security headers. CSP is intentionally omitted here — a wallet dApp's
  // CSP has to allow-list every RPC/IPFS/WalletConnect/GA origin and is easy to get
  // wrong, so it's left for a dedicated pass; these headers are the safe wins.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" }, // anti-clickjacking on the sign/approve UI
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
