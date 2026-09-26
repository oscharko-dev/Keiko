// Remove platform-specific optional native packages before packaging gates. The staged npm artifact
// copies only private workspace dist trees and declares PDF canvas support as optional, but a direct
// source pack or future staging drift must never capture a publisher-machine native binary.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const removed = [];

function workspaceNativeRoots() {
  const packagesRoot = join(repoRoot, "packages");
  if (!existsSync(packagesRoot)) return [];
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesRoot, entry.name, "node_modules", "@napi-rs"));
}

const scopedNativeRoots = [join(repoRoot, "node_modules", "@napi-rs"), ...workspaceNativeRoots()];

for (const scopedRoot of scopedNativeRoots) {
  if (!existsSync(scopedRoot)) continue;
  for (const entry of readdirSync(scopedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== "canvas" && !entry.name.startsWith("canvas-")) continue;
    const fullPath = join(scopedRoot, entry.name);
    rmSync(fullPath, { recursive: true, force: true });
    removed.push(fullPath.replace(`${repoRoot}/`, ""));
  }
}

if (removed.length > 0) {
  console.log(`prune-package-native-optionals: removed ${removed.join(", ")}`);
} else {
  console.log("prune-package-native-optionals: no optional native canvas packages present");
}
