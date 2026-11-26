import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  portableRuntimeRecordEntries,
  RUNTIME_ACTIVATION_RECORD_PATH,
} from "./portable-runtime-record.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function payloadWithRecord(record: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-runtime-record-"));
  roots.push(root);
  mkdirSync(join(root, ".portable"), { recursive: true });
  writeFileSync(join(root, RUNTIME_ACTIVATION_RECORD_PATH), JSON.stringify(record));
  return root;
}

function record(platformTarget: string): unknown {
  return {
    platformTarget,
    nativeTools: [
      { executablePath: "runtime/native/rg.exe", licensePath: "runtime/licenses/rg/LICENSE" },
      { executablePath: "runtime/step-node/node.exe" },
    ],
    sidecarRuntimes: [{ payloadRootPath: "runtime/sidecars/opencode" }],
  };
}

// #4492: only a Windows payload carries the patched step Node.js, so only a Windows record may name
// its fixed path; every other path outside the runtime folders stays refused.
describe("portableRuntimeRecordEntries", () => {
  it("admits the step Node.js path from a Windows record", () => {
    const entries = portableRuntimeRecordEntries(payloadWithRecord(record("windows-x64")));
    expect([...entries.files].sort()).toEqual(
      [
        RUNTIME_ACTIVATION_RECORD_PATH,
        "runtime/licenses/rg/LICENSE",
        "runtime/native/rg.exe",
        "runtime/step-node/node.exe",
      ].sort(),
    );
    expect(entries.prefixes).toEqual(["runtime/sidecars/opencode/"]);
  });

  it.each(["macos-arm64", "macos-x64", "linux-x64"])(
    "refuses the step Node.js path from a %s record",
    (target) => {
      const entries = portableRuntimeRecordEntries(payloadWithRecord(record(target)));
      expect(entries.files.has("runtime/step-node/node.exe")).toBe(false);
      expect(entries.files.has("runtime/native/rg.exe")).toBe(true);
    },
  );

  it("refuses any other path outside the runtime folders", () => {
    const entries = portableRuntimeRecordEntries(
      payloadWithRecord({
        platformTarget: "windows-x64",
        nativeTools: [
          { executablePath: "runtime/step-node/other.exe" },
          { executablePath: "runtime/node/node.exe" },
          { executablePath: "../outside.exe" },
        ],
      }),
    );
    expect([...entries.files]).toEqual([RUNTIME_ACTIVATION_RECORD_PATH]);
  });
});
