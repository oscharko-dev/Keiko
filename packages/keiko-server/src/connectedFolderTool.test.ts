import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CONNECTED_FOLDER_TOOL_FAILURE_REASONS,
  CONNECTED_FOLDER_TOOL_LIMITS,
  isConnectedFolderToolRequest,
} from "@oscharko-dev/keiko-contracts/runtime/connected-folder-tool";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { activityLogOperationSchema } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { openAiCompatiblePromptTools } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import {
  createConnectedFolderToolBudget,
  detectWorkspaceAt,
  type ConnectedFolderToolBudget,
  type SearchScope,
  type WorkspaceFs,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import {
  boundedConnectedFolderResult,
  connectedFolderToolRequest,
  createConnectedFolderProvider,
  CONNECTED_FOLDER_TOOL_TURN_LIMITS,
  type ConnectedFolderToolContext,
  type ConnectedFolderToolWindow,
} from "./connectedFolderTool.js";
import { KNOWLEDGE_TOOL_PAYLOAD_BYTES_MAX } from "./knowledge-tool-execution.js";
import type { ServerDiagnosticRecord } from "./diagnostics-log.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";

const OP = "folder.files.operation";
const CORRELATION = "folder-tool-correlation";
const SECRET_PHRASE = "Kolibri-Wartungsfenster";
const MANY = 130;
const LONG_LINES = 300;

let root = "";
let scope: SearchScope;
let sink: BufferedServerLogSink;

function put(relativePath: string, content: string | Buffer): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-server-folder-tool-"));
  put("docs/guide.md", `# Projekt Eisvogel\n\n${SECRET_PHRASE}: Sonntag 02:00 Uhr\nEnde\n`);
  put("docs/notes/budget.txt", "Der Kostenrahmen liegt bei 120000 Euro.\n");
  put(
    "docs/long.txt",
    Array.from({ length: LONG_LINES }, (_, index) => `Zeile ${String(index + 1)}`).join("\n"),
  );
  put("bilder/logo.bin", Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]));
  put(".env", "GEHEIM=1\n");
  for (let index = 0; index < MANY; index += 1)
    put(`viele/datei-${String(index).padStart(3, "0")}.txt`, `Inhalt ${String(index)}\n`);
  scope = {
    workspace: { ...detectWorkspaceAt(root), contentRedaction: "preserve" },
    scopeId: "server-folder-tool-test",
    relativePaths: [],
  };
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
});
afterEach(() => {
  resetServerLogger();
});

interface Harness {
  readonly windows: ConnectedFolderToolWindow[];
  readonly diagnostics: ServerDiagnosticRecord[];
  readonly budget: ConnectedFolderToolBudget;
  readonly call: (
    args: CatalogJsonObject,
    override?: Partial<ConnectedFolderToolContext>,
  ) => Promise<{ readonly data: CatalogJsonObject; readonly isError: boolean }>;
}

function harness(
  options: {
    readonly budget?: ConnectedFolderToolBudget;
    readonly fs?: WorkspaceFs;
    readonly selected?: SearchScope;
  } = {},
): Harness {
  const windows: ConnectedFolderToolWindow[] = [];
  const diagnostics: ServerDiagnosticRecord[] = [];
  const budget =
    options.budget ?? createConnectedFolderToolBudget(CONNECTED_FOLDER_TOOL_TURN_LIMITS);
  const tool = createConnectedFolderProvider<ConnectedFolderToolContext>({
    diagnostics: { record: (record) => diagnostics.push(record) },
  }).tools()[0];
  if (tool === undefined) throw new Error("Expected the folder tool.");
  const context: ConnectedFolderToolContext = {
    invocationId: "folder-invocation",
    correlationId: CORRELATION,
    signal: new AbortController().signal,
    beforeEffect: () => true,
    connectedFolder: {
      scope: options.selected ?? scope,
      fs: options.fs,
      budget,
      recordWindow: (window) => windows.push(window),
    },
  };
  return {
    windows,
    diagnostics,
    budget,
    call: async (args, override = {}): ReturnType<Harness["call"]> => {
      const result = await tool.execute(args, { ...context, ...override });
      expect(
        describeCatalogSchemaMismatch(tool.descriptor.resultSchema, result.data),
      ).toBeUndefined();
      return { data: result.data, isError: result.isError === true };
    },
  };
}

