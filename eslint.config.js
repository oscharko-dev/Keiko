// Flat ESLint config. typescript-eslint strict + type-checked. Zero-warning policy enforced via --max-warnings=0.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**", "ui/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      complexity: ["error", 10],
      "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true }],
      "no-console": "warn",
    },
  },
  { files: ["**/*.test.ts"], rules: { "max-lines-per-function": "off" } },
  { files: ["**/*.js"], ...tseslint.configs.disableTypeChecked },
  // Build tooling under scripts/ is Node ESM outside the TypeScript program: disable type-aware
  // rules and permit console output (these scripts report build progress on stdout).
  { files: ["scripts/**/*.mjs"], ...tseslint.configs.disableTypeChecked },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
    rules: {
      "no-console": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
  prettier,
);
