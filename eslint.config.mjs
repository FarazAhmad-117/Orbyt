import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Covers packages/* and apps/api. apps/web has its own Next.js config (eslint-config-next).
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "apps/web/**",
      "packages/db/drizzle/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
