import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  governedSnapshotBuild,
  figmaTokenStoreFor,
  readFigmaVaultToken,
  type GovernedSnapshotDeps,
} from "../figmaSnapshotOrchestration.js";
import {
  NO_FIGMA_KEYCHAIN,
  loadFigmaConnectorAudit,
  hasReadOnlyConsent,
  deriveFigmaScopeRef,
  type FigmaHttpPort,
  type FigmaRenderPort,
} from "../figma/index.js";
import { createNodeFigmaSnapshotStore } from "@oscharko-dev/keiko-evidence";

// ─── Synthetic board (NO customer data) ─────────────────────────────────────────

const SOLID = (hex: { r: number; g: number; b: number }): Record<string, unknown> => ({
  type: "SOLID",
  color: { ...hex, a: 1 },
});
const TEXT_STYLE = { fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeightPx: 24 };

// canvas → 2 screens; screen s1 has a TEXT (colour + typography → tokens) and a node with a prototype
// reaction navigating to s2 (→ a nav transition / link). Shallow enough that one depth fetch captures all.
const BOARD = {
  id: "0:1",
  name: "Canvas",
  type: "CANVAS",
  children: [
    {
      id: "1:1",
      name: "Login",
      type: "FRAME",
      children: [
        {
          id: "1:2",
          name: "Title",
          type: "TEXT",
          characters: "Welcome",
          fills: [SOLID({ r: 0, g: 0, b: 0 })],
          style: TEXT_STYLE,
          absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 24 },
        },
        {
          id: "1:3",
          name: "Submit btn",
          type: "FRAME",
          fills: [SOLID({ r: 0.1, g: 0.4, b: 0.9 })],
          cornerRadius: 8,
          absoluteBoundingBox: { x: 0, y: 40, width: 120, height: 40 },
          reactions: [
            { action: { type: "NODE", destinationId: "2:1" }, trigger: { type: "ON_CLICK" } },
          ],
        },
      ],
    },
    {
      id: "2:1",
      name: "Home",
      type: "FRAME",
      children: [
        {
          id: "2:2",
          name: "Heading",
          type: "TEXT",
          characters: "Home",
          fills: [SOLID({ r: 0.2, g: 0.2, b: 0.2 })],
          style: TEXT_STYLE,
          absoluteBoundingBox: { x: 0, y: 0, width: 80, height: 24 },
        },
      ],
    },
  ],
};

const URL_OK = "https://www.figma.com/design/KEY123/Board?node-id=0-1";
const TOKEN = "figd_env-test-token";

