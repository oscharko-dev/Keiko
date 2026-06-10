// Remove platform-specific optional native packages that would otherwise be captured by
// bundleDependencies from the publisher's machine. Keiko must start from one npm artifact on
// macOS, Windows, and Linux; optional PDF native helpers are loaded lazily and must not be bundled.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scopedNativeRoots = [join(repoRoot, "node_modules", "@napi-rs")];
const removed = [];

for (const scopedRoot of scopedNativeRoots) {
  if (!existsSync(scopedRoot)) continue;
  for (const entry of readdirSync(scopedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== "canvas" && !entry.name.startsWith("canvas-")) continue;
    const fullPath = join(scopedRoot, entry.name);
    rmSync(fullPath, { recursive: true, force: true });
    removed.push(`@napi-rs/${entry.name}`);
  }
}

if (removed.length > 0) {
  console.log(`prune-package-native-optionals: removed ${removed.join(", ")}`);
} else {
  console.log("prune-package-native-optionals: no optional native canvas packages present");
}
