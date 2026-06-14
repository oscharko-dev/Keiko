import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { handleFigmaGenerateCode, type FigmaCodegenResponse } from "../figmaCodegenRoutes.js";
import { hashSnapshot } from "../figma/figmaSnapshotHash.js";
import { createNodeFigmaSnapshotStore } from "@oscharko-dev/keiko-evidence";
import type { RouteContext } from "../../routes.js";
import type { UiHandlerDeps } from "../../deps.js";

// ─── Synthetic stored snapshot (NO customer data) ───────────────────────────────

const irNode = (
  id: string,
  hint: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  name: id,
  type: "FRAME",
  interactionHint: hint,
  imageFills: [],
  children: [],
  ...over,
});

const screenIr = (id: string, rootChildren: unknown[]): Record<string, unknown> => ({
  id,
  name: id === "s1" ? "Login" : "Home",
  root: irNode(`${id}-root`, "container", { children: rootChildren }),
});

const TOKENS = {
  colors: [{ id: "color:#000000", kind: "color", value: "#000000" }],
  typography: [
    {
      id: "typography:Inter|16|400|24",
      kind: "typography",
      fontFamily: "Inter",
      fontSize: 16,
      fontWeight: 400,
      lineHeight: 24,
    },
  ],
  spacing: [{ id: "spacing:8", kind: "spacing", value: 8 }],
  radius: [{ id: "radius:4", kind: "radius", value: 4 }],
};

const seedSnapshot = (dir: string, runId: string): void => {
  const store = createNodeFigmaSnapshotStore(dir);
  const img = { mimeType: "image/png" as const, bytes: new Uint8Array([0x89, 0x50]) };
  store.record({
    runId,
    provenance: {
      fileKey: "KEY",
      nodeId: "0:1",
      version: undefined,
      fetchedAt: "1970-01-01T00:00:00.000Z",
    },
    // The store re-verifies the snapshot-level integrity hash on load, so the fixture
    // must persist the genuinely recomputable value (per-screen hashes may stay synthetic).
    integrityHash: hashSnapshot(1, undefined, [
      { screenId: "s1", integrityHash: "h1" },
      { screenId: "s2", integrityHash: "h2" },
    ]),
    screens: [
      {
        screenId: "s1",
        irJson: screenIr("s1", [
          irNode("s1-title", "text", { text: "Welcome" }),
          irNode("s1-btn", "button", { text: "Continue" }),
        ]),
        integrityHash: "h1",
        image: img,
      },
      {
        screenId: "s2",
        irJson: screenIr("s2", [irNode("s2-h", "text", { text: "Home" })]),
        integrityHash: "h2",
        image: img,
      },
    ],
    skippedScreens: [],
    links: [{ sourceNodeId: "s1-btn", trigger: "ON_CLICK", targetNodeId: "s2-root" }],
    tokens: TOKENS,
  });
};

const ctxFor = (runId: string): RouteContext =>
  ({
    params: { runId },
    req: {} as IncomingMessage,
    url: new URL(`http://x/api/figma/snapshots/${runId}/code`),
  }) as unknown as RouteContext;

const depsFor = (dir: string): UiHandlerDeps => ({ evidenceDir: dir }) as unknown as UiHandlerDeps;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keiko-figma-codegen-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const body = (result: ReturnType<typeof handleFigmaGenerateCode>): FigmaCodegenResponse =>
  (result as { body: FigmaCodegenResponse }).body;

const ISO_EPOCH = "1970-01-01T00:00:00.000Z";

const errCode = (result: ReturnType<typeof handleFigmaGenerateCode>): string =>
  (result as { body: { error: { code: string } } }).body.error.code;

