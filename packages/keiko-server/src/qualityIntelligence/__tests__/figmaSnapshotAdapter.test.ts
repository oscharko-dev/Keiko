// Unit tests for the figma-snapshot server seam (Epic #750, Issue #754).
//
// Covers: the snapshot LOADER (undefined when no evidence dir; reads only the stored snapshot via
// the evidence store, never Figma), and the capability-routed VISION hint provider (routes via
// resolveQiMultimodalSelection only — no hard-coded model id; returns [] when no multimodal
// capability, when no call is injected, and when the call throws or returns garbage).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import type {
  GatewayRequest,
  ModelCapability,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";
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
  snapshotRunId: "snap-1",
  screenId: "s1",
  image: {
    mimeType: "image/png",
    relativePath: "screen-s1.png",
    sha256: "0".repeat(64),
    byteLength: 2,
  },
  imageRelativePath: "screen-s1.png",
  baselineText: "Screen: S1 [s1]",
};

const normalizedResponse = (content: string, modelId = "vision"): NormalizedResponse => ({
  modelId,
  content,
  finishReason: "stop",
  toolCalls: [],
  structuredOutput: null,
  usage: {
    requestId: "req-test",
    promptTokens: 1,
    completionTokens: 1,
    latencyMs: 1,
    costClass: "low",
  },
});

