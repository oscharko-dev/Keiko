import { join } from "node:path";

import { writeZipArchiveEntries } from "../../lib/zip-archive.mjs";

// Small real portable archives for the folder package builders (ADR-0121 D9): the payload layout
// of each desktop target, with the setup manifest the builders read the Keiko version from.

const EXECUTABLE = 0o100755;
const REGULAR = 0o100644;

function setupManifest(target, overrides = {}) {
  return `${JSON.stringify({
    schemaVersion: 1,
    platformTarget: target,
    packageName: "@oscharko-dev/keiko",
    packageVersion: "1.2.3",
    stable: true,
    ...overrides,
  })}\n`;
}

export function payloadRecords(target, manifestOverrides = {}) {
  if (target === "windows-x64") {
    return [
      { name: "Keiko/Keiko.exe", data: "launcher", mode: REGULAR },
      {
        name: "Keiko/.portable/setup-manifest.json",
        data: setupManifest(target, manifestOverrides),
      },
      { name: "Keiko/app/dist/cli/index.js", data: "cli" },
      { name: "Keiko/runtime/node/node.exe", data: "node" },
      { name: "Keiko/runtime/native/usearch.node", data: "usearch" },
      { name: "Keiko/runtime/licenses/usearch/LICENSE", data: "usearch license" },
    ];
  }
  const resources = "Keiko/Keiko.app/Contents/Resources";
  return [
    { name: "Keiko/Keiko.app/Contents/MacOS/Keiko", data: "launcher", mode: EXECUTABLE },
    {
      name: `${resources}/.portable/setup-manifest.json`,
      data: setupManifest(target, manifestOverrides),
    },
    { name: `${resources}/app/dist/cli/index.js`, data: "cli" },
    { name: `${resources}/runtime/node/bin/node`, data: "node", mode: EXECUTABLE },
    { name: `${resources}/runtime/native/usearch.node`, data: "usearch", mode: EXECUTABLE },
    { name: `${resources}/runtime/licenses/usearch/LICENSE`, data: "usearch license" },
  ];
}

/** Writes `keiko-<target>.zip` into `root` and returns its path. */
export function portableArchive(root, target, records = payloadRecords(target)) {
  const archive = join(root, `keiko-${target}.zip`);
  writeZipArchiveEntries(archive, records);
  return archive;
}
