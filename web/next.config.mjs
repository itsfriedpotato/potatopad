/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Next.js 16 builds with Turbopack by default. An empty turbopack config is
  // enough here: wagmi/RainbowKit's optional Node-only deps (pino-pretty,
  // lokijs, encoding, @react-native-async-storage) resolve fine without the
  // webpack externals the previous config needed.
  turbopack: {},
};

export default nextConfig;
