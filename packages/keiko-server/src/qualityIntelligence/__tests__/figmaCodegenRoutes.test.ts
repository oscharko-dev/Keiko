import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { handleFigmaGenerateCode, type FigmaCodegenResponse } from "../figmaCodegenRoutes.js";
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
    integrityHash: "hash",
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
    expect(s1).toContain('href="s2.html"');
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
});