describe("handleFigmaGenerateCode (#755)", () => {
  it("emits a reviewable html-css artifact for a stored snapshot", () => {
    seedSnapshot(dir, "fs-1");
    const result = handleFigmaGenerateCode(ctxFor("fs-1"), depsFor(dir));
    expect(result.status).toBe(200);
    const b = body(result);
    expect(b.adapterName).toBe("html-css");
    expect(b.screenCount).toBe(2);
    const paths = b.files.map((f) => f.path);
    expect(paths).toContain("index.html");
    expect(paths).toContain("tokens.css");
    expect(paths).toContain("screens/s1.html");
    expect(paths).toContain("screens/s2.html");
  });

  it("consumes the design tokens (#752) — the token table references the extracted values", () => {
    seedSnapshot(dir, "fs-2");
    const b = body(handleFigmaGenerateCode(ctxFor("fs-2"), depsFor(dir)));
    const tokensCss = b.files.find((f) => f.path === "tokens.css")?.contents ?? "";
    expect(tokensCss).toContain("#000000"); // the extracted colour token
    expect(tokensCss).toContain("Inter"); // the extracted typography token
    expect(tokensCss).toContain("8px"); // spacing
  });

  it("wires routing hints (#811) — the source screen carries a nav anchor to its target", () => {
    seedSnapshot(dir, "fs-3");
    const b = body(handleFigmaGenerateCode(ctxFor("fs-3"), depsFor(dir)));
    const s1 = b.files.find((f) => f.path === "screens/s1.html")?.contents ?? "";
    // './' prefix keeps INSTANCE-style screen ids from parsing as URI schemes in the href.
    expect(s1).toContain('href="./s2.html"');
    expect(s1).toContain("Welcome"); // text-aware emission carries the IR text
  });

  it("is deterministic — the same stored snapshot yields a byte-identical artifact", () => {
    seedSnapshot(dir, "fs-4");
    const a = body(handleFigmaGenerateCode(ctxFor("fs-4"), depsFor(dir)));
    const b = body(handleFigmaGenerateCode(ctxFor("fs-4"), depsFor(dir)));
    expect(JSON.stringify(a.files)).toBe(JSON.stringify(b.files));
  });

  it("404s an unknown snapshot run id", () => {
    expect(handleFigmaGenerateCode(ctxFor("missing"), depsFor(dir)).status).toBe(404);
  });

  it("503s when no evidence dir is configured", () => {
    expect(handleFigmaGenerateCode(ctxFor("x"), {} as UiHandlerDeps).status).toBe(503);
  });

  it("422s when the snapshot has no parseable screen (FIGMA_CODEGEN_NO_SCREENS)", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    const img = { mimeType: "image/png" as const, bytes: new Uint8Array([0x89, 0x50]) };
    // irJson is an opaque value; a non-object cannot be parsed into a Screen-IR → dropped → 0 screens.
    store.record({
      runId: "bad-1",
      provenance: { fileKey: "KEY", nodeId: "0:1", version: undefined, fetchedAt: ISO_EPOCH },
      integrityHash: hashSnapshot(1, undefined, [{ screenId: "s1", integrityHash: "h1" }]),
      screens: [{ screenId: "s1", irJson: "not-an-object", integrityHash: "h1", image: img }],
      skippedScreens: [],
      links: [],
      tokens: TOKENS,
    });
    const result = handleFigmaGenerateCode(ctxFor("bad-1"), depsFor(dir));
    expect(result.status).toBe(422);
    expect(errCode(result)).toBe("FIGMA_CODEGEN_NO_SCREENS");
  });

  it("500s when the stored snapshot cannot be read (FIGMA_INTERNAL)", () => {
    seedSnapshot(dir, "corrupt-1");
    // Corrupt the persisted record so the store throws at the read boundary (invalid JSON).
    writeFileSync(join(dir, "qi", "corrupt-1.figma-snapshot.json"), "}{ not valid json");
    const result = handleFigmaGenerateCode(ctxFor("corrupt-1"), depsFor(dir));
    expect(result.status).toBe(500);
    expect(errCode(result)).toBe("FIGMA_INTERNAL");
  });

  it("persists the reviewable artifact to the evidence dir (.figma-codegen.json)", () => {
    seedSnapshot(dir, "persist-1");
    expect(handleFigmaGenerateCode(ctxFor("persist-1"), depsFor(dir)).status).toBe(200);
    const artifactFile = join(dir, "qi", "persist-1.figma-codegen.json");
    expect(existsSync(artifactFile)).toBe(true);
    const persisted = JSON.parse(readFileSync(artifactFile, "utf8")) as {
      adapterName: string;
      figmaCodegenSchemaVersion: number;
      files: unknown[];
    };
    expect(persisted.adapterName).toBe("html-css");
    expect(persisted.figmaCodegenSchemaVersion).toBe(1);
    expect(persisted.files.length).toBeGreaterThan(0);
  });

  it("strips unsafe bidi/zero-width format chars from board content end-to-end", () => {
    const store = createNodeFigmaSnapshotStore(dir);
    const img = { mimeType: "image/png" as const, bytes: new Uint8Array([0x89, 0x50]) };
    const RLO = String.fromCodePoint(0x202e); // right-to-left override
    const ZWSP = String.fromCodePoint(0x200b); // zero-width space (secret-splitting)
    store.record({
      runId: "bidi-1",
      provenance: { fileKey: "KEY", nodeId: "0:1", version: undefined, fetchedAt: ISO_EPOCH },
      integrityHash: hashSnapshot(1, undefined, [{ screenId: "s1", integrityHash: "h1" }]),
      screens: [
        {
          screenId: "s1",
          irJson: screenIr("s1", [irNode("s1-title", "text", { text: `He${RLO}llo${ZWSP}` })]),
          integrityHash: "h1",
          image: img,
        },
      ],
      skippedScreens: [],
      links: [],
      tokens: TOKENS,
    });
    const b = body(handleFigmaGenerateCode(ctxFor("bidi-1"), depsFor(dir)));
    // bidi embedding/override (U+202A–U+202E), LRM/RLM + zero-width (U+200B–U+200F), and BOM (U+FEFF).
    const UNSAFE_RE = /[\u200b-\u200f\u202a-\u202e\ufeff]/u;
    for (const f of b.files) expect(UNSAFE_RE.test(f.contents)).toBe(false);
    expect(b.files.some((f) => f.contents.includes("Hello"))).toBe(true);
  });
});
