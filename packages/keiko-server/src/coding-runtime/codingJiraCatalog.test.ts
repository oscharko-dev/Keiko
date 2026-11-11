import { afterEach, expect, it, onTestFinished, vi, type Mock } from "vitest";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpProvider,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  createToolDescriptor,
  createToolRef,
  ToolCatalogError,
} from "@oscharko-dev/keiko-tool-catalog";
import * as mcp from "@oscharko-dev/keiko-mcp";
import * as diagnostics from "../diagnostics-log.js";
import { createCodingJiraCatalog } from "./codingJiraCatalog.js";
import type { CodingJiraTool } from "./codingJiraPodBinding.js";
import { processServerLogSink } from "../process-log-sink.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.restoreAllMocks();
});
const context: ManagedMcpInvocationContext = {
  invocationId: "catalog-selection",
  correlationId: "same-run",
  signal: new AbortController().signal,
  beforeEffect: () => true,
};
const PROJECTS = "GET /rest/api/2/project";
const ISSUE = "GET /rest/api/2/issue/{issueIdOrKey}";
function fixture(): {
  catalog: ReturnType<typeof createCodingJiraCatalog<ManagedMcpInvocationContext>>;
  provider: Mock<
    (names: readonly CodingJiraTool[]) => ManagedMcpProvider<ManagedMcpInvocationContext>
  >;
  admitted: Mock<() => boolean>;
  fits: Mock<() => boolean | undefined>;
  execute: Mock<() => Promise<{ data: { outcome: string } }>>;
  select: (identities: readonly string[]) => Promise<CatalogJsonObject>;
} {
  const execute = vi.fn(() => Promise.resolve({ data: { outcome: "succeeded" } }));
  const admitted = vi.fn(() => true);
  const fits = vi.fn<() => boolean | undefined>(() => true);
  const provider = vi.fn(
    (names: readonly CodingJiraTool[]): ManagedMcpProvider<ManagedMcpInvocationContext> => ({
      id: "selected-synthetic-jira",
      tools: () =>
        names.map((name) => ({
          name,
          risk: "read",
          execute,
          descriptor: createToolDescriptor({
            toolRef: createToolRef(`keiko.${name}`, 1),
            description: "Synthetic selected read.",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
              additionalProperties: false,
            },
            resultSchema: {
              type: "object",
              properties: { outcome: { type: "string", enum: ["succeeded"] } },
              required: ["outcome"],
              additionalProperties: false,
            },
            effects: ["connector-access"],
            actionMapping: [{ action: name, effects: ["connector-access"] }],
            policyReferences: ["adr-0128.d4"],
            handlerRequirement: { id: name, contractVersion: 1 },
            bounds: {
              maxArgumentBytes: 1024,
              maxResultBytes: 1024,
              maxResultCount: 1,
              maxDurationMs: 15000,
            },
            idempotency: "server-key-required",
            cancellation: "before-effect",
          }),
        })),
    }),
  );
  const catalog = createCodingJiraCatalog({
    tools: ["jira.projects", "jira.issue"],
    provider,
    admitted,
    fits,
    correlationId: context.correlationId,
    log: { write: () => undefined },
  });
  cleanups.push(catalog.close);
  return {
    catalog,
    provider,
    admitted,
    fits,
    execute,
    select: (identities: readonly string[]): Promise<CatalogJsonObject> =>
      catalog.call("jira.describe", { identities }, context),
  };
}

it("publishes no tools until the real discovery host has completed admission", async () => {
  const f = fixture();
  expect(f.catalog.tools).toEqual([]);
  await f.catalog.ready;
  expect(f.catalog.tools.map((tool) => tool.name)).toEqual(["jira.discover", "jira.describe"]);
  expect(f.fits).not.toHaveBeenCalled();
});

it("cannot republish tools when the Pod closes while initial admission is pending", async () => {
  const f = fixture();
  const refused = expect(f.catalog.ready).rejects.toBeInstanceOf(mcp.ManagedMcpError);
  await f.catalog.close();
  await refused;
  expect(f.catalog.tools).toEqual([]);
});

