// Local copy of the root product SDK_VERSION constant. The local BFF surfaces this
// in route responses (see `routes.ts` healthcheck).
//
// Why a local literal rather than a deep `../../../src/sdk/index.js` re-export:
// the root SDK module transitively pulls in `src/evaluations` (which references
// `../ui/run-request.js` — that file now lives in this package and `src/ui/` is
// just a shim) and `src/cli`. Under `composite: true`, tsc would force every
// transitively-reachable file under the broadened `rootDir: "../.."` into this
// package's `include` (TS6307), which would balloon the include into a circular
// graph (server → sdk → cli → ui shim → server). The spec discourages inventing
// a port for a single string constant; a single-line literal kept in sync with
// the root `src/sdk/index.ts` SDK_VERSION (and the root `package.json` "version"
// field) is the minimal-surface alternative.
export const SDK_VERSION = "0.1.6";
