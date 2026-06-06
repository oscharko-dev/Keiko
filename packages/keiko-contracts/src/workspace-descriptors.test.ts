// Epic #518 / Issue #528 — workspace descriptor validator tests.
//
// Pins ADR-0029's six consistency rules:
//   R1 unknown enum                          — closed-set membership
//   R2 ui-only authority + non-ui boundary   — inconsistent
//   R3 evidence-reference                    — requires evidence boundary
//   R4 fs-reference                          — requires fs boundary
//   R5 memory-reference                      — requires memory boundary
//   R6 durable.ui                            — requires ui boundary

import { describe, expect, it } from "vitest";
import {
  type WorkspaceDescriptorMeta,
  validateWorkspaceDescriptorMeta,
} from "./workspace-descriptors.js";

function ok(meta: WorkspaceDescriptorMeta): readonly unknown[] {
  return validateWorkspaceDescriptorMeta("under-test", meta);
}

describe("validateWorkspaceDescriptorMeta — ADR-0029 rules", () => {
  it("R1 — accepts a fully valid descriptor", () => {
    const errors = ok({
      lifecycle: ["idle", "live"],
      trustBoundary: ["ui"],
      authority: "ui-only",
      persistence: "transient",
    });
    expect(errors).toEqual([]);
  });

  it("R1 — rejects unknown lifecycle state", () => {
    const errors = ok({
      lifecycle: ["unknown-state" as never],
      trustBoundary: ["ui"],
      authority: "ui-only",
      persistence: "transient",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ field: "lifecycle" });
  });

  it("R1 — rejects unknown trust boundary", () => {
    const errors = ok({
      lifecycle: ["idle"],
      trustBoundary: ["intergalactic" as never],
      authority: "ui-only",
      persistence: "transient",
    });
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => (e as { field: string }).field === "trustBoundary")).toBe(true);
  });

  it("R1 — rejects unknown authority value", () => {
    const errors = ok({
      lifecycle: ["idle"],
      trustBoundary: ["ui"],
      authority: "guest" as never,
      persistence: "transient",
    });
    expect(errors.some((e) => (e as { field: string }).field === "authority")).toBe(true);
  });

  it("R1 — rejects unknown persistence value", () => {
    const errors = ok({
      lifecycle: ["idle"],
      trustBoundary: ["ui"],
      authority: "ui-only",
      persistence: "cloud" as never,
    });
    expect(errors.some((e) => (e as { field: string }).field === "persistence")).toBe(true);
  });

  it("R2 — rejects ui-only authority that crosses fs boundary", () => {
    const errors = ok({
      lifecycle: ["idle"],
      trustBoundary: ["ui", "fs"],
      authority: "ui-only",
      persistence: "transient",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ field: "consistency" });
  });

  it("R2 — accepts ui-only authority with trust boundary ['ui']", () => {
    const errors = ok({
      lifecycle: ["idle"],
      trustBoundary: ["ui"],
      authority: "ui-only",
      persistence: "transient",
    });
    expect(errors).toEqual([]);
  });

  it("R3 — rejects evidence-reference without the evidence trust boundary", () => {
    const errors = ok({
      lifecycle: ["proposed"],
      trustBoundary: ["ui"],
      authority: "user-confirm",
      persistence: "evidence-reference",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ field: "consistency" });
  });

  it("R3 — accepts evidence-reference with the evidence trust boundary", () => {
    const errors = ok({
      lifecycle: ["proposed"],
      trustBoundary: ["ui", "evidence"],
      authority: "user-confirm",
      persistence: "evidence-reference",
    });
    expect(errors).toEqual([]);
  });

  it("R4 — rejects fs-reference without the fs trust boundary", () => {
    const errors = ok({
      lifecycle: ["viewing"],
      trustBoundary: ["ui"],
      authority: "user",
      persistence: "fs-reference",
    });
    expect(errors).toHaveLength(1);
  });

  it("R4 — accepts fs-reference with the fs trust boundary", () => {
    const errors = ok({
      lifecycle: ["viewing"],
      trustBoundary: ["ui", "fs"],
      authority: "user",
      persistence: "fs-reference",
    });
    expect(errors).toEqual([]);
  });

  it("R5 — rejects memory-reference without the memory trust boundary", () => {
    const errors = ok({
      lifecycle: ["live"],
      trustBoundary: ["ui"],
      authority: "user",
      persistence: "memory-reference",
    });
    expect(errors).toHaveLength(1);
  });

  it("R5 — accepts memory-reference with the memory trust boundary", () => {
    const errors = ok({
      lifecycle: ["live"],
      trustBoundary: ["ui", "memory"],
      authority: "user",
      persistence: "memory-reference",
    });
    expect(errors).toEqual([]);
  });

  it("R6 — rejects durable.ui without the ui trust boundary", () => {
    const errors = ok({
      lifecycle: ["draft"],
      trustBoundary: ["model"],
      authority: "user-confirm",
      persistence: "durable.ui",
    });
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => (e as { field: string }).field === "consistency")).toBe(true);
  });

  it("R6 — accepts durable.ui with the ui trust boundary", () => {
    const errors = ok({
      lifecycle: ["draft", "streaming", "final"],
      trustBoundary: ["ui", "model", "evidence"],
      authority: "user-confirm",
      persistence: "durable.ui",
    });
    expect(errors).toEqual([]);
  });

  it("reports the objectType in every error so the registration site is identifiable", () => {
    const errors = validateWorkspaceDescriptorMeta("review", {
      lifecycle: ["proposed"],
      trustBoundary: ["ui"],
      authority: "user-confirm",
      persistence: "evidence-reference",
    });
    expect(errors.every((e) => e.objectType === "review")).toBe(true);
  });
});
