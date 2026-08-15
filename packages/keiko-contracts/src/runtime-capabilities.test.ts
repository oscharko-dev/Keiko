import { describe, expect, it } from "vitest";
import {
  RUNTIME_CAPABILITY_SCHEMA_VERSION,
  RUNTIME_CAPABILITY_STATES,
  validateRuntimeCapabilitiesResponse,
  type RuntimeCapabilitiesResponse,
} from "./runtime-capabilities.js";
import { WORKSPACE_PORTABLE_PATH_MAX_BYTES } from "./workspace-contract-primitives.js";

describe("runtime capability contracts", () => {
  it("validates a serializable content-free response", () => {
    const response: RuntimeCapabilitiesResponse = {
      schemaVersion: RUNTIME_CAPABILITY_SCHEMA_VERSION,
      generatedAtMs: 1_234,
      deadlineMs: 250,
      capabilities: [
        {
          id: "git",
          kind: "git",
          label: "Git",
          state: "available",
        },
        {
          id: "docker",
          kind: "container-engine",
          label: "Docker",
          state: "policy-blocked",
          unavailableReason: "unsafe-path",
          remediationHint: "Install Docker or make docker available on PATH.",
        },
        {
          id: "command-source:package.json:test",
          kind: "command-source",
          label: "Test command source",
          state: "available",
          source: {
            type: "package-json-script",
            path: "package.json",
            commandKind: "test",
            scriptName: "test",
            packageManager: "npm",
          },
        },
      ],
    };

    expect(validateRuntimeCapabilitiesResponse(response)).toEqual({ ok: true, value: response });
    expect(JSON.stringify(response)).not.toContain("/repo");
  });

  // KEIKO-0239: source.path was validated as a non-empty string only, so an absolute path — which
  // would reveal the operator's home directory, repository location, or container layout in a
  // UI-facing, evidence-adjacent response — was accepted. The one test that claimed to prove
  // "content-free" output asserted `not.toContain("/repo")` against a hand-written "package.json"
  // literal, so it could never have failed.
  it.each([
    ["a POSIX absolute path", "/Users/alice/repo/package.json"],
    ["a Windows drive path", "C:\\repo\\package.json"],
    ["a UNC path", "\\\\host\\share\\package.json"],
    ["a backslash separator", "sub\\package.json"],
    ["a traversal segment", "../../etc/package.json"],
    // KEIKO-0239-follow-on: this validator had drifted into a second, looser copy of
    // isPortableWorkspaceRelativePath (workspace-contract-primitives.ts) — it checked "." and
    // ".." segments but not an EMPTY segment (a bare double slash), did not reject a
    // tilde-prefixed home-relative path, and had no length bound at all.
    ["a double-slash producing an empty segment", "foo//bar/package.json"],
    ["a tilde-prefixed home-relative path", "~/secrets/package.json"],
    [
      "a path over the portable byte bound",
      `${"a".repeat(WORKSPACE_PORTABLE_PATH_MAX_BYTES)}/package.json`,
    ],
    ["a NUL byte", "package.json\u0000"],
  ])("rejects a command source whose path is %s", (_label, path) => {
    const response: RuntimeCapabilitiesResponse = {
      schemaVersion: RUNTIME_CAPABILITY_SCHEMA_VERSION,
      generatedAtMs: 1_234,
      deadlineMs: 250,
      capabilities: [
        {
          id: "command-source:package.json:test",
          kind: "command-source",
          label: "Test command source",
          state: "available",
          source: { type: "package-json-script", path, commandKind: "test" },
        },
      ],
    };
    expect(validateRuntimeCapabilitiesResponse(response).ok).toBe(false);
  });

  it("rejects malformed capability states and source shapes without throwing", () => {
    const result = validateRuntimeCapabilitiesResponse({
      schemaVersion: "1",
      generatedAtMs: 0,
      deadlineMs: 250,
      capabilities: [
        {
          id: "x",
          kind: "git",
          label: "Git",
          state: "blocked",
          source: { type: "package-json-script", path: "", commandKind: "deploy" },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("capabilities[0].state is invalid");
      expect(result.errors).toContain("capabilities[0].source.path must be a non-empty string");
      expect(result.errors).toContain("capabilities[0].source.commandKind is invalid");
    }
  });

  it("pins the required state vocabulary for degraded host tools", () => {
    expect(RUNTIME_CAPABILITY_STATES).toEqual([
      "available",
      "missing",
      "unsupported",
      "permission-denied",
      "not-running",
      "policy-blocked",
    ]);
  });
});