it("keeps the Pod discoverable when the first provider context sample is unavailable", async () => {
  const f = fixture();
  f.fits.mockReturnValue(undefined);
  await f.catalog.ready;
  expect(await f.catalog.call("jira.discover", { maxResults: 1 }, context)).toMatchObject({
    outcome: "succeeded",
  });
  await expect(f.select([PROJECTS])).rejects.toMatchObject({
    structuredResult: { reason: "selection-unavailable" },
  });
  expect(f.catalog.tools.map((tool) => tool.name)).toEqual(["jira.discover", "jira.describe"]);
  expect(await f.select([])).toMatchObject({ outcome: "succeeded" });
  f.fits.mockReturnValue(true);
  await f.select([PROJECTS]);
  expect(f.catalog.tools.map((tool) => tool.name)).toContain("jira.projects");
  expect(f.execute).not.toHaveBeenCalled();
});

it("checks the live prompt allowance after admission and preserves the old subset on exhaustion", async () => {
  const f = fixture();
  await f.catalog.ready;
  await f.select([PROJECTS]);
  const before = f.catalog.tools;
  // The initial identity admission still sees room; only the post-admission recheck consumes it.
  f.admitted.mockReturnValueOnce(true).mockImplementationOnce(() => {
    f.fits.mockReturnValue(false);
    return true;
  });
  await expect(f.select([ISSUE])).rejects.toMatchObject({
    structuredResult: { reason: "budget-exhausted" },
  });
  expect(f.catalog.tools).toBe(before);
  expect(f.fits).toHaveBeenLastCalledWith(
    expect.arrayContaining([expect.objectContaining({ name: "jira.issue" })]),
    expect.objectContaining({ selectedFor: "next-round" }),
  );
  await f.catalog.call("jira.projects", {}, context);
});

it("compiles only selected tools, replaces the subset, and clears it without an empty host", async () => {
  const f = fixture();
  await f.catalog.ready;
  expect(f.provider).not.toHaveBeenCalled();
  expect(f.catalog.tools.map((tool) => tool.name)).toEqual(["jira.discover", "jira.describe"]);
  await expect(f.catalog.call("jira.projects", {}, context)).rejects.toMatchObject({
    reason: "not-admitted",
  });
  await f.select([PROJECTS]);
  expect(f.provider).toHaveBeenLastCalledWith(["jira.projects"]);
  await f.catalog.call("jira.projects", {}, context);
  await f.select([ISSUE]);
  expect(f.catalog.tools.map((tool) => tool.name)).toEqual([
    "jira.discover",
    "jira.describe",
    "jira.issue",
  ]);
  await expect(f.catalog.call("jira.projects", {}, context)).rejects.toMatchObject({
    reason: "not-admitted",
  });
  await f.select([]);
  expect(f.catalog.tools).toHaveLength(2);
  expect(f.execute).toHaveBeenCalledOnce();
});

it("reports the operations a replacing selection drops to the model (LIM22)", async () => {
  const log = vi.spyOn(processServerLogSink(), "write").mockImplementation(() => undefined);
  onTestFinished(() => {
    log.mockRestore();
  });
  const f = fixture();
  await f.catalog.ready;
  expect(await f.select([PROJECTS])).not.toHaveProperty("deselected");
  expect(await f.select([ISSUE])).toMatchObject({
    deselected: [{ identity: PROJECTS, tool: "jira.projects" }],
  });
  expect(await f.select([ISSUE])).not.toHaveProperty("deselected");
  expect(await f.select([])).toMatchObject({
    deselected: [{ identity: ISSUE, tool: "jira.issue" }],
  });
  expect(
    log.mock.calls
      .map(([event]) => event)
      .filter((event) => event.op === "jira.catalog.selection")
      .map((event) => event.extra),
  ).toEqual([
    expect.objectContaining({ surface: "coding", selectedCount: 1, deselectedCount: 0 }),
    expect.objectContaining({ surface: "coding", selectedCount: 1, deselectedCount: 1 }),
    expect.objectContaining({ surface: "coding", selectedCount: 1, retainedCount: 1 }),
    expect.objectContaining({ surface: "coding", selectedCount: 0, deselectedCount: 1 }),
  ]);
});

