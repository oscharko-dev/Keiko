// Unit tests for the figma-snapshot server seam (Epic #750, Issue #754).
//
// Covers: the snapshot LOADER (undefined when no evidence dir; reads only the stored snapshot via
// the evidence store, never Figma), and the capability-routed VISION hint provider (routes via
// resolveQiMultimodalSelection only — no hard-coded model id; returns [] when no multimodal
// capability, when no call is injected, and when the call throws or returns garbage).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type { ModelCapability } from "@oscharko-dev/keiko-model-gateway";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import { createNodeFigmaSnapshotStore } from "@oscharko-dev/keiko-evidence";
import { hashSnapshot } from "../figma/figmaSnapshotHash.js";
import type { UiHandlerDeps } from "../../deps.js";
import { buildRedactor, createRunRegistry } from "../../index.js";
import { createInMemoryUiStore } from "../../store/index.js";
import {
  makeFigmaSnapshotLoader,
  makeFigmaVisionHintProvider,
  type FigmaVisionScreenRequest,
} from "../figmaSnapshotAdapter.js";

function emptyStore(): EvidenceStore {
  return { put: () => "", list: () => [], get: () => undefined, delete: () => undefined };
}

function capability(id: string, overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id,
    kind: "chat",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test",
    preferredUseCases: ["Chat"],
    knownLimitations: [],
    ...overrides,
  };
}

function configWith(
  capabilities: readonly ModelCapability[],
): ReturnType<typeof parseGatewayConfig> {
  return parseGatewayConfig(
    {
      providers: capabilities.map((c) => ({
        modelId: c.id,
        baseUrl: "https://fake.example.com/v1",
        apiKey: "fake-key",
        capability: c,
      })),
    },
    {},
  );
}

function depsWith(over: Partial<UiHandlerDeps>): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: emptyStore(),
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (_id: string): undefined => undefined,
    store: createInMemoryUiStore(),
    evidenceDir: undefined,
    ...over,
  };
}

const REQUEST: FigmaVisionScreenRequest = {
  screenId: "s1",
  imageRelativePath: "screen-s1.png",
  baselineText: "Screen: S1 [s1]",
};

// ─── Snapshot loader ──────────────────────────────────────────────────────────────

