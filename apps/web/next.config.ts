import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Not using cacheComponents/partialPrefetching: the signed-in app is client-rendered per user, so
  // static prerendering buys nothing and would force <Suspense> around every runtime hook.
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
