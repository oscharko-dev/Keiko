// Forbidden-path rules for the published tarball (ADR-0011 D6; Issue #287 native-addon guard).
//
// Extracted into a dependency-free module so the rule set is unit-testable without running
// `npm pack` or importing the BFF (`@oscharko-dev/keiko-server`). `scripts/check-package-surface.mjs`
// consumes these to fail the published tarball if it contains anything it must not ship.

export const FORBIDDEN_TARBALL_PATH_RULES = [
  // `.js.map` is the runtime source-map artifact (can leak absolute paths from the original
  // sources). `.d.ts.map` is a declaration map — relative-only and used by editors to resolve
  // "go to definition" across bundled workspace packages, so it stays.
  { test: (p) => p.endsWith(".js.map"), label: "a JS source map" },
  { test: (p) => p === ".env" || p.startsWith(".env."), label: "an environment file" },
  {
    test: (p) => p === "packages/keiko-ui" || p.startsWith("packages/keiko-ui/"),
    label: "keiko-ui workspace source",
  },
  // Generic native-addon guard (Issue #287 AC4 "native addons"): no compiled `.node` binary may ship
  // in the published artifact. Keiko's published product is platform-agnostic pure-JS; the only
  // `.node` source in the graph is the optional `@napi-rs/canvas` backend, which
  // `scripts/prune-package-native-optionals.mjs` removes before pack. This rule is the fail-closed
  // backstop if that prune step ever regresses or a new native dependency is introduced.
  { test: (p) => p.endsWith(".node"), label: "a native addon binary" },
  // Belt-and-suspenders specialization of the generic `.node` rule: a clearer message if the
  // canvas optional ever reaches the tarball by a path that does not end in `.node`.
  {
    test: (p) => p.includes("node_modules/@napi-rs/canvas"),
    label: "a platform-specific optional native canvas dependency",
  },
  { test: (p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p), label: "an absolute local path" },
];

// Returns every (path, label) pair where a tarball path matches a forbidden rule. Pure: callers
// decide how to report (the gate fails on the first hit).
export function findForbiddenPaths(paths) {
  const hits = [];
  for (const path of paths) {
    for (const rule of FORBIDDEN_TARBALL_PATH_RULES) {
      if (rule.test(path)) hits.push({ path, label: rule.label });
    }
  }
  return hits;
}
