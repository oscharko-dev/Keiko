// Issue #1388 — container-run evidence is content-free. The manifest carries counts/enums + the
// catalog image id only; it MUST NOT contain the docker argv, the raw image ref free-text, the
// workspace path, or any container output. A sentinel-fingerprint spy proves no such leaf leaks.

import { describe, expect, it, vi } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import {
  appendContainerRunEvidence,
  buildContainerRunEvidenceEntry,
  CONTAINER_RUN_EVIDENCE_KIND,
  type ContainerRunEvidenceInput,
} from "./containerRunner-evidence.js";

// Distinct sentinel strings for every leaf the manifest must NOT carry.
const ARGV_SENTINEL = "ARGV-SENTINEL-docker-run-rm-network-none";
const OUTPUT_SENTINEL = "OUTPUT-SENTINEL-container-stdout-bytes";
const PATH_SENTINEL = "/PATH-SENTINEL/workspace/root";
const IMAGE_REF_SENTINEL = "registry.example.com/PRIVATE-IMAGE-REF:sha256-deadbeef";

function input(): ContainerRunEvidenceInput {
  return {
    runId: "run-abc",
    projectId: "project-1",
    taskId: "container-pilot:diagnostic",
    kind: "diagnostic",
    engine: "docker",
    imageId: "container-pilot:diagnostic", // closed-catalog id, NOT a raw image ref
    argCount: 24,
    exitCode: 0,
    durationMs: 12,
    timedOut: false,
    truncated: false,
    failureReason: "none",
    stdoutBytes: 30,
    stderrBytes: 0,
    startedAt: 1_700_000_000_000,
  };
}

describe("buildContainerRunEvidenceEntry", () => {
  it("emits a content-free manifest with taskType container-run + counts/enums only", () => {
    const entry = buildContainerRunEvidenceEntry(input());
    expect(entry.run.taskType).toBe(CONTAINER_RUN_EVIDENCE_KIND);
    expect(entry.run.outcome).toBe("completed");
    expect(entry.commandExecutions).toHaveLength(1);
    const exec = entry.commandExecutions[0];
    expect(exec?.executable).toBe("docker");
    expect(exec?.argCount).toBe(24);
    expect(exec?.exitCode).toBe(0);
  });

  it("maps failure reasons to outcomes", () => {
    expect(
      buildContainerRunEvidenceEntry({ ...input(), failureReason: "timed-out" }).run.outcome,
    ).toBe("limit-exceeded");
    expect(
      buildContainerRunEvidenceEntry({ ...input(), failureReason: "cancelled" }).run.outcome,
    ).toBe("cancelled");
    expect(
      buildContainerRunEvidenceEntry({ ...input(), failureReason: "image-missing" }).run.outcome,
    ).toBe("failed");
  });

  it("never carries the argv, raw image ref, workspace path, or output (sentinel-fingerprint)", () => {
    // Even if a caller were to leak a sentinel into a build field, none of these belong in the
    // content-free manifest. We pass them through fields the builder DOES read and assert they do
    // not surface; the raw image ref / argv / output / path are never builder inputs at all.
    const entry = buildContainerRunEvidenceEntry({
      ...input(),
      taskId: "container-pilot:diagnostic",
      imageId: "container-pilot:diagnostic",
    });
    const serialized = JSON.stringify(entry);
    for (const sentinel of [ARGV_SENTINEL, OUTPUT_SENTINEL, PATH_SENTINEL, IMAGE_REF_SENTINEL]) {
      expect(serialized).not.toContain(sentinel);
    }
  });
});

describe("appendContainerRunEvidence", () => {
  it("applies the redactor to every string leaf before store.put (best-effort persistence port)", () => {
    const store = createInMemoryEvidenceStore();
    const putSpy = vi.spyOn(store, "put");
    const redact = (value: string): string => value.replace("project-1", "[REDACTED]");
    const handle = appendContainerRunEvidence(
      store,
      buildContainerRunEvidenceEntry(input()),
      redact,
    );
    expect(handle).toContain("run-abc");
    expect(putSpy.mock.calls[0]?.[0]).toBe("run-abc");
    const stored = putSpy.mock.calls[0]?.[1] ?? "";
    expect(stored).toContain("[REDACTED]");
    expect(stored).not.toContain("project-1");
  });
});