it("retains the admitted subset after a selected schema fails and surfaces the closed refusal", async () => {
  const f = fixture();
  await f.catalog.ready;
  await f.select([PROJECTS]);
  const before = f.catalog.tools;
  f.provider.mockImplementationOnce(() => {
    throw new ToolCatalogError("invalid-schema");
  });
  await expect(f.select([ISSUE])).rejects.toMatchObject({
    structuredResult: { reason: "selection-unavailable" },
  });
  expect(f.catalog.tools).toBe(before);
  await f.catalog.call("jira.projects", {}, context);
});

it("keeps a committed selection successful when the retired SDK host fails during cleanup", async () => {
  const create = vi.spyOn(mcp, "createManagedMcpHost");
  const diagnostic = vi
    .spyOn(diagnostics, "emitServerDiagnostic")
    .mockImplementation(() => undefined);
  const f = fixture();
  await f.catalog.ready;
  await f.select([PROJECTS]);
  const previous = create.mock.results.at(-1);
  if (previous?.type !== "return") throw new TypeError("Missing selected host");
  const close = previous.value.close.bind(previous.value);
  vi.spyOn(previous.value, "close").mockImplementation(async () => {
    await close();
    throw new TypeError("Private SDK cleanup body must not escape");
  });
  expect(await f.select([ISSUE])).toMatchObject({ outcome: "succeeded" });
  expect(f.catalog.tools.map((tool) => tool.name)).toEqual([
    "jira.discover",
    "jira.describe",
    "jira.issue",
  ]);
  await expect(f.catalog.call("jira.projects", {}, context)).rejects.toMatchObject({
    reason: "not-admitted",
  });
  await f.catalog.call("jira.issue", {}, context);
  expect(diagnostic).toHaveBeenCalledOnce();
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("Private SDK cleanup body");
});

it("refuses foreign identities and rechecks the actual scope after host admission", async () => {
  const f = fixture();
  await f.catalog.ready;
  await expect(f.select(["POST /rest/api/2/monitoring/app"])).rejects.toBeDefined();
  expect(f.provider).not.toHaveBeenCalled();
  f.admitted.mockReturnValueOnce(true).mockReturnValue(false);
  await expect(f.select([PROJECTS])).rejects.toMatchObject({
    structuredResult: { reason: "selection-unavailable" },
  });
  expect(f.catalog.tools).toHaveLength(2);
  expect(f.execute).not.toHaveBeenCalled();
});

it("refuses oversized selected metadata at the existing catalog byte ceiling without truncation", async () => {
  const f = fixture();
  await f.catalog.ready;
  const original = f.provider.getMockImplementation();
  if (original === undefined) throw new TypeError("Missing provider fixture");
  f.provider.mockImplementation((names) => {
    const provider = original(names);
    return {
      ...provider,
      tools: (): ReturnType<typeof provider.tools> =>
        provider.tools().map((tool) => {
          const { descriptorDigest: _digest, ...descriptor } = tool.descriptor;
          return {
            ...tool,
            descriptor: createToolDescriptor({
              ...descriptor,
              inputSchema: {
                type: "object",
                required: [],
                additionalProperties: false,
                properties: Object.fromEntries(
                  Array.from({ length: TOOL_CATALOG_LIMITS.maxObjectKeys - 1 }, (_, index) => [
                    `field${String(index)}`,
                    { type: "string", maxLength: 32, description: "x".repeat(1200) },
                  ]),
                ),
              },
            }),
          };
        }),
    };
  });
  await expect(f.select([PROJECTS, ISSUE])).rejects.toMatchObject({
    structuredResult: { reason: "budget-exhausted" },
  });
  expect(f.catalog.tools).toHaveLength(2);
  expect(f.execute).not.toHaveBeenCalled();
});

it("keeps an in-flight native operation on its admitted host and refuses catalog replacement", async () => {
  const f = fixture();
  await f.catalog.ready;
  await f.select([PROJECTS]);
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.execute.mockImplementationOnce(async () => {
    started?.();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { data: { outcome: "succeeded" } };
  });
  const running = f.catalog.call("jira.projects", {}, context);
  await waiting;
  await expect(f.select([ISSUE])).rejects.toMatchObject({
    structuredResult: { reason: "selection-unavailable" },
  });
  release?.();
  await running;
  expect(f.catalog.tools.map((tool) => tool.name)).toContain("jira.projects");
  expect(f.execute).toHaveBeenCalledOnce();
});
