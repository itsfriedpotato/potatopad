import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PotatoPad — People's launchpad",
    short_name: "PotatoPad",
    description:
      "Launch a fixed-supply token straight into a permanently locked Uniswap V3 position.",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [{ src: "/logo.png", sizes: "any", type: "image/png" }],
  };
}
