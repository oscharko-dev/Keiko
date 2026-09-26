import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

const nextBase = nextCoreWebVitals[0];
const nextCore = nextCoreWebVitals[3];
const jsxA11y = nextBase.plugins["jsx-a11y"];
const reactHooks = nextBase.plugins["react-hooks"];
const nextPlugin = nextCore.plugins["@next/next"];
const { plugins: _jsxA11yPlugins, ...jsxA11yStrict } = jsxA11y.flatConfigs.strict;

const nextEslint10Config = {
  name: "next/eslint-10-compatible",
  files: nextBase.files,
  languageOptions: {
    globals: nextBase.languageOptions.globals,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      ecmaFeatures: { jsx: true },
    },
  },
  settings: nextBase.settings,
  plugins: {
    "react-hooks": reactHooks,
    "jsx-a11y": jsxA11y,
    "@next/next": nextPlugin,
  },
  rules: {
    ...Object.fromEntries(
      Object.entries(nextBase.rules).filter(
        ([rule]) => rule.startsWith("react-hooks/") || rule.startsWith("jsx-a11y/"),
      ),
    ),
    ...nextCore.rules,
  },
};

const next15HooksRules = {
  "react-hooks/rules-of-hooks": "error",
  "react-hooks/exhaustive-deps": "warn",
  "react-hooks/static-components": "off",
  "react-hooks/use-memo": "off",
  "react-hooks/preserve-manual-memoization": "off",
  "react-hooks/incompatible-library": "off",
  "react-hooks/immutability": "off",
  "react-hooks/globals": "off",
  "react-hooks/refs": "off",
  "react-hooks/set-state-in-effect": "off",
  "react-hooks/error-boundaries": "off",
  "react-hooks/purity": "off",
  "react-hooks/set-state-in-render": "off",
  "react-hooks/unsupported-syntax": "off",
  "react-hooks/config": "off",
  "react-hooks/gating": "off",
};

const config = [
  {
    ignores: [".next/**", "out/**", "node_modules/**"],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  nextEslint10Config,
  nextCoreWebVitals[1],
  nextCoreWebVitals[2],
  {
    rules: next15HooksRules,
  },
  {
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  // Audit KEIKO-0118: keiko-ui is ignored by the root config (eslint.config.js), so the repo's
  // complexity / function-length / explicit-return-type bar reached every package EXCEPT the
  // largest TSX surface in the product. The values below are the root config's, verbatim
  // (eslint.config.js: complexity 10, max-lines-per-function 50 skipping blanks and comments,
  // explicit-function-return-type) — keiko-editor is the precedent: a large React/TSX package held
  // to the full bar with no carve-out.
  // Scoped to TypeScript: `public/` ships hand-written browser assets (the AudioWorklet processor)
  // that no TS parser sees, and a TS-AST rule crashes outright on them.
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      complexity: ["error", 10],
      "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true }],
      "@typescript-eslint/explicit-function-return-type": "error",
    },
  },
  // Mirrors eslint.config.js: a describe() block legitimately groups many it() cases, so test files
  // are exempt from max-lines-per-function only — complexity and return types still apply.
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "max-lines-per-function": "off" },
  },
  jsxA11yStrict,
];

export default config;
