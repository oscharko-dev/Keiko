import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONNECTED_FOLDER_TOOL_LIMITS,
  type ConnectedFolderToolFailureReason,
  type ConnectedFolderToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/connected-folder-tool";
import {
  createConnectedFolderToolBudget,
  executeConnectedFolderToolRequest,
  type ConnectedFolderToolOptions,
} from "./connectedFolderTool.js";
import { detectWorkspaceAt } from "./detect.js";
import type { SearchScope } from "./repoSearch.js";

// Assembled from fragments, so a secret scanner never sees a token-shaped literal.
const ISSUER_TOKEN = ["ghp_", "AbCdEfGhIjKlMnOpQrSt", "UvWxYz0123456789"].join("");
const MANY = 230;
const GUIDE = [
  "# Projekt Eisvogel",
  "",
  "Der Kostenrahmen beträgt 120000 Euro.",
  "Die Leitung hat Dr. Miriam Brandt.",
  "Start ist im März.",
  "Standort ist Lübeck.",
  "",
].join("\n");

let root = "";
let scope: SearchScope;

function put(relativePath: string, content: string | Buffer): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-folder-tool-"));
  put("docs/guide.md", GUIDE);
  put("docs/notes/wartung.txt", "Wartungsfenster Kolibri-7: Sonntag 02:00 Uhr\n");
  put("docs/notes/token.txt", `Zugang für den Dienst\napi token ${ISSUER_TOKEN}\nEnde\n`);
  put("finanzen/q1.csv", "Quartal;Kosten\nQ1;4100\n");
  put("finanzen/q2.csv", "Quartal;Kosten\nQ2;5300\n");
  put("bilder/logo.bin", Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]));
  put(".env", "GEHEIM=1\n");
  for (let index = 0; index < MANY; index += 1) {
    put(`viele/datei-${String(index).padStart(3, "0")}.txt`, `Inhalt ${String(index)}\n`);
  }
  scope = {
    workspace: { ...detectWorkspaceAt(root), contentRedaction: "preserve" },
    scopeId: "connected-folder-tool-test",
    relativePaths: [],
  };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(
  request: unknown,
  options: ConnectedFolderToolOptions = {},
  selected: SearchScope = scope,
): Promise<ConnectedFolderToolResult> {
  return executeConnectedFolderToolRequest(selected, request, options);
}

type Success<View extends string> = Extract<
  ConnectedFolderToolResult,
  { readonly ok: true; readonly view: View }
>;

function succeeded<View extends "list" | "search" | "read">(
  result: ConnectedFolderToolResult,
  view: View,
): Success<View> {
  if (!result.ok || result.view !== view) {
    throw new Error(`expected a successful ${view}, got ${JSON.stringify(result)}`);
  }
  return result as Success<View>;
}

function reasonOf(result: ConnectedFolderToolResult): ConnectedFolderToolFailureReason | "ok" {
  return result.ok ? "ok" : result.reason;
}

describe("connected folder tool: list", () => {
  it("lists the direct children of the connected root, sorted, without denied entries", async () => {
    const listed = succeeded(await run({ view: "list", directory: "", after: "" }), "list");
    expect(listed.entries.map((entry) => `${entry.kind}:${entry.relativePath}`)).toEqual([
      "directory:bilder",
      "directory:docs",
      "directory:finanzen",
      "directory:viele",
    ]);
    expect(listed.nextAfter).toBeUndefined();
    expect(listed.coverageIncomplete).toBe(false);
  });

  it("lists one level only", async () => {
    const listed = succeeded(await run({ view: "list", directory: "docs", after: "" }), "list");
    expect(listed.entries.map((entry) => entry.relativePath)).toEqual([
      "docs/guide.md",
      "docs/notes",
    ]);
  });

  it("pages a directory larger than one result without losing or repeating an entry", async () => {
    const seen: string[] = [];
    let after = "";
    for (let page = 0; page < 10; page += 1) {
      const listed = succeeded(await run({ view: "list", directory: "viele", after }), "list");
      expect(listed.entries.length).toBeLessThanOrEqual(CONNECTED_FOLDER_TOOL_LIMITS.listEntries);
      seen.push(...listed.entries.map((entry) => entry.relativePath));
      if (listed.nextAfter === undefined) break;
      after = listed.nextAfter;
    }
    expect(seen).toHaveLength(MANY);
    expect(new Set(seen).size).toBe(MANY);
    expect(seen).toEqual([...seen].sort());
  });

  it("refuses a directory that does not exist", async () => {
    expect(reasonOf(await run({ view: "list", directory: "fehlt", after: "" }))).toBe(
      "invalid-request",
    );
  });
});

