import type { MetadataRoute } from "next";

const BASE = "https://potato.fm";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/api/" },
    sitemap: `${BASE}/sitemap.xml`,
    host: BASE,
  };
}
