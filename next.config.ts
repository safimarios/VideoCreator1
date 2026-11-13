import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // cacheComponents غير متوافق مع export const runtime/dynamic المطلوبة في المواصفة
  // (خادم MCP يحتاج force-dynamic حتميًا) — لذلك نعطّلها
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