function items(data: CatalogJsonObject): readonly CatalogJsonObject[] {
  return data.items as readonly CatalogJsonObject[];
}
function paths(data: CatalogJsonObject): readonly unknown[] {
  return items(data).map((item) => item.path);
}
function payloadBytes(data: CatalogJsonObject): number {
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}
function activity(): readonly Record<string, unknown>[] {
  return sink.events
    .filter((event) => event.op === OP)
    .map((event) =>
      expectActivityLogProof("folder.files.operation.line", formatActivityLogProofLine(event)),
    );
}

describe("folder.files: model input becomes the strict contract request", () => {
  it("is advertised as one flat object schema with only the view required", () => {
    const tool = createConnectedFolderProvider({ diagnostics: undefined }).tools()[0];
    if (tool === undefined) throw new Error("Expected the folder tool.");
    expect(tool.name).toBe("folder.files");
    expect(tool.risk).toBe("read");
    // The gateway's own wire projection: what a provider is shown for this tool.
    const [wire] = openAiCompatiblePromptTools([
      {
        name: tool.name,
        description: tool.descriptor.description,
        parameters: tool.descriptor.inputSchema,
      },
    ]);
    const parameters = (wire?.function as { parameters: Record<string, unknown> }).parameters;
    expect(parameters.type).toBe("object");
    for (const keyword of ["oneOf", "anyOf", "allOf", "enum", "const", "not"])
      expect(parameters).not.toHaveProperty(keyword);
    expect(parameters.required).toEqual(["view"]);
    expect(Object.keys(parameters.properties as object).sort()).toEqual([
      "after",
      "directory",
      "maxLines",
      "maxResults",
      "mode",
      "path",
      "query",
      "startLine",
      "view",
    ]);
    expect(tool.descriptor.effects).toEqual(["connector-access"]);
    expect(tool.descriptor.bounds.maxResultBytes).toBeGreaterThan(KNOWLEDGE_TOOL_PAYLOAD_BYTES_MAX);
  });

  it.each([
    [{ view: "list" }, { view: "list", directory: "", after: "" }],
    [
      { view: "list", directory: "./docs/", after: "docs/guide.md", query: "ignored", path: "x" },
      { view: "list", directory: "docs", after: "docs/guide.md" },
    ],
    [
      { view: "list", directory: "." },
      { view: "list", directory: "", after: "" },
    ],
    [
      { view: "list", directory: "/" },
      { view: "list", directory: "", after: "" },
    ],
    [
      { view: "search", query: "Kosten" },
      { view: "search", mode: "keywords", query: "Kosten", directory: "", maxResults: 8 },
    ],
    [
      { view: "search", query: "a b", mode: "literal", directory: "docs/notes/", maxResults: 3 },
      { view: "search", mode: "literal", query: "a b", directory: "docs/notes", maxResults: 3 },
    ],
    [
      { view: "search", query: "Kosten", mode: null },
      { view: "search", mode: "keywords", query: "Kosten", directory: "", maxResults: 8 },
    ],
    [
      { view: "read", path: "./docs/guide.md" },
      { view: "read", path: "docs/guide.md", startLine: 1, maxLines: 120 },
    ],
    [
      { view: "read", path: "docs/guide.md", startLine: 40, maxLines: 5, directory: "ignored" },
      { view: "read", path: "docs/guide.md", startLine: 40, maxLines: 5 },
    ],
  ] satisfies [CatalogJsonObject, CatalogJsonObject][])(
    "fills the defaults of %j",
    (args, expected) => {
      const request = connectedFolderToolRequest(args);
      expect(request).toEqual(expected);
      expect(isConnectedFolderToolRequest(request)).toBe(true);
    },
  );

  it.each([
    [{}],
    [{ view: "inventory" }],
    [{ view: "LIST" }],
    [{ view: ["list"] }],
    [{ view: "search" }],
    [{ view: "search", query: 7 }],
    [{ view: "search", query: "a", mode: "regex" }],
    [{ view: "search", query: "a", maxResults: CONNECTED_FOLDER_TOOL_LIMITS.searchHits + 1 }],
    [{ view: "read" }],
    [{ view: "read", path: "../outside.txt" }],
    [{ view: "read", path: "/etc/passwd" }],
    [{ view: "read", path: "docs/guide.md", startLine: 0 }],
    [{ view: "read", path: "docs/guide.md", maxLines: CONNECTED_FOLDER_TOOL_LIMITS.readLines + 1 }],
    [{ view: "list", directory: 5 }],
    [{ view: "list", directory: "docs/../.." }],
  ] satisfies [CatalogJsonObject][])(
    "never turns hostile or incomplete input %j into a valid request",
    async (args) => {
      expect(isConnectedFolderToolRequest(connectedFolderToolRequest(args))).toBe(false);
      const f = harness();
      const result = await f.call(args);
      expect(result).toEqual({
        isError: true,
        data: {
          outcome: "failed",
          reason: "invalid-request",
          nextStep: expect.stringContaining("relative to the connected folder") as string,
        },
      });
      expect(f.windows).toEqual([]);
      expect(f.budget.usage().resultBytes).toBe(0);
    },
  );
});

