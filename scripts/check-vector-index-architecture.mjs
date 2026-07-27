#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { vectorIndexArchitectureFailures } from "./lib/vector-index-architecture.mjs";

const root = process.cwd();
const packageRoot = resolve(root, "packages");
const sources = new Map();

for (const absolutePath of readdirSync(packageRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => resolve(entry.parentPath, entry.name))) {
  const path = relative(root, absolutePath);
  sources.set(path, readFileSync(absolutePath, "utf8"));
}

const failures = vectorIndexArchitectureFailures(sources);
if (failures.length > 0) {
  console.error("Vector-index architecture check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Vector-index architecture check passed.");
