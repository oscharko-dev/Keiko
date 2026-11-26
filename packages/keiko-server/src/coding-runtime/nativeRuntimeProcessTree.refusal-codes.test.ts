// #4495 AC4: every refusal the Windows supervisor can send owns one closed word, end to end. The
// error codes are read from the supervisor's own source, so a code added there without a word in the
// host's table, a word that names another step, or a word that never reaches a run failure code the
// Workbench can show turns this red instead of reading as `supervisor-unknown` in a customer's log.
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CODING_WORKBENCH_RUNTIME_FAILURE_CODES } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime";

import { NativeRuntimeTree, type NativeRuntimeHelperProcess } from "./nativeRuntimeProcessTree.js";
import { supervisorRefusalFailureCode } from "./supervisorRefusal.js";

const SUPERVISOR_SOURCE = fileURLToPath(
  new URL(
    "../../../../native/runtime-supervisor/windows/keiko_runtime_supervisor.c",
    import.meta.url,
  ),
);

interface NativeErrorCode {
  readonly name: string;
  readonly code: number;
}

function nativeErrorCodes(): readonly NativeErrorCode[] {
  const source = readFileSync(SUPERVISOR_SOURCE, "utf8");
  const body = /enum error_code \{(?<body>[^}]*)\}/u.exec(source)?.groups?.body ?? "";
  return [...body.matchAll(/\bERROR_(?<name>[A-Z0-9_]+)\s*=\s*(?<code>\d+)/gu)].map((match) => ({
    name: match.groups?.name ?? "",
    code: Number(match.groups?.code),
  }));
}

function refusalReason(code: number): string | undefined {
  const controlOutput = new PassThrough();
  const helper: NativeRuntimeHelperProcess = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    controlInput: new PassThrough(),
    controlOutput,
    onExit: (): void => undefined,
    onError: (): void => undefined,
  };
  const tree = new NativeRuntimeTree("a".repeat(32), helper, "win32");
  const packet = Buffer.alloc(14);
  packet.write("KRS1", 0, "ascii");
  packet.writeUInt16LE(1, 4);
  packet.writeUInt16LE(3, 6);
  packet.writeUInt32LE(2, 8);
  packet.writeUInt16LE(code, 12);
  controlOutput.emit("data", packet);
  return tree.failureReason();
}

// The refusals that name their own run failure code; every other word reaches the person as the one
// "Windows refused the start" sentence and the log as its own word.
const OWN_RUN_FAILURE_CODES: Readonly<Record<string, string>> = {
  GRANTS_DIRECTORY: "runtime-supervisor-grants-directory",
  GRANTS_ACL: "runtime-supervisor-grants-acl",
  GRANTS_CAPABILITY: "runtime-supervisor-grants-capability",
  GATEWAY_CONNECT: "runtime-supervisor-gateway-connect",
  GATEWAY_ADMIT: "runtime-supervisor-gateway-admit",
  NO_DESKTOP: "runtime-supervisor-no-desktop",
  IMAGE_PATH: "runtime-supervisor-image-path",
};

describe("Windows supervisor refusal words", () => {
  const codes = nativeErrorCodes();

  it("reads the supervisor's error codes from its source", () => {
    expect(codes.length).toBeGreaterThanOrEqual(17);
    expect(new Set(codes.map(({ code }) => code)).size).toBe(codes.length);
  });

  it.each(codes.map(({ name, code }) => [name, code] as const))(
    "gives ERROR_%s (%i) one distinct word that names its step",
    (name, code) => {
      const reason = refusalReason(code);
      expect(reason).toBe(`supervisor-${name.toLowerCase().replaceAll("_", "-")}`);
      expect(reason).not.toBe("supervisor-unknown");
    },
  );

  it("gives no two error codes the same word", () => {
    const words = codes.map(({ code }) => refusalReason(code));
    expect(new Set(words).size).toBe(codes.length);
  });

  it.each(codes.map(({ name, code }) => [name, code] as const))(
    "carries ERROR_%s (%i) to a run failure code the Workbench can word",
    (name, code) => {
      const failureCode = supervisorRefusalFailureCode(refusalReason(code));
      expect(failureCode).toBe(OWN_RUN_FAILURE_CODES[name] ?? "runtime-supervisor-refused");
      expect(CODING_WORKBENCH_RUNTIME_FAILURE_CODES).toContain(failureCode);
    },
  );

  it("names a code the supervisor does not define as unknown", () => {
    const unused = Math.max(...codes.map(({ code }) => code)) + 1;
    expect(refusalReason(unused)).toBe("supervisor-unknown");
  });
});