describe("folder.files: bounded results", () => {
  it("lists the root with defaults and marks the content untrusted", async () => {
    const f = harness();
    const { data, isError } = await f.call({ view: "list" });
    expect(isError).toBe(false);
    expect(data).toMatchObject({
      outcome: "succeeded",
      view: "list",
      contentTrust: "untrusted-document-text",
      directory: "",
      coverage: { coverageIncomplete: false },
    });
    expect(items(data)).toEqual([
      { path: "bilder", kind: "directory", sizeBytes: 0 },
      { path: "docs", kind: "directory", sizeBytes: 0 },
      { path: "viele", kind: "directory", sizeBytes: 0 },
    ]);
    expect(data.nextAfter).toBeUndefined();
    expect(f.windows).toEqual([]);
  });

  it("pages a large directory through nextAfter without gaps or repeats", async () => {
    const f = harness();
    const seen: unknown[] = [];
    let after: unknown = undefined;
    for (let page = 0; page < 5; page += 1) {
      const { data } = await f.call({
        view: "list",
        directory: "viele",
        ...(typeof after === "string" ? { after } : {}),
      });
      seen.push(...paths(data));
      after = data.nextAfter;
      if (after === undefined) break;
      expect(data.nextStep).toContain("nextAfter");
      expect(after).toBe(paths(data).at(-1));
    }
    expect(after).toBeUndefined();
    expect(seen).toHaveLength(MANY);
    expect(new Set(seen).size).toBe(MANY);
  });

  it("searches with the defaults and exposes each returned window", async () => {
    const f = harness();
    const { data } = await f.call({ view: "search", query: SECRET_PHRASE });
    expect(data).toMatchObject({ outcome: "succeeded", view: "search" });
    expect(data.contentTrust).toBe("untrusted-document-text");
    const hit = items(data)[0];
    expect(hit).toMatchObject({ path: "docs/guide.md" });
    expect(hit?.text).toContain(SECRET_PHRASE);
    // Each window carries the evidence of exactly the lines the model received.
    expect(
      f.windows.map((window) => ({
        path: window.path,
        startLine: window.startLine,
        endLine: window.endLine,
        text: window.excerpt.content,
        atomPath: window.excerpt.atom.scopePath,
        atomLines: window.excerpt.atom.lineRange,
      })),
    ).toEqual(
      items(data).map((item) => ({
        path: item.path,
        startLine: item.startLine,
        endLine: item.endLine,
        text: item.text,
        atomPath: item.path,
        atomLines: { startLine: item.startLine, endLine: item.endLine },
      })),
    );
    expect(f.windows.length).toBeGreaterThan(0);
  });

  it("reads a line window and continues at nextStartLine", async () => {
    const f = harness();
    const first = (await f.call({ view: "read", path: "docs/long.txt" })).data;
    expect(items(first)[0]).toMatchObject({ path: "docs/long.txt", startLine: 1, endLine: 120 });
    expect(first.nextStartLine).toBe(121);
    expect(first.nextStep).toContain("nextStartLine");
    const rest = (
      await f.call({ view: "read", path: "docs/long.txt", startLine: 121, maxLines: 200 })
    ).data;
    expect(items(rest)[0]).toMatchObject({ startLine: 121, endLine: LONG_LINES });
    expect(rest.nextStartLine).toBeUndefined();
    expect(f.windows).toMatchObject([
      { path: "docs/long.txt", startLine: 1, endLine: 120 },
      { path: "docs/long.txt", startLine: 121, endLine: LONG_LINES },
    ]);
    expect(f.windows.map((window) => window.excerpt.content)).toEqual([
      items(first)[0]?.text,
      items(rest)[0]?.text,
    ]);
    const last = f.windows[1]?.excerpt;
    expect(last?.contentBytes).toBe(Buffer.byteLength(last?.content ?? "", "utf8"));
    expect(last?.contentBytes).toBeGreaterThan(0);
  });

  it.each([
    ["scope-denied", { view: "read", path: ".env" }],
    ["not-text", { view: "read", path: "bilder/logo.bin" }],
    ["out-of-range", { view: "read", path: "docs/guide.md", startLine: 9000 }],
  ] satisfies [string, CatalogJsonObject][])(
    "returns only the closed reason %s, never a message or a path",
    async (reason, args) => {
      const f = harness();
      const { data, isError } = await f.call(args);
      expect(isError).toBe(true);
      expect(Object.keys(data).sort()).toEqual(["nextStep", "outcome", "reason"]);
      expect(data.reason).toBe(reason);
      expect(JSON.stringify(data)).not.toContain(args.path);
      expect(JSON.stringify(data)).not.toContain(root);
      expect(f.windows).toEqual([]);
      // A request the model can correct is not a failure of the tool.
      expect(f.diagnostics).toEqual([]);
    },
  );

  it("drops trailing list entries that exceed the byte bound and continues after the last kept", () => {
    const entries = Array.from(
      { length: CONNECTED_FOLDER_TOOL_LIMITS.listEntries },
      (_, index) => ({
        relativePath: `lang/${String(index).padStart(3, "0")}-${"n".repeat(500)}`,
        kind: "file" as const,
        sizeBytes: 1,
      }),
    );
    const projection = boundedConnectedFolderResult({
      ok: true,
      view: "list",
      directory: "lang",
      entries,
      coverageIncomplete: false,
      durationMs: 1,
      resultBytes: 50_000,
    });
    const kept = items(projection.data);
    expect(payloadBytes(projection.data)).toBeLessThanOrEqual(KNOWLEDGE_TOOL_PAYLOAD_BYTES_MAX);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(entries.length);
    expect(projection.data.nextAfter).toBe(entries[kept.length - 1]?.relativePath);
    expect(projection.activity).toMatchObject({ returnedCount: kept.length, truncated: true });
    // One more entry would not have fitted: the bound is used, not merely respected.
    const oneMore = payloadBytes(projection.data) + Buffer.byteLength(JSON.stringify(kept[0]));
    expect(oneMore).toBeGreaterThan(KNOWLEDGE_TOOL_PAYLOAD_BYTES_MAX);
  });

  it("never tells the model a listing is complete when an entry could not be listed", () => {
    const listing = (coverageIncomplete: boolean): CatalogJsonObject =>
      boundedConnectedFolderResult({
        ok: true,
        view: "list",
        directory: "",
        entries: [{ relativePath: "docs", kind: "directory", sizeBytes: 0 }],
        coverageIncomplete,
        durationMs: 1,
        resultBytes: 4,
      }).data;
    const incomplete = listing(true);
    expect(incomplete.nextAfter).toBeUndefined();
    expect(incomplete.coverage).toEqual({ coverageIncomplete: true });
    expect(incomplete.nextStep).toContain("incomplete");
    expect(incomplete.nextStep).not.toContain("These are all entries");
    expect(listing(false).nextStep).toContain("These are all entries");
  });

  it("drops trailing search hits that exceed the byte bound and says more exists", () => {
    const hits = Array.from({ length: CONNECTED_FOLDER_TOOL_LIMITS.searchHits }, (_, index) => ({
      path: `docs/${String(index)}.txt`,
      startLine: 1,
      endLine: 3,
      // A control character costs six bytes in JSON.
      text: "\u0001".repeat(CONNECTED_FOLDER_TOOL_LIMITS.snippetBytes),
      truncated: false,
    }));
    const projection = boundedConnectedFolderResult({
      ok: true,
      view: "search",
      hits,
      filesScanned: 12,
      truncated: false,
      unavailableHits: 0,
      durationMs: 1,
      resultBytes: 8_000,
    });
    const kept = items(projection.data);
    expect(payloadBytes(projection.data)).toBeLessThanOrEqual(KNOWLEDGE_TOOL_PAYLOAD_BYTES_MAX);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(hits.length);
    expect(projection.data.coverage).toMatchObject({ truncated: true });
    expect(projection.excerpts).toEqual(hits.slice(0, kept.length));
  });

  it("refuses a single excerpt that cannot fit instead of exceeding the bound", () => {
    const projection = boundedConnectedFolderResult({
      ok: true,
      view: "read",
      excerpt: {
        path: "docs/control.txt",
        startLine: 1,
        endLine: 1,
        text: "\u0001".repeat(CONNECTED_FOLDER_TOOL_LIMITS.readBytes),
        truncated: false,
      },
      durationMs: 1,
      resultBytes: 8_000,
    });
    expect(projection.data).toMatchObject({ outcome: "failed", reason: "result-bound" });
    expect(projection.excerpts).toEqual([]);
    expect(payloadBytes(projection.data)).toBeLessThanOrEqual(KNOWLEDGE_TOOL_PAYLOAD_BYTES_MAX);
  });
});

