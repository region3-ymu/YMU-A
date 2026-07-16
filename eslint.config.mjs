import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Supabase Edge Functions are Deno modules (including npm:/ URL imports),
    // not Next.js application code. They are bundled/checked by the Supabase
    // CLI when served or deployed, rather than by Next's ESLint config.
    "supabase/functions/**",
  ]),
]);

export default eslintConfig;
