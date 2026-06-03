// Re-export of the root product SDK_VERSION constant. The local BFF surfaces this
// in route responses (see `routes.ts` healthcheck). Imported via the broadened
// `rootDir: "../.."` in this package's tsconfig — the only deep `src/` import the
// server package needs that isn't covered by another `@oscharko-dev/keiko-*` barrel.
// `src/sdk/` is part of the root product package and will not be extracted into
// its own workspace; a thin per-constant re-export here keeps the dependency
// surface auditable and avoids inventing a port for a single string.
export { SDK_VERSION } from "../../../src/sdk/index.js";
