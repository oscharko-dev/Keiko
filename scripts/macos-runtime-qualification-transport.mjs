#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { sha256File } from "./lib/digest.mjs";

const MAX_FILES = 100_000;
const RECEIPT_SUFFIX =
  "payload/Keiko/Keiko.app/Contents/Resources/.portable/runtime-qualification.json";

class MacosQualificationTransportError extends Error {}

function fail(message) {
  throw new MacosQualificationTransportError(`macos-runtime-qualification-transport: ${message}`);
}

function parse(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("invalid arguments");
    options[key.slice(2)] = value;
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) fail(`--${name} is required`);
  return value;
}

function snapshotTree(root) {
  const resolvedRoot = resolve(root);
  const rootEntry = lstatSync(resolvedRoot);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) fail("stage root is invalid");
  const files = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort((left, right) => left.localeCompare(right))) {
      const path = join(directory, name);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) fail("stage contains a link");
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.nlink === 1) {
        files.push({
          path: relative(resolvedRoot, path).replaceAll("\\", "/"),
          sha256: sha256File(path),
          sizeBytes: entry.size,
        });
      } else {
        fail("stage contains an unsupported entry");
      }
      if (files.length > MAX_FILES) fail("stage file count exceeds the qualification bound");
    }
  };
  walk(resolvedRoot);
  return files;
}

function writeSnapshot(options) {
  const stageRoot = resolve(required(options, "stage-root"));
  const receipt = join(stageRoot, ...RECEIPT_SUFFIX.split("/"));
  try {
    lstatSync(receipt);
    fail("qualification receipt already exists");
  } catch (error) {
    if (error instanceof MacosQualificationTransportError) throw error;
    if (error?.code !== "ENOENT") fail("qualification receipt path is invalid");
  }
  writeFileSync(
    resolve(required(options, "output")),
    `${JSON.stringify({ schemaVersion: 1, files: snapshotTree(stageRoot) }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function readSnapshot(path) {
  let value;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 16_777_216) {
      fail("snapshot is invalid");
    }
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof MacosQualificationTransportError) throw error;
    fail("snapshot is invalid");
  }
  if (!snapshotIsValid(value)) fail("snapshot is invalid");
  return value.files;
}

function snapshotIsValid(value) {
  return (
    value?.schemaVersion === 1 &&
    Array.isArray(value.files) &&
    value.files.every(
      (file) =>
        typeof file?.path === "string" &&
        /^[a-f0-9]{64}$/u.test(file.sha256) &&
        Number.isSafeInteger(file.sizeBytes) &&
        file.sizeBytes >= 0,
    )
  );
}

function verifySnapshot(options) {
  const stageRoot = resolve(required(options, "stage-root"));
  const before = readSnapshot(resolve(required(options, "snapshot")));
  const after = snapshotTree(stageRoot);
  const beforeByPath = new Map(before.map((file) => [file.path, file]));
  const afterByPath = new Map(after.map((file) => [file.path, file]));
  if (
    beforeByPath.size !== before.length ||
    afterByPath.size !== after.length ||
    after.length !== before.length + 1
  ) {
    fail("qualified stage file set changed unexpectedly");
  }
  for (const [path, expected] of beforeByPath) {
    const actual = afterByPath.get(path);
    if (actual?.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes) {
      fail("qualified stage bytes changed unexpectedly");
    }
  }
  if (!afterByPath.has(RECEIPT_SUFFIX) || beforeByPath.has(RECEIPT_SUFFIX)) {
    fail("qualification receipt is not the only added file");
  }
}

export function main(argv = process.argv.slice(2)) {
  const { command, options } = parse(argv);
  if (command === "snapshot") writeSnapshot(options);
  else if (command === "verify") verifySnapshot(options);
  else fail("unsupported command");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof MacosQualificationTransportError
        ? error.message
        : "macos-runtime-qualification-transport: redacted failure",
    );
    process.exit(1);
  }
}
