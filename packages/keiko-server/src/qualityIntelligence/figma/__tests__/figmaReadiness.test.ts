import { describe, expect, it } from "vitest";
import { resolveReadiness, type FigmaNode } from "../figmaReadiness.js";

const leaf = (name: string, extra: Partial<FigmaNode> = {}): FigmaNode => ({
  id: name,
  name,
  type: "FRAME",
  ...extra,
});

describe("resolveReadiness — precedence version > section > devStatus > none", () => {
  it("resolves to version when a pinned version is supplied (highest precedence)", () => {
    const node = leaf("Release", {
      children: [leaf("Login", { devStatus: { type: "READY_FOR_DEV" } })],
    });
    const signal = resolveReadiness(node, { version: "v-123", releaseMarker: "release" });
    expect(signal).toEqual({ source: "version", ready: true, version: "v-123" });
  });

  it("resolves to section when the root name matches the release marker (no version)", () => {
    const node = leaf("Release Candidate");
    const signal = resolveReadiness(node, { version: undefined, releaseMarker: "release" });
    expect(signal).toEqual({
      source: "section",
      ready: true,
      matchedNodeName: "Release Candidate",
    });
  });

  it("matches the release marker case-insensitively and on descendants", () => {
    const node = leaf("Designs", {
      children: [leaf("Drafts"), leaf("RELEASE v2")],
    });
    const signal = resolveReadiness(node, { releaseMarker: "release" });
    expect(signal.source).toBe("section");
    expect(signal.ready).toBe(true);
  });

  it("honours a configurable, non-default release marker (generic, not board-tuned)", () => {
    const node = leaf("Freigegeben");
    const signal = resolveReadiness(node, { releaseMarker: "freigegeben" });
    expect(signal.source).toBe("section");
    expect(signal.ready).toBe(true);
  });

  it("falls back to devStatus READY_FOR_DEV when no version and no section match", () => {
    const node = leaf("Work In Progress", {
      children: [leaf("Login", { devStatus: { type: "READY_FOR_DEV" } })],
    });
    const signal = resolveReadiness(node, { releaseMarker: "release" });
    expect(signal).toEqual({ source: "devStatus", ready: true, readyNodeCount: 1 });
  });

  it("DEGRADES GRACEFULLY to none when devStatus is absent entirely", () => {
    const node = leaf("Work In Progress", { children: [leaf("Login"), leaf("Home")] });
    const signal = resolveReadiness(node, { releaseMarker: "release" });
    expect(signal).toEqual({ source: "none", ready: false });
  });

  it("treats a non-READY devStatus as not ready (degrades to none)", () => {
    const node = leaf("WIP", {
      children: [leaf("Login", { devStatus: { type: "REVIEW" } })],
    });
    const signal = resolveReadiness(node, { releaseMarker: "release" });
    expect(signal).toEqual({ source: "none", ready: false });
  });

  it("does not match the marker as an unrelated substring collision risk — exact word fragments allowed", () => {
    // 'release' as a substring of a longer token still counts as a section signal; this is
    // intentional and structural (designers name sections 'Released', 'Release v3', etc.).
    const node = leaf("Released");
    expect(resolveReadiness(node, { releaseMarker: "release" }).source).toBe("section");
  });

  it("defaults the release marker to 'release' when none supplied", () => {
    expect(resolveReadiness(leaf("Release"), {}).source).toBe("section");
    expect(resolveReadiness(leaf("Draft"), {}).source).toBe("none");
  });
});
