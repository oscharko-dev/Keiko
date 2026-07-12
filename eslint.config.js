// Flat ESLint config. typescript-eslint strict + type-checked. Zero-warning policy enforced via --max-warnings=0.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

const sonarCompatibilityPlugin = {
  rules: {
    "no-fractional-numeric-separators": {
      meta: {
        messages: {
          forbidden:
            "Use scientific notation instead of separators in a fractional numeric literal.",
        },
        type: "problem",
      },
      create(context) {
        return {
          Literal(node) {
            const source = context.sourceCode.getText(node);
            if (typeof node.value === "number" && source.includes(".") && source.includes("_")) {
              context.report({ messageId: "forbidden", node });
            }
          },
        };
      },
    },
    "require-sort-comparator": {
      meta: {
        messages: { required: "sort() and toSorted() require an explicit comparator." },
        type: "problem",
      },
      create(context) {
        return {
          CallExpression(node) {
            const property = node.callee.type === "MemberExpression" ? node.callee.property : null;
            const method = property?.type === "Identifier" ? property.name : undefined;
            if ((method === "sort" || method === "toSorted") && node.arguments.length === 0) {
              context.report({ messageId: "required", node });
            }
          },
        };
      },
    },
  },
};

export default tseslint.config(
  {
    ignores: [
      ".stryker-tmp/**",
      "reports/mutation/**",
      "dist/**",
      "**/dist/**",
      "coverage/**",
      "node_modules/**",
      "packages/keiko-ui/**",
      "ui/**",
      ".claude/**",
      ".keiko/**",
      "sandbox/**",
      "only-for-internal-use/**",
      "Only for Internal Use/**",
      "tests/architecture/fixtures/**",
      // Standalone frontend test-generation fixture projects (Issue #1203): intentionally idiomatic
      // example code with uninstalled deps (React, Testing Library, Playwright), held as data — not
      // product code subject to the repo's strict typed rules. Excluded from build and test collection.
      "tests/fixtures/frontend-test-generation/**",
      // Design-system evidence reproduction harnesses (e.g. the #1293 computed-value equivalence
      // harness): standalone Node + Playwright scripts that mix Node and in-browser (page.evaluate)
      // globals and live outside any TypeScript program. They are committed evidence/repro artifacts,
      // not product code, so they are excluded from the strict typed lint (like the fixtures above).
      "docs/design-system/evidence/**/*.mjs",
      // Real-subprocess LSP test fixture (Issue #1381): a standalone Node `.mjs` script spawned as an
      // external language-server child in integration tests. It lives outside any TypeScript program
      // (it is executed, not imported), so it is excluded from the strict typed lint like the
      // evidence harnesses above — not product code.
      "packages/keiko-server/src/editor/lsp/testing/*.mjs",
    ],
  },
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
  {
    files: ["eslint.config.js"],
    rules: { "@typescript-eslint/explicit-function-return-type": "off" },
  },
  // The keiko-editor package's build tsconfig (tsconfig.json) excludes test files and the jsdom
  // setup so they never reach dist. Point the typed-lint parser at the package's lint-only project
  // (tsconfig.eslint.json) for those files so the React component suites and the setup are still
  // fully type-checked under strict-type-checked.
  {
    files: [
      "packages/keiko-editor/src/**/*.{ts,tsx}",
      "packages/keiko-editor/vitest.config.ts",
      "packages/keiko-editor/vitest.setup.ts",
    ],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ["packages/keiko-editor/tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Test files are exempt from max-lines-per-function: describe() blocks legitimately group many
  // it() cases. Covers both TypeScript suites and the .mjs harnesses for the Node build/gate scripts
  // (e.g. scripts/__tests__/*.test.mjs, which test the .mjs supply-chain and package-surface gates).
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.test.mjs"],
    rules: { "max-lines-per-function": "off" },
  },
  { files: ["**/*.{js,cjs}"], ...tseslint.configs.disableTypeChecked },
  {
    files: ["design-system/**/*.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        getComputedStyle: "readonly",
        localStorage: "readonly",
        location: "readonly",
        window: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off",
      "max-lines-per-function": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      globals: {
        module: "readonly",
        require: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
  },
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
  {
    files: ["scripts/banking-quality-gate-worker.mjs"],
    languageOptions: {
      globals: {
        Response: "readonly",
        TextEncoder: "readonly",
        atob: "readonly",
        btoa: "readonly",
        crypto: "readonly",
        fetch: "readonly",
      },
    },
  },
  {
    files: ["scripts/__tests__/banking-quality-gate-worker.test.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        Request: "readonly",
        Response: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    files: [
      "scripts/check-lcov-source-mapping.mjs",
      "scripts/check-mutation-quality.mjs",
      "scripts/check-mutation-scope.mjs",
      "scripts/check-sonar-pr-quality-gate.mjs",
      "scripts/banking-quality-gate-core.mjs",
      "scripts/banking-quality-gate-worker.mjs",
    ],
    plugins: { "keiko-sonar": sonarCompatibilityPlugin },
    rules: {
      "keiko-sonar/no-fractional-numeric-separators": "error",
      "keiko-sonar/require-sort-comparator": "error",
      "no-restricted-syntax": [
        "error",
        {
          message: "Use non-mutating toSorted() with an explicit comparator.",
          selector: "CallExpression[callee.property.name='sort']",
        },
      ],
    },
  },
  {
    files: ["tests/e2e/fixtures/*.js"],
    languageOptions: { globals: { Buffer: "readonly", process: "readonly" } },
    rules: { "@typescript-eslint/explicit-function-return-type": "off" },
  },
  // Standalone Node ESM helpers spawned directly by Playwright webServer (e.g. the deterministic
  // model mock) live outside the TypeScript program: disable type-aware rules and permit console.
  { files: ["tests/e2e/support/**/*.mjs"], ...tseslint.configs.disableTypeChecked },
  {
    files: ["tests/e2e/support/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", URL: "readonly", Buffer: "readonly" },
    },
    rules: {
      "no-console": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
  prettier,
);