describe("folder.files: authority, budget and faults", () => {
  it("returns nothing when the Chat authority is no longer current before the read", async () => {
    const f = harness();
    const { data } = await f.call(
      { view: "read", path: "docs/guide.md" },
      { beforeEffect: () => false },
    );
    expect(data).toMatchObject({ outcome: "failed", reason: "authority-denied" });
    expect(JSON.stringify(data)).not.toContain(SECRET_PHRASE);
    expect(f.budget.usage().calls).toBe(0);
  });

  it("withholds content when the authority ends while the workspace is read", async () => {
    const f = harness();
    let checks = 0;
    const { data } = await f.call(
      { view: "read", path: "docs/guide.md" },
      { beforeEffect: () => (checks += 1) === 1 },
    );
    expect(checks).toBe(2);
    expect(data).toMatchObject({ outcome: "failed", reason: "authority-denied" });
    expect(JSON.stringify(data)).not.toContain(SECRET_PHRASE);
    expect(f.windows).toEqual([]);
  });

  it("refuses a call that carries no admitted folder of its turn", async () => {
    const f = harness();
    const { data } = await f.call({ view: "list" }, { connectedFolder: undefined });
    expect(data).toMatchObject({ outcome: "failed", reason: "scope-denied" });
  });

  it("refuses a cancelled call before any workspace work", async () => {
    const f = harness();
    const controller = new AbortController();
    controller.abort();
    const { data } = await f.call({ view: "list" }, { signal: controller.signal });
    expect(data).toMatchObject({ outcome: "failed", reason: "authority-denied" });
    expect(f.budget.usage().calls).toBe(0);
  });

  it("rejects when the turn's deadline has passed, so the turn ends instead of answering", async () => {
    const f = harness();
    await expect(
      f.call({ view: "list" }, { deadlineAt: new Date(Date.now() - 60_000).toISOString() }),
    ).rejects.toThrow();
  });

  it("stops serving once the turn's result budget is used", async () => {
    const f = harness({
      budget: createConnectedFolderToolBudget({ searchElapsedMs: 60_000, resultBytes: 300 }),
    });
    const reasons: unknown[] = [];
    for (let call = 0; call < 6; call += 1)
      reasons.push(
        (await f.call({ view: "read", path: "docs/long.txt", maxLines: 20 })).data.reason,
      );
    expect(reasons[0]).toBeUndefined();
    expect(reasons.at(-1)).toBe("budget-exhausted");
    expect(f.budget.usage().resultBytes).toBeLessThanOrEqual(300);
  });

  it("reports a fault of the tool as a diagnostic under the request correlation", async () => {
    const faulty = new Proxy(nodeWorkspaceFs, {
      get: (target, key): unknown => {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (): never => {
          throw new Error(`disk fault at ${root}`);
        };
      },
    });
    const f = harness({ fs: faulty });
    const { data } = await f.call({ view: "read", path: "docs/guide.md" });
    expect(["failed", "unreadable"]).toContain(data.reason);
    expect(Object.keys(data).sort()).toEqual(["nextStep", "outcome", "reason"]);
    expect(f.diagnostics).toHaveLength(1);
    expect(f.diagnostics[0]).toMatchObject({
      correlationId: CORRELATION,
      operation: "folder.files",
    });
    expect(JSON.stringify([data, f.diagnostics, sink.events])).not.toContain("disk fault");
    expect(activity().at(-1)).toMatchObject({ outcome: "failed", reason: data.reason });
  });
});

