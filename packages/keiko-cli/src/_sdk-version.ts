// Local copy of the root product SDK_VERSION constant. The CLI surfaces this via
// `keiko --version`. Kept as a literal (not a deep `../../../src/sdk/index.js`
// re-export) for the same reason as keiko-server's _sdk-version.ts: under
// composite: true + rootDir: "../..", the root SDK module transitively pulls in
// src/evaluations and src/cli, which would force a circular include into this
// package and trigger TS6307. The spec discourages inventing a port for a single
// string constant; a single-line literal kept in sync with the root
// src/sdk/index.ts SDK_VERSION (and the root package.json "version" field) is
// the minimal-surface alternative.
export const SDK_VERSION = "0.1.7";