function recordVisionSnapshot(dir: string): {
  readonly loaded: NonNullable<ReturnType<ReturnType<typeof createNodeFigmaSnapshotStore>["load"]>>;
  readonly screen: NonNullable<
    ReturnType<ReturnType<typeof createNodeFigmaSnapshotStore>["load"]>
  >["screens"][number];
} {
  const store = createNodeFigmaSnapshotStore(dir);
  store.record({
    runId: "snap-1",
    provenance: {
      fileKey: "KEY",
      nodeId: "0:1",
      version: undefined,
      fetchedAt: "2026-01-01T00:00:00.000Z",
    },
    integrityHash: hashSnapshot(1, undefined, [{ screenId: "s1", integrityHash: "h-vision" }]),
    screens: [
      {
        screenId: "s1",
        irJson: {
          id: "s1",
          name: "Login",
          root: {
            id: "s1-root",
            name: "root",
            type: "FRAME",
            interactionHint: "container",
            text: "",
            imageFills: [],
            children: [],
          },
        },
        integrityHash: "h-vision",
        image: { mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50]) },
      },
    ],
    skippedScreens: [],
    links: [],
    tokens: { colors: [], typography: [], spacing: [], radius: [] },
  });
  const loaded = store.load("snap-1");
  if (loaded === undefined) throw new Error("expected stored snapshot");
  const screen = loaded.screens[0];
  if (screen === undefined) throw new Error("expected screen");
  return { loaded, screen };
}

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

  it("falls back to the pinned record when the newest record fails to load (TOCTOU ?? pinned)", () => {
    // Arrange: write two snapshots with different content so drift is detected (newest ≠ pinned).
    // Then tamper the newest record file so store.load("fs-new") returns undefined (schema-invalid)
    // while listByScope still lists it as newest (parseScopeEntry is header-only, no schema check).
    // This exercises the `?? pinned` fallback on adapter line 68.
    //
    // Tamper mechanism: inject an unknown top-level key into the on-disk JSON — this trips the
    // ALLOWED_TOP_LEVEL_KEYS guard in validateFigmaSnapshotRecord(), which returns {ok:false},
    // so loadOp returns undefined WITHOUT throwing (the outer catch is NOT involved).
    // parseScopeEntry reads only provenance.{fileKey,nodeId,fetchedAt}, runId, and integrityHash —
    // all of which remain intact — so listByScope still returns "fs-new" as the most-recent entry.
    const dir = mkdtempSync(join(tmpdir(), "qi-figma-adapter-toctou-"));
    try {
      record(dir, "fs-old", "2026-01-01T00:00:00.000Z", "alt");
      record(dir, "fs-new", "2026-02-01T00:00:00.000Z", "neu");

      // Tamper fs-new on disk by injecting an unknown top-level key.
      const recordFile = join(dir, "qi", "fs-new.figma-snapshot.json");
      const raw = JSON.parse(readFileSync(recordFile, "utf8")) as Record<string, unknown>;
      raw.__tampered__ = true; // unknown key → validateFigmaSnapshotRecord fails → load() = undefined
      writeFileSync(recordFile, JSON.stringify(raw), "utf8");

      // Pre-condition verification: store.load("fs-new") must return undefined (not throw),
      // and listByScope must still return "fs-new" as the first (newest) entry.
      const store = createNodeFigmaSnapshotStore(dir);
      expect(store.load("fs-new")).toBeUndefined();
      expect(store.listByScope("KEY", "0:1")[0]?.runId).toBe("fs-new");

      // Act: loader with resolveLatestByScope detects drift (fs-new's hash ≠ fs-old's hash via
      // listByScope header) and tries store.load("fs-new") → undefined → falls back via ?? pinned.
      const loader = makeFigmaSnapshotLoader(depsWith({ evidenceDir: dir }), {
        resolveLatestByScope: true,
      });

      // Assert: fallback to the pinned record (fs-old), not undefined, not fs-new.
      // The invariant: drift detection MUST degrade to "fresh", never crash the re-check.
      expect(loader?.("fs-old")?.runId).toBe("fs-old");
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

  it("returns [] when a multimodal model exists but no evidence dir is configured", async () => {
    const deps = depsWith({
      config: configWith([capability("vision", { supportsImageInput: true })]),
      configPresent: true,
    });
    expect(await makeFigmaVisionHintProvider(deps)(REQUEST)).toEqual([]);
  });

  it("routes stored snapshot images through the selected gateway model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qi-figma-adapter-vision-"));
    const seenRequests: GatewayRequest[] = [];
    try {
      const { loaded, screen } = recordVisionSnapshot(dir);
      const port: ModelPort = {
        call: (request) => {
          seenRequests.push(request);
          return Promise.resolve(
            normalizedResponse(JSON.stringify(["Primary CTA is visually disabled"]), "vision-low"),
          );
        },
      };
      const deps = depsWith({
        config: configWith([capability("vision-low", { supportsImageInput: true })]),
        configPresent: true,
        evidenceDir: dir,
        modelPortFactory: () => port,
      });

      const provider = makeFigmaVisionHintProvider(deps);
      await expect(
        provider({
          snapshotRunId: loaded.runId,
          screenId: screen.screenId,
          image: screen.image,
          imageRelativePath: screen.image.relativePath,
          baselineText: "Screen: Login [s1]",
        }),
      ).resolves.toEqual(["Primary CTA is visually disabled"]);

      const user = seenRequests[0]?.messages[1];
      expect(seenRequests[0]?.modelId).toBe("vision-low");
      expect(user?.content).toContain("Screen id:");
      const textPart = user?.contentParts?.find((part) => part.type === "text");
      const imagePart = user?.contentParts?.find((part) => part.type === "image_url");
      expect(textPart?.text).toContain("Screen id:");
      expect(imagePart?.image_url.url).toMatch(/^data:image\/png;base64,/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("drops non-JSON vision output instead of persisting free-form rationale lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qi-figma-adapter-vision-rationale-"));
    try {
      const { loaded, screen } = recordVisionSnapshot(dir);
      const port: ModelPort = {
        call: () =>
          Promise.resolve(
            normalizedResponse("Reasoning: the screenshot suggests a disabled submit button."),
          ),
      };
      const deps = depsWith({
        config: configWith([capability("vision", { supportsImageInput: true })]),
        configPresent: true,
        evidenceDir: dir,
        modelPortFactory: () => port,
      });

      await expect(
        makeFigmaVisionHintProvider(deps)({
          snapshotRunId: loaded.runId,
          screenId: screen.screenId,
          image: screen.image,
          imageRelativePath: screen.image.relativePath,
          baselineText: "Screen: Login [s1]",
        }),
      ).resolves.toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
