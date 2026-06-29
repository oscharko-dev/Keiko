import { describe, expect, it } from "vitest";
import {
  RUNTIME_CAPABILITY_SCHEMA_VERSION,
  RUNTIME_CAPABILITY_STATES,
  validateRuntimeCapabilitiesResponse,
  type RuntimeCapabilitiesResponse,
} from "./runtime-capabilities.js";

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