describe("folder.files: activity log", () => {
  it("records one terminal line for a call the turn's stop or deadline ends", async () => {
    const controller = new AbortController();
    const stopping = new Proxy(nodeWorkspaceFs, {
      get: (target, key): unknown => {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]): unknown => {
          // The person stops the turn while the workspace is being read.
          controller.abort();
          return Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
        };
      },
    });
    const f = harness({ fs: stopping });
    await expect(
      f.call({ view: "read", path: "docs/guide.md" }, { signal: controller.signal }),
    ).rejects.toThrow();
    await expect(
      harness().call({ view: "list" }, { deadlineAt: new Date(Date.now() - 60_000).toISOString() }),
    ).rejects.toThrow();
    expect(activity()).toMatchObject([
      { view: "read", outcome: "cancelled", returnedCount: 0, payloadBytes: 0, truncated: false },
      { view: "list", outcome: "timed-out", returnedCount: 0, payloadBytes: 0, truncated: false },
    ]);
    const events = sink.events.filter((event) => event.op === OP);
    expect(events.every((event) => event.correlationId === CORRELATION)).toBe(true);
    expect(events.map(formatActivityLogProofLine).join("\n")).not.toContain(SECRET_PHRASE);
  });

  it("registers exactly the closed reasons the tool can return", () => {
    const registration = activityLogOperationSchema(OP);
    expect(registration?.fields.reason?.values).toEqual([
      ...CONNECTED_FOLDER_TOOL_FAILURE_REASONS,
      "authority-denied",
      "result-bound",
    ]);
    expect(registration?.fields.view?.values).toEqual(["list", "search", "read", "unknown"]);
  });

  it("records one body-free line per call with counts and the turn's cumulative usage", async () => {
    const f = harness();
    await f.call({ view: "list", directory: "docs" });
    await f.call({ view: "search", query: SECRET_PHRASE });
    await f.call({ view: "read", path: "docs/guide.md", maxLines: 2 });
    await f.call({ view: "read", path: ".env" });
    await f.call({ view: "inventory" });
    const lines = activity();
    expect(lines).toMatchObject([
      { view: "list", outcome: "succeeded", returnedCount: 3, truncated: false, turnCallCount: 1 },
      { view: "search", outcome: "succeeded", truncated: false, turnCallCount: 2 },
      { view: "read", outcome: "succeeded", returnedCount: 1, truncated: true, turnCallCount: 3 },
      {
        view: "read",
        outcome: "failed",
        reason: "scope-denied",
        returnedCount: 0,
        turnCallCount: 4,
      },
      { view: "unknown", outcome: "failed", reason: "invalid-request", turnCallCount: 4 },
    ]);
    expect(lines[1]?.filesScanned).toBeGreaterThan(0);
    expect(lines[1]?.returnedCount).toBeGreaterThan(0);
    const usage = f.budget.usage();
    expect(lines.at(-1)).toMatchObject({
      turnResultBytes: usage.resultBytes,
      turnSearchElapsedMs: Math.round(usage.searchElapsedMs),
    });
    for (const line of lines) {
      expect(line.payloadBytes).toBeGreaterThan(0);
      expect(line.reason === undefined).toBe(line.outcome === "succeeded");
    }
    const events = sink.events.filter((event) => event.op === OP);
    expect(events.every((event) => event.correlationId === CORRELATION)).toBe(true);
    const persisted = events.map(formatActivityLogProofLine).join("\n");
    for (const body of [SECRET_PHRASE, "guide.md", "docs", ".env", "inventory", root])
      expect(persisted).not.toContain(body);
    expect(analyzeLogText(persisted).timelines).toHaveLength(1);
  });
});