// One HTTP port serving BOTH the scoped nodes fetch and the /v1/images render-url call.
const findById = (n: Record<string, unknown>, id: string): Record<string, unknown> | undefined => {
  if (n.id === id) return n;
  for (const c of (Array.isArray(n.children) ? n.children : []) as Record<string, unknown>[]) {
    const hit = findById(c, id);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

interface PortRecorder {
  readonly port: FigmaHttpPort;
  readonly tokens: string[];
}

const httpPort = (): PortRecorder => {
  const tokens: string[] = [];
  const port: FigmaHttpPort = (request) => {
    tokens.push(request.headers["X-Figma-Token"] ?? "");
    const url = new URL(request.url);
    if (url.pathname.includes("/v1/images/")) {
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      const images: Record<string, string> = {};
      for (const id of ids) images[id] = `https://ephemeral/${encodeURIComponent(id)}.png`;
      return Promise.resolve({ status: 200, json: { images }, headers: {} });
    }
    const id = url.searchParams.get("ids") ?? "";
    const doc = findById(BOARD, id);
    if (doc === undefined) return Promise.resolve({ status: 404, json: {}, headers: {} });
    return Promise.resolve({
      status: 200,
      json: { nodes: { [id]: { document: doc } } },
      headers: {},
    });
  };
  return { port, tokens };
};

const renderPort: FigmaRenderPort = () =>
  Promise.resolve({ status: 200, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), headers: {} });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keiko-figma-orch-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const depsWith = (over: Partial<GovernedSnapshotDeps> = {}): GovernedSnapshotDeps => ({
  evidenceDir: dir,
  env: { FIGMA_ACCESS_TOKEN: TOKEN },
  now: "2026-06-09T00:00:00.000Z",
  httpPort: httpPort().port,
  renderPort,
  keychainAccess: NO_FIGMA_KEYCHAIN,
  ...over,
});

// ─── Consent gate (#760) ────────────────────────────────────────────────────────

describe("governedSnapshotBuild — consent gate (#760)", () => {
  it("refuses with FIGMA_CONSENT_REQUIRED before any fetch when consent is not acknowledged", async () => {
    const rec = httpPort();
    await expect(
      governedSnapshotBuild(URL_OK, depsWith({ httpPort: rec.port, acknowledgeReadOnly: false })),
    ).rejects.toMatchObject({ code: "FIGMA_CONSENT_REQUIRED" });
    // The gate fires BEFORE egress — the HTTP port was never called.
    expect(rec.tokens).toHaveLength(0);
  });

  it("records consent and proceeds when the read-only scope is acknowledged", async () => {
    await governedSnapshotBuild(URL_OK, depsWith({ acknowledgeReadOnly: true }));
    const scopeRef = deriveFigmaScopeRef("KEY123", "0:1");
    expect(hasReadOnlyConsent(scopeRef, dir)).toBe(true);
  });
});

// ─── Vault-token precedence (#758) ──────────────────────────────────────────────

describe("governedSnapshotBuild — vault token precedence (#758)", () => {
  it("uses the stored vault PAT over the env token in the X-Figma-Token header", async () => {
    figmaTokenStoreFor({ env: {}, evidenceDir: dir, keychainAccess: NO_FIGMA_KEYCHAIN }).store(
      "figd_vault-pat",
    );
    expect(readFigmaVaultToken(depsWith())).toBe("figd_vault-pat");
    const rec = httpPort();
    await governedSnapshotBuild(
      URL_OK,
      depsWith({ httpPort: rec.port, acknowledgeReadOnly: true }),
    );
    expect(rec.tokens.every((t) => t === "figd_vault-pat")).toBe(true);
    expect(rec.tokens).not.toContain(TOKEN);
  });

  it("falls back to the env token when no vault token is stored (graceful)", async () => {
    expect(readFigmaVaultToken(depsWith())).toBeUndefined();
    const rec = httpPort();
    await governedSnapshotBuild(
      URL_OK,
      depsWith({ httpPort: rec.port, acknowledgeReadOnly: true }),
    );
    expect(rec.tokens.every((t) => t === TOKEN)).toBe(true);
  });
});

// ─── Audit + metrics (#760) ─────────────────────────────────────────────────────

describe("governedSnapshotBuild — audit + metrics (#760)", () => {
  it("audits a successful snapshot with counts, and computes nav-graph + a11y + token metrics", async () => {
    const result = await governedSnapshotBuild(URL_OK, depsWith({ acknowledgeReadOnly: true }));
    const audit = loadFigmaConnectorAudit(result.scopeRef, dir);
    expect(audit?.auditLog.at(-1)).toMatchObject({ action: "snapshot", outcome: "ok" });
    expect(audit?.auditLog.at(-1)?.counts?.designTokens).toBeGreaterThan(0);
    // Metrics surface the governance numbers the AC requires.
    expect(result.metrics.designTokenCount).toBeGreaterThan(0);
    expect(result.metrics.navGraph).toEqual({ screens: 2, transitions: 1 });
    expect(result.metrics.a11y?.findings).toBeGreaterThanOrEqual(0);
    expect(result.metrics.augmentation.modelAugmentedShare).toBe(0);
  });

  it("audits a re-snapshot action distinctly", async () => {
    const result = await governedSnapshotBuild(
      URL_OK,
      depsWith({ acknowledgeReadOnly: true }),
      true,
    );
    const audit = loadFigmaConnectorAudit(result.scopeRef, dir);
    expect(audit?.auditLog.at(-1)?.action).toBe("resnapshot");
  });

  it("audits a fetch failure with the coded error and re-raises", async () => {
    const failPort: FigmaHttpPort = () => Promise.resolve({ status: 403, json: {}, headers: {} });
    await expect(
      governedSnapshotBuild(URL_OK, depsWith({ httpPort: failPort, acknowledgeReadOnly: true })),
    ).rejects.toMatchObject({ code: "FIGMA_TOKEN_INVALID" });
    const audit = loadFigmaConnectorAudit(deriveFigmaScopeRef("KEY123", "0:1"), dir);
    expect(audit?.auditLog.at(-1)).toMatchObject({
      outcome: "error",
      errorCode: "FIGMA_TOKEN_INVALID",
    });
  });
});

// ─── links (#811) + tokens (#752) round-trip through the store ───────────────────

describe("governedSnapshotBuild — links + tokens persist round-trip (#753/#752)", () => {
  it("carries inter-screen links + design tokens that survive a store record→load", async () => {
    const result = await governedSnapshotBuild(URL_OK, depsWith({ acknowledgeReadOnly: true }));
    // The build produced both, the route persists both — round-trip through the real store.
    const links = result.snapshot.links ?? [];
    expect(links.length).toBeGreaterThan(0);
    expect(result.ir.tokens.colors.length).toBeGreaterThan(0);

    const store = createNodeFigmaSnapshotStore(dir);
    store.record({
      runId: "fs-orch-test",
      provenance: result.provenance,
      integrityHash: result.snapshot.integrityHash,
      screens: result.snapshot.screens.map((s) => ({
        screenId: s.screenId,
        irJson: s.ir,
        integrityHash: s.integrityHash,
        image: { mimeType: "image/png" as const, bytes: s.image.bytes },
      })),
      skippedScreens: [],
      links,
      tokens: result.ir.tokens,
    });
    const loaded = createNodeFigmaSnapshotStore(dir).load("fs-orch-test");
    expect(loaded?.links?.length).toBeGreaterThan(0);
    expect(loaded?.tokens).toBeDefined();
  });
});

// ─── provenance.fetchedAt threading (#753) ──────────────────────────────────────

describe("governedSnapshotBuild — provenance.fetchedAt threading (#753)", () => {
  it("sets provenance.fetchedAt to deps.now (not the epoch)", async () => {
    const result = await governedSnapshotBuild(URL_OK, depsWith({ acknowledgeReadOnly: true }));
    expect(result.provenance.fetchedAt).toBe("2026-06-09T00:00:00.000Z");
    expect(result.snapshot.provenance.fetchedAt).toBe("2026-06-09T00:00:00.000Z");
  });

  it("integrity hash is stable when only deps.now changes (fetchedAt excluded from hash)", async () => {
    const r1 = await governedSnapshotBuild(
      URL_OK,
      depsWith({ now: "2026-01-01T00:00:00.000Z", acknowledgeReadOnly: true }),
    );
    const r2 = await governedSnapshotBuild(
      URL_OK,
      depsWith({ now: "2026-06-09T12:34:56.789Z", acknowledgeReadOnly: true }),
    );
    expect(r1.snapshot.integrityHash).toBe(r2.snapshot.integrityHash);
    // fetchedAt differs — confirming the two runs are distinct
    expect(r1.snapshot.provenance.fetchedAt).not.toBe(r2.snapshot.provenance.fetchedAt);
  });
});

// ─── revoke (#758/#760) ─────────────────────────────────────────────────────────

describe("figma token vault — revoke (#758)", () => {
  it("removes the stored vault PAT", () => {
    const store = figmaTokenStoreFor({
      env: {},
      evidenceDir: dir,
      keychainAccess: NO_FIGMA_KEYCHAIN,
    });
    store.store("figd_to-remove");
    expect(store.read()).toBe("figd_to-remove");
    store.revoke();
    expect(store.read()).toBeUndefined();
  });
});
