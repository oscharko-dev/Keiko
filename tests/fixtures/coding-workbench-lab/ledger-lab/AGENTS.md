# Agent rules for ledger-lab

- Node.js 24 runs the TypeScript sources directly (type stripping). Use erasable syntax only:
  no `enum`, no `namespace`, no constructor parameter properties, and import types with
  `import type` or inline `type` modifiers. Relative imports keep the `.ts` extension.
- Zero runtime dependencies. The only development dependencies are TypeScript, ESLint and their
  configs already in package.json; do not add packages.
- Money is integer cents (`Cents`). Never store or sum floating-point currency values.
- Every bug fix ships a regression test next to the code (`src/<module>.test.ts`).
- Run `npm run check` (typecheck, lint, tests) before you finish; all three must pass. Fix lint
  findings in the code; never disable a rule, add an eslint-disable comment, or loosen the config.