describe("makeFigmaSnapshotLoader", () => {
  it("returns undefined when no evidence dir is configured", () => {
    expect(makeFigmaSnapshotLoader(depsWith({ evidenceDir: undefined }))).toBeUndefined();
    expect(makeFigmaSnapshotLoader(depsWith({ evidenceDir: "" }))).toBeUndefined();
  });

  it("returns undefined for a runId that has no stored snapshot (reads only stored data)", () => {
    const dir = mkdtempSync(join(tmpdir(), "qi-figma-adapter-"));
    try {
      const loader = makeFigmaSnapshotLoader(depsWith({ evidenceDir: dir }));
      expect(loader).toBeDefined();
      expect(loader?.("run-does-not-exist")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Drift seam: resolveLatestByScope (#735) ───────────────────────────────────────
//
// A pinned write-once snapshot can never drift under its own identity. With the option set, the
// loader resolves the LATEST snapshot of the same board scope and returns it when (and only when)
// its integrity hash differs — so re-check sees changed atoms while generate keeps exact pinning.

describe("makeFigmaSnapshotLoader — resolveLatestByScope", () => {
  const record = (dir: string, runId: string, fetchedAt: string, screenText: string): void => {
    const store = createNodeFigmaSnapshotStore(dir);
    const ir = {
      id: "s1",
      name: "Login",
      root: {
        id: "s1-root",
        name: "root",
        type: "FRAME",
        interactionHint: "container",
        text: screenText,
        imageFills: [],
        children: [],
      },
    };
    const screenHash = `h-${screenText}`;
    store.record({
      runId,
      provenance: { fileKey: "KEY", nodeId: "0:1", version: undefined, fetchedAt },
      integrityHash: hashSnapshot(1, undefined, [{ screenId: "s1", integrityHash: screenHash }]),
      screens: [
        {
          screenId: "s1",
          irJson: ir,
          integrityHash: screenHash,
          image: { mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50]) },
        },
      ],
      skippedScreens: [],
      links: [],
      tokens: { colors: [], typography: [], spacing: [], radius: [] },
    });
  };

  it("without the option, always returns the pinned record", () => {
    const dir = mkdtempSync(join(tmpdir(), "qi-figma-adapter-pin-"));
    try {
      record(dir, "fs-old", "2026-01-01T00:00:00.000Z", "alt");
      record(dir, "fs-new", "2026-02-01T00:00:00.000Z", "neu");
      const loader = makeFigmaSnapshotLoader(depsWith({ evidenceDir: dir }));
      expect(loader?.("fs-old")?.runId).toBe("fs-old");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the newest same-scope record when its integrity hash differs", () => {
    const dir = mkdtempSync(join(tmpdir(), "qi-figma-adapter-drift-"));
    try {
      record(dir, "fs-old", "2026-01-01T00:00:00.000Z", "alt");
      record(dir, "fs-new", "2026-02-01T00:00:00.000Z", "neu");
      const loader = makeFigmaSnapshotLoader(depsWith({ evidenceDir: dir }), {
        resolveLatestByScope: true,
      });
      expect(loader?.("fs-old")?.runId).toBe("fs-new");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the pinned record when the newest same-scope record has the same hash (no false drift)", () => {
    const dir = mkdtempSync(join(tmpdir(), "qi-figma-adapter-same-"));
    try {
      record(dir, "fs-old", "2026-01-01T00:00:00.000Z", "gleich");
      record(dir, "fs-new", "2026-02-01T00:00:00.000Z", "gleich");
      const loader = makeFigmaSnapshotLoader(depsWith({ evidenceDir: dir }), {
        resolveLatestByScope: true,
      });
      expect(loader?.("fs-old")?.runId).toBe("fs-old");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the pinned record when it is itself the newest for its scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "qi-figma-adapter-self-"));
    try {
      record(dir, "fs-only", "2026-01-01T00:00:00.000Z", "solo");
      const loader = makeFigmaSnapshotLoader(depsWith({ evidenceDir: dir }), {
        resolveLatestByScope: true,
      });
      expect(loader?.("fs-only")?.runId).toBe("fs-only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Capability-routed vision hint provider ────────────────────────────────────────

describe("makeFigmaVisionHintProvider", () => {
  it("returns [] when no multimodal capability is configured (IR-only degradation)", () => {
    const deps = depsWith({
      config: configWith([capability("text-chat", { supportsImageInput: false })]),
      configPresent: true,
    });
    const provider = makeFigmaVisionHintProvider(deps, () => ["should not be used"]);

    expect(provider(REQUEST)).toEqual([]);
  });

  it("returns [] when no config is present", () => {
    const provider = makeFigmaVisionHintProvider(depsWith({}), () => ["x"]);
    expect(provider(REQUEST)).toEqual([]);
  });

  it("returns [] when a multimodal model exists but no vision call is injected", () => {
    const deps = depsWith({
      config: configWith([capability("vision", { supportsImageInput: true })]),
      configPresent: true,
    });
    expect(makeFigmaVisionHintProvider(deps)(REQUEST)).toEqual([]);
  });

  it("routes the call through the capability-selected model id (no hard-coded id)", () => {
    const deps = depsWith({
      config: configWith([
        capability("text", { supportsImageInput: false }),
        capability("vision-low", { supportsImageInput: true, costClass: "low" }),
      ]),
      configPresent: true,
    });
    const seenModelIds: string[] = [];
    const provider = makeFigmaVisionHintProvider(deps, (_req, modelId) => {
      seenModelIds.push(modelId);
      return ["a real image-derived hint"];
    });

    expect(provider(REQUEST)).toEqual(["a real image-derived hint"]);
    expect(seenModelIds).toEqual(["vision-low"]);
  });

  it("swallows a thrown vision call to [] (a misbehaving model cannot break the run)", () => {
    const deps = depsWith({
      config: configWith([capability("vision", { supportsImageInput: true })]),
      configPresent: true,
    });
    const provider = makeFigmaVisionHintProvider(deps, () => {
      throw new Error("model exploded");
    });

    expect(provider(REQUEST)).toEqual([]);
  });

  it("drops non-string garbage entries from the call result", () => {
    const deps = depsWith({
      config: configWith([capability("vision", { supportsImageInput: true })]),
      configPresent: true,
    });
    const provider = makeFigmaVisionHintProvider(
      deps,
      () => [42, "kept", null, { a: 1 }] as unknown as readonly string[],
    );

    expect(provider(REQUEST)).toEqual(["kept"]);
  });
});
