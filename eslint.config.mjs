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
    // Gitignored Trigger.dev local build artifacts + dev state (never our code to lint).
    ".trigger/**",
    // Gitignored, vendored design mirror (kept verbatim; not our code to lint).
    ".claude/design-spec/**",
  ]),
]);

export default eslintConfig;
