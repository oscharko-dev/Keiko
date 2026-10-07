import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      complexity: ["error", 10],
      "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true }],
      "no-console": "off",
    },
  },
  {
    files: ["src/**/*.test.ts"],
    rules: {
      "max-lines-per-function": "off",
      // node:test's test() returns a promise the runner awaits itself.
      "@typescript-eslint/no-floating-promises": [
        "error",
        { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "describe", "it"] }] },
      ],
    },
  },
  { files: ["eslint.config.mjs"], extends: [tseslint.configs.disableTypeChecked] },
);