describe("connected folder tool: search", () => {
  it("finds a term anywhere in the folder and returns the matching lines", async () => {
    const found = succeeded(
      await run({
        view: "search",
        mode: "keywords",
        query: "Kostenrahmen",
        directory: "",
        maxResults: 5,
      }),
      "search",
    );
    const hit = found.hits.find((entry) => entry.path === "docs/guide.md");
    expect(hit?.text).toContain("Kostenrahmen beträgt 120000");
    expect(hit?.startLine).toBeLessThanOrEqual(3);
    expect(hit?.endLine).toBeGreaterThanOrEqual(3);
    expect(found.unavailableHits).toBe(0);
  });

  it("matches a literal with punctuation", async () => {
    const found = succeeded(
      await run({
        view: "search",
        mode: "literal",
        query: "Kolibri-7",
        directory: "",
        maxResults: 5,
      }),
      "search",
    );
    expect(found.hits.map((hit) => hit.path)).toEqual(["docs/notes/wartung.txt"]);
  });

  it("searches only below a narrowed directory", async () => {
    const found = succeeded(
      await run({
        view: "search",
        mode: "keywords",
        query: "Kosten",
        directory: "finanzen",
        maxResults: 12,
      }),
      "search",
    );
    expect(found.hits.length).toBeGreaterThan(0);
    expect(found.hits.every((hit) => hit.path.startsWith("finanzen/"))).toBe(true);
    expect(found.filesScanned).toBe(2);
  });

  it("returns no more hits than requested and says that more exist", async () => {
    const found = succeeded(
      await run({
        view: "search",
        mode: "keywords",
        query: "Inhalt",
        directory: "viele",
        maxResults: 3,
      }),
      "search",
    );
    expect(found.hits).toHaveLength(3);
    expect(found.truncated).toBe(true);
  });

  it("answers a query without matches with an empty result", async () => {
    const found = succeeded(
      await run({
        view: "search",
        mode: "literal",
        query: "zzzqqqxxx",
        directory: "",
        maxResults: 5,
      }),
      "search",
    );
    expect(found.hits).toEqual([]);
    expect(found.truncated).toBe(false);
  });
});

