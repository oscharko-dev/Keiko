import { pathToFileURL } from "node:url";

// True when this module was executed directly (`node script.mjs`), not imported by
// another module (a test, another script). Compares the canonical file:// URL Node
// assigns to `import.meta.url` against the canonical URL for `process.argv[1]` via
// `pathToFileURL` — never build that comparison by string-interpolating "file://" plus
// a raw path: import.meta.url always percent-encodes spaces, %, #, and ?, and uses
// forward slashes for a Windows drive letter, so a manual `file://${path}` silently
// never matches on any of those, and the script's CLI body never runs.
export function isMainModule(moduleUrl, argv1 = process.argv[1]) {
  return argv1 !== undefined && moduleUrl === pathToFileURL(argv1).href;
}
