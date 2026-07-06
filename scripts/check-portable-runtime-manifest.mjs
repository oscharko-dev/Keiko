import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readPortableManifest, validatePortableManifest } from "./portable-runtime.mjs";

function fail(message) {
  console.error(`portable-manifest check failed: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { contractExamples: [], manifests: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--contract-example") {
      options.contractExamples.push(requiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--manifest") {
      options.manifests.push(requiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    fail(`unsupported argument: ${arg}`);
  }
  if (options.contractExamples.length === 0 && options.manifests.length === 0) {
    fail("pass --manifest <path> or --contract-example <markdown>");
  }
  return options;
}

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (typeof value !== "string" || value.length === 0) fail(`${flag} requires a value`);
  return value;
}

function extractFirstJsonFence(markdownPath) {
  const text = readFileSync(markdownPath, "utf8");
  const match = /```json\n([\s\S]*?)\n```/u.exec(text);
  if (match === null) fail(`${markdownPath} does not contain a JSON manifest fence`);
  return JSON.parse(match[1]);
}

function validateEntry(label, manifest, options) {
  const failures = validatePortableManifest(manifest, options);
  if (failures.length > 0) {
    fail(`${label}\n  - ${failures.join("\n  - ")}`);
  }
}

export function runPortableManifestCheck(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  for (const path of options.contractExamples) {
    validateEntry(path, extractFirstJsonFence(path), { allowPlaceholders: true });
  }
  for (const path of options.manifests) {
    validateEntry(path, readPortableManifest(path), { allowPlaceholders: false });
  }
  const checked = options.contractExamples.length + options.manifests.length;
  console.log(`portable-manifest check passed: ${String(checked)} manifest(s).`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPortableManifestCheck();
}