describe("connected folder tool: read", () => {
  it("reads a line window and names the next line", async () => {
    const read = succeeded(
      await run({ view: "read", path: "docs/guide.md", startLine: 3, maxLines: 2 }),
      "read",
    );
    expect(read.excerpt).toMatchObject({ path: "docs/guide.md", startLine: 3, endLine: 4 });
    expect(read.excerpt.text).toContain("Kostenrahmen");
    expect(read.excerpt.text).toContain("Miriam Brandt");
    expect(read.excerpt.text).not.toContain("Lübeck");
    expect(read.nextStartLine).toBe(5);
  });

  it("continues a byte-cut window at the first line it did not return in full", async () => {
    const own = mkdtempSync(join(tmpdir(), "keiko-folder-tool-cut-"));
    try {
      const lines = Array.from(
        { length: 100 },
        (_, index) => `Zeile ${String(index + 1).padStart(3, "0")} ${"x".repeat(110)}`,
      );
      writeFileSync(join(own, "lang.txt"), `${lines.join("\n")}\n`);
      writeFileSync(join(own, "breit.txt"), `${"y".repeat(20_000)}\nZweite Zeile\n`);
      const ownScope: SearchScope = {
        workspace: { ...detectWorkspaceAt(own), contentRedaction: "preserve" },
        scopeId: "connected-folder-tool-cut",
        relativePaths: [],
      };
      const read = async (path: string, startLine: number): Promise<Success<"read">> =>
        succeeded(
          await run({ view: "read", path, startLine, maxLines: 200 }, {}, ownScope),
          "read",
        );
      const texts: string[] = [];
      let next: number | undefined = 1;
      for (let call = 0; next !== undefined && call < 10; call += 1) {
        const window = await read("lang.txt", next);
        texts.push(window.excerpt.text);
        next = window.nextStartLine;
      }
      expect(texts.length).toBeGreaterThan(1);
      // Following nextStartLine returns every line in full: none is skipped after a cut.
      const returned = texts.flatMap((text) => text.split("\n"));
      for (const line of lines) expect(returned).toContain(line);
      // A single line wider than the window still makes progress.
      const wide = await read("breit.txt", 1);
      expect(wide.excerpt.truncated).toBe(true);
      expect(wide.nextStartLine).toBe(2);
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it("stops at the end of the file without a next line", async () => {
    const read = succeeded(
      await run({ view: "read", path: "docs/guide.md", startLine: 1, maxLines: 200 }),
      "read",
    );
    expect(read.excerpt.text).toContain("Standort ist Lübeck.");
    expect(read.nextStartLine).toBeUndefined();
  });

  it.each([
    ["a start after the last line", { path: "docs/guide.md", startLine: 500 }, "out-of-range"],
    ["a file that is not text", { path: "bilder/logo.bin", startLine: 1 }, "not-text"],
    ["a file that does not exist", { path: "docs/fehlt.md", startLine: 1 }, "scope-denied"],
    ["a denied file", { path: ".env", startLine: 1 }, "scope-denied"],
  ] as const)("refuses %s", async (_name, target, reason) => {
    expect(reasonOf(await run({ view: "read", ...target, maxLines: 10 }))).toBe(reason);
  });

  it("never returns a credential, in a read or in a search snippet", async () => {
    const read = await run({
      view: "read",
      path: "docs/notes/token.txt",
      startLine: 1,
      maxLines: 10,
    });
    const found = await run({
      view: "search",
      mode: "keywords",
      query: "token",
      directory: "docs",
      maxResults: 5,
    });
    expect(JSON.stringify(read)).not.toContain(ISSUER_TOKEN);
    expect(JSON.stringify(found)).not.toContain(ISSUER_TOKEN);
  });
});

describe("connected folder tool: selected scope", () => {
  const narrowed = (): SearchScope => ({ ...scope, relativePaths: ["finanzen", "docs/guide.md"] });

  it("lists what the person connected at the root of a narrowed scope", async () => {
    const listed = succeeded(
      await run({ view: "list", directory: "", after: "" }, {}, narrowed()),
      "list",
    );
    expect(listed.entries.map((entry) => `${entry.kind}:${entry.relativePath}`)).toEqual([
      "file:docs/guide.md",
      "directory:finanzen",
    ]);
  });

  it.each([
    ["list", { view: "list", directory: "viele", after: "" }],
    ["list of a parent", { view: "list", directory: "docs", after: "" }],
    [
      "search",
      { view: "search", mode: "keywords", query: "Inhalt", directory: "viele", maxResults: 3 },
    ],
    ["read", { view: "read", path: "docs/notes/wartung.txt", startLine: 1, maxLines: 5 }],
  ] as const)("denies a %s outside the connected entries", async (_name, request) => {
    expect(reasonOf(await run(request, {}, narrowed()))).toBe("scope-denied");
  });

  it("still serves a connected directory and a connected file", async () => {
    expect(
      reasonOf(await run({ view: "list", directory: "finanzen", after: "" }, {}, narrowed())),
    ).toBe("ok");
    expect(
      reasonOf(
        await run(
          { view: "read", path: "docs/guide.md", startLine: 1, maxLines: 3 },
          {},
          narrowed(),
        ),
      ),
    ).toBe("ok");
  });
});

describe("connected folder tool: untrusted requests", () => {
  const inherited = Object.create({ view: "list", directory: "", after: "" }) as object;
  const accessor = Object.defineProperty({ view: "list", directory: "" }, "after", {
    enumerable: true,
    get: () => "",
  });

  it.each([
    ["a string", "list everything"],
    ["null", null],
    ["an array", [{ view: "list", directory: "", after: "" }]],
    ["an unknown view", { view: "delete", path: "docs/guide.md" }],
    [
      "an extra key",
      { view: "read", path: "docs/guide.md", startLine: 1, maxLines: 5, force: true },
    ],
    ["a missing key", { view: "read", path: "docs/guide.md", startLine: 1 }],
    ["inherited fields", inherited],
    ["an accessor field", accessor],
    ["a parent path", { view: "read", path: "../outside.txt", startLine: 1, maxLines: 5 }],
    ["an absolute path", { view: "read", path: "/etc/passwd", startLine: 1, maxLines: 5 }],
    ["a drive path", { view: "read", path: "C:/Windows/win.ini", startLine: 1, maxLines: 5 }],
    ["a backslash path", { view: "read", path: "docs\\guide.md", startLine: 1, maxLines: 5 }],
    ["a parent directory", { view: "list", directory: "docs/../..", after: "" }],
    ["line zero", { view: "read", path: "docs/guide.md", startLine: 0, maxLines: 5 }],
    ["a fractional line", { view: "read", path: "docs/guide.md", startLine: 1.5, maxLines: 5 }],
    ["too many lines", { view: "read", path: "docs/guide.md", startLine: 1, maxLines: 201 }],
    [
      "an overflowing window",
      { view: "read", path: "docs/guide.md", startLine: Number.MAX_SAFE_INTEGER, maxLines: 200 },
    ],
    [
      "an empty query",
      { view: "search", mode: "keywords", query: "   ", directory: "", maxResults: 5 },
    ],
    [
      "a long query",
      { view: "search", mode: "keywords", query: "x".repeat(201), directory: "", maxResults: 5 },
    ],
    [
      "a control character",
      { view: "search", mode: "keywords", query: "a\u0000b", directory: "", maxResults: 5 },
    ],
    ["a regex mode", { view: "search", mode: "regex", query: "a+", directory: "", maxResults: 5 }],
    [
      "too many results",
      { view: "search", mode: "keywords", query: "a", directory: "", maxResults: 13 },
    ],
  ])("refuses %s before any workspace work", async (_name, request) => {
    const causes: unknown[] = [];
    const result = await run(request, { onFailure: (_reason, cause) => causes.push(cause) });
    expect(reasonOf(result)).toBe("invalid-request");
    expect(causes).toEqual([undefined]);
  });
});

describe("connected folder tool: turn budget and control", () => {
  it("never returns more bytes in one turn than the budget allows", async () => {
    const budget = createConnectedFolderToolBudget({ searchElapsedMs: 60_000, resultBytes: 400 });
    const requests = [
      { view: "list", directory: "viele", after: "" },
      { view: "read", path: "docs/guide.md", startLine: 1, maxLines: 200 },
      { view: "search", mode: "keywords", query: "Inhalt", directory: "viele", maxResults: 12 },
      { view: "read", path: "docs/guide.md", startLine: 1, maxLines: 200 },
    ];
    const reasons: string[] = [];
    for (const request of requests) reasons.push(reasonOf(await run(request, { budget })));
    expect(budget.usage().resultBytes).toBeLessThanOrEqual(400);
    expect(reasons.at(-1)).toBe("budget-exhausted");
    expect(reasons[0]).toBe("ok");
  });

  it("continues a listing that the byte budget cut short", async () => {
    const budget = createConnectedFolderToolBudget({ searchElapsedMs: 60_000, resultBytes: 100 });
    const listed = succeeded(
      await run({ view: "list", directory: "viele", after: "" }, { budget }),
      "list",
    );
    expect(listed.entries.length).toBeGreaterThan(0);
    expect(listed.entries.length).toBeLessThan(CONNECTED_FOLDER_TOOL_LIMITS.listEntries);
    expect(listed.nextAfter).toBe(listed.entries.at(-1)?.relativePath);
  });

  it("refuses a search once the turn's search time is used, and still serves a read", async () => {
    let now = 1_000;
    const budget = createConnectedFolderToolBudget({ searchElapsedMs: 50, resultBytes: 100_000 });
    budget.charge(50, 0);
    const options = { budget, nowMs: (): number => (now += 1) };
    expect(
      reasonOf(
        await run(
          { view: "search", mode: "keywords", query: "Kosten", directory: "", maxResults: 3 },
          options,
        ),
      ),
    ).toBe("budget-exhausted");
    expect(
      reasonOf(
        await run({ view: "read", path: "docs/guide.md", startLine: 1, maxLines: 3 }, options),
      ),
    ).toBe("ok");
  });

  it("charges a search with the time it took", async () => {
    const budget = createConnectedFolderToolBudget({
      searchElapsedMs: 60_000,
      resultBytes: 100_000,
    });
    let now = 0;
    await run(
      { view: "search", mode: "keywords", query: "Kosten", directory: "finanzen", maxResults: 3 },
      { budget, nowMs: (): number => (now += 5) },
    );
    expect(budget.usage().calls).toBe(1);
    expect(budget.usage().searchElapsedMs).toBeGreaterThan(0);
  });

  it("rejects instead of answering when the turn was cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      run(
        { view: "read", path: "docs/guide.md", startLine: 1, maxLines: 3 },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
  });

  it("rejects instead of answering when the caller's deadline has passed", async () => {
    await expect(
      run({ view: "list", directory: "", after: "" }, { nowMs: () => 10, deadlineAtMs: 5 }),
    ).rejects.toThrow();
  });

  it("rejects when the caller's deadline passes while the call runs", async () => {
    // The clock is inside the deadline when the call is admitted and past it once the read starts.
    let reads = 0;
    const nowMs = (): number => (reads++ < 2 ? 0 : 100);
    await expect(
      run(
        { view: "read", path: "docs/guide.md", startLine: 1, maxLines: 3 },
        { nowMs, deadlineAtMs: 50 },
      ),
    ).rejects.toThrow();
  });

  it("hands the cause of a failed result to the owner", async () => {
    const seen: [ConnectedFolderToolFailureReason, boolean][] = [];
    await run(
      { view: "read", path: ".env", startLine: 1, maxLines: 3 },
      { onFailure: (reason, cause) => seen.push([reason, cause instanceof Error]) },
    );
    expect(seen).toEqual([["scope-denied", true]]);
  });
});
