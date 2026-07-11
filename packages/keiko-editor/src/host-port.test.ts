import { describe, expect, it } from "vitest";

import type { EditorBuffer, EditorHostPort, EditorVerificationRunIntent } from "./host-port.js";

// Issue #2212 fix-up — a type-only compatibility proof for EditorHostPort's optional capability
// ports, in particular the two run-affordance methods (`runVerification`, `runWorkspaceVerification`)
// this issue added. Every capability beyond `loadBuffer` is declared optional (host-port.ts:60-101);
// this test proves the TypeScript compiler still accepts a host implementing none, some, or all of
// them, so a future edit that accidentally makes one required would fail `tsc` here first.

function minimalBuffer(): EditorBuffer {
  return {
    language: "typescript",
    content: { relativePath: "src/a.ts", sizeBytes: 0, text: "", truncated: false },
    readOnly: false,
  };
}

describe("EditorHostPort — optional capability composition (type-only proof)", () => {
  it("accepts a host implementing ONLY the mandatory loadBuffer", () => {
    const host: EditorHostPort = {
      loadBuffer: (): Promise<EditorBuffer> => Promise.resolve(minimalBuffer()),
    };
    expect(host.runVerification).toBeUndefined();
    expect(host.runWorkspaceVerification).toBeUndefined();
    expect(host.cancelVerification).toBeUndefined();
  });

  it("accepts a host implementing ONLY runVerification (patch-review case)", () => {
    let calls = 0;
    const host: EditorHostPort = {
      loadBuffer: (): Promise<EditorBuffer> => Promise.resolve(minimalBuffer()),
      runVerification: (): void => {
        calls += 1;
      },
    };
    expect(host.runWorkspaceVerification).toBeUndefined();
    host.runVerification?.();
    expect(calls).toBe(1);
  });

  it("accepts a host implementing ONLY runWorkspaceVerification (general run affordance)", () => {
    const intents: EditorVerificationRunIntent[] = [];
    const host: EditorHostPort = {
      loadBuffer: (): Promise<EditorBuffer> => Promise.resolve(minimalBuffer()),
      runWorkspaceVerification: (intent): void => {
        intents.push(intent);
      },
    };
    expect(host.runVerification).toBeUndefined();
    host.runWorkspaceVerification?.({ kind: "typecheck" });
    host.runWorkspaceVerification?.({ kind: "targeted-test", targetPath: "src/a.test.ts" });
    expect(intents).toEqual([
      { kind: "typecheck" },
      { kind: "targeted-test", targetPath: "src/a.test.ts" },
    ]);
  });

  it("accepts a host implementing BOTH run-affordance methods plus cancelVerification", () => {
    const calls: string[] = [];
    const host: EditorHostPort = {
      loadBuffer: (): Promise<EditorBuffer> => Promise.resolve(minimalBuffer()),
      runVerification: (): void => {
        calls.push("runVerification");
      },
      runWorkspaceVerification: (): void => {
        calls.push("runWorkspaceVerification");
      },
      cancelVerification: (): void => {
        calls.push("cancelVerification");
      },
    };
    host.runVerification?.();
    host.runWorkspaceVerification?.({ kind: "build" });
    host.cancelVerification?.();
    expect(calls).toEqual(["runVerification", "runWorkspaceVerification", "cancelVerification"]);
  });
});
