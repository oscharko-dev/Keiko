import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CatalogLifecycleLogPort } from "../tool-catalog/catalogToolLifecycle.js";
import { buildUiHandlerDeps } from "../deps.js";
import {
  expectRegisteredActivityLogLine,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import * as managedProvider from "../tool-catalog/managedProviderCatalog.js";
import {
  JIRA_DEFAULT_CATALOG_TOOLS,
  createJiraChatCatalogRuntime,
  untracedAdvisory,
} from "./jiraChatCatalogRuntime.js";
import {
  JIRA_MANAGED_READ_TOOLS,
  JIRA_MUTATION_OPERATIONS,
  JIRA_READ_TOOL_FAMILIES,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { isCoreMutationTool } from "./jiraManagedMutationDescriptors.js";
import { jiraOperationForTool } from "./jiraManagedProvider.js";
import { JIRA_CATALOG_DISCOVERY_TOOLS } from "./jiraCatalogDiscovery.js";
import { jiraOperationDefinitions } from "./jiraOperationRegistry.js";
import { KNOWLEDGE_CHAT_TOOLS } from "../requirementsToolName.js";

const CURATED_JIRA_ALIASES = [
  "jira_projects",
  "jira_issue_types",
  "jira_create_fields",
  "jira_edit_fields",
  "jira_search",
  "jira_issue",
  "jira_comments",
  "jira_transitions",
  "jira_assignable_users",
  "jira_report",
  "jira_draft_stage",
  "jira_create",
  "jira_edit",
  "jira_assign",
  "jira_comment",
  "jira_transition",
  "jira_attach",
  "jira_draft",
] as const;

const cleanups: (() => Promise<void>)[] = [];
function releaseGate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fixture(): {
  runtime: ReturnType<typeof createJiraChatCatalogRuntime>;
  lines: readonly string[];
  write: Mock<CatalogLifecycleLogPort["primary"]["write"]>;
  record: Mock<CatalogLifecycleLogPort["diagnostics"]["record"]>;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-jira-catalog-recovery-"));
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(root, "evidence"),
    uiDbPath: join(root, "ui.db"),
    env: { KEIKO_STATE_DIR: root },
  });
  cleanups.push(async () => {
    await deps.dispose?.();
    rmSync(root, { recursive: true, force: true });
  });
  const lines: string[] = [];
  const write = vi.fn<CatalogLifecycleLogPort["primary"]["write"]>((event) => {
    lines.push(formatActivityLogProofLine(event));
  });
  const record = vi.fn<CatalogLifecycleLogPort["diagnostics"]["record"]>();
  return {
    runtime: createJiraChatCatalogRuntime(deps, { primary: { write }, diagnostics: { record } }),
    lines,
    write,
    record,
  };
}

/** Rebuilds the default catalog from the owning contracts; never from the runtime's own set. */
function expectedDefaultCatalogTools(): Set<string> {
  const families = new Set<string>([
    ...JIRA_READ_TOOL_FAMILIES.projectList,
    ...JIRA_READ_TOOL_FAMILIES.issueMetadata,
    ...JIRA_READ_TOOL_FAMILIES.issues,
    ...JIRA_READ_TOOL_FAMILIES.issueWorkflow,
    ...JIRA_READ_TOOL_FAMILIES.localCompositions,
  ]);
  const reads = JIRA_MANAGED_READ_TOOLS.filter(
    (tool) => families.has(tool) && tool !== "jira.draft-batch",
  );
  const writes = JIRA_MUTATION_OPERATIONS.filter((tool) => {
    if (!isCoreMutationTool(tool)) return false;
    const definition = jiraOperationForTool(tool)?.definition;
    return (
      definition?.kind === "composite" ||
      (definition?.kind === "native" && /\/issue(?:\/|$)/u.test(definition.pathTemplate))
    );
  });
  return new Set<string>([
    ...reads,
    ...writes,
    "jira.draft-batch",
    "jira.draft",
    ...JIRA_CATALOG_DISCOVERY_TOOLS,
    ...KNOWLEDGE_CHAT_TOOLS,
  ]);
}

describe("default Jira catalog set", () => {
  it("equals the set derived from the owning contract constants", () => {
    const expected = expectedDefaultCatalogTools();
    expect(new Set<string>(JIRA_DEFAULT_CATALOG_TOOLS)).toEqual(expected);
    expect(JIRA_DEFAULT_CATALOG_TOOLS).toHaveLength(expected.size);
    // Guards against a vacuous derivation: every owning group contributes.
    for (const tool of [...JIRA_CATALOG_DISCOVERY_TOOLS, ...KNOWLEDGE_CHAT_TOOLS])
      expect(expected.has(tool)).toBe(true);
    expect(expected.size).toBeGreaterThan(KNOWLEDGE_CHAT_TOOLS.length + 2);
  });

  it("detects a tool missing from the runtime set", () => {
    const expected = expectedDefaultCatalogTools();
    const dropped = JIRA_DEFAULT_CATALOG_TOOLS.slice(1);
    expect(new Set<string>(dropped)).not.toEqual(expected);
  });
});

describe("application-owned Jira catalog initialization", () => {
  it("advertises all 18 curated Jira tools with discovery, Knowledge and batch before selection", async () => {
    const f = fixture();
    expect(
      f.runtime
        .toolDefinitions()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(
      [
        ...CURATED_JIRA_ALIASES,
        "jira_draft_batch",
        "jira_discover",
        "jira_describe",
        ...KNOWLEDGE_CHAT_TOOLS.map((tool) => tool.replace(/[.-]/gu, "_")),
      ].sort(),
    );
    const initial = await f.runtime.get();
    expect(initial.projection.tools.map((tool) => tool.alias).sort()).toEqual(
      f.runtime
        .toolDefinitions()
        .map((tool) => tool.name)
        .sort(),
    );
    await f.runtime.close();
  });

  it("recovers a fresh shared SDK catalog after a transient admission-log failure", async () => {
    const f = fixture();
    f.write.mockImplementationOnce(() => {
      throw new Error("synthetic-private-sink-failure");
    });
    await expect(f.runtime.get()).rejects.toMatchObject({ reason: "log-unavailable" });
    const [first, second] = await Promise.all([f.runtime.get(), f.runtime.get()]);
    expect(second).toBe(first);
    expect(first.catalog.descriptors).toHaveLength(21 + KNOWLEDGE_CHAT_TOOLS.length);
    expect(f.record).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.record.mock.calls)).not.toContain("synthetic-private-sink-failure");
    const records = f.lines.map((line) =>
      expectRegisteredActivityLogLine("mcp.managed.lifecycle", line),
    );
    expect(records.filter((event) => event.phase === "failed")).toMatchObject([
      { reason: "log-unavailable" },
    ]);
    expect(records.filter((event) => event.phase === "admitted")).toHaveLength(1);
    const timelines = analyzeLogText(f.lines.join("\n")).timelines;
    expect(timelines).toHaveLength(2);
    expect(
      timelines.every((timeline) =>
        timeline.lines.some((line) => line.op === "mcp.managed.lifecycle"),
      ),
    ).toBe(true);
    expect(f.lines.join("\n")).not.toContain("synthetic-private-sink-failure");
    await f.runtime.close();
  });

  it("offers the batch and its draft companion together only to a Chat with Knowledge scopes", async () => {
    const f = fixture();
    try {
      const scoped = await f.runtime.get({ knowledgeScoped: true });
      const unscoped = await f.runtime.get({ knowledgeScoped: false });
      expect(await f.runtime.get()).toBe(scoped);
      expect(await f.runtime.get({ knowledgeScoped: false })).toBe(unscoped);
      for (const alias of ["jira_draft", "jira_draft_batch"]) {
        const named = (tools: readonly { readonly name: string }[]): number =>
          tools.filter((tool) => tool.name === alias).length;
        expect(named(f.runtime.toolDefinitions())).toBe(1);
        expect(named(f.runtime.toolDefinitions({ knowledgeScoped: true }))).toBe(1);
        expect(named(f.runtime.toolDefinitions({ knowledgeScoped: false }))).toBe(0);
        expect(scoped.projection.tools.filter((tool) => tool.alias === alias)).toHaveLength(1);
        expect(unscoped.projection.tools.map((tool) => tool.alias)).not.toContain(alias);
      }
      expect(unscoped.catalog.descriptors).toHaveLength(scoped.catalog.descriptors.length - 2);
      expect(unscoped.handlerBindings).toHaveLength(scoped.handlerBindings.length - 2);
      expect(f.runtime.toolDefinitions({ knowledgeScoped: false })).toHaveLength(
        f.runtime.toolDefinitions().length - 2,
      );
    } finally {
      await f.runtime.close();
    }
  });

  it("keeps an explicitly selected draft without Knowledge scopes while omitting the batch", async () => {
    const f = fixture();
    try {
      const selected = await f.runtime.select(["composite:jira.draft"], { knowledgeScoped: false });
      const aliases = selected.projection.tools.map((tool) => tool.alias);
      expect(aliases.filter((alias) => alias === "jira_draft")).toHaveLength(1);
      expect(aliases).not.toContain("jira_draft_batch");
      expect(
        f.runtime.toolDefinitions({ knowledgeScoped: false }).map((tool) => tool.name),
      ).not.toContain("jira_draft");
    } finally {
      await f.runtime.close();
    }
  });

  it.each([{ knowledgeScoped: true }, { knowledgeScoped: false }])(
    "keeps the full base with selected board configuration within 262144 bytes (knowledgeScoped=$knowledgeScoped)",
    async (scope) => {
      const f = fixture();
      try {
        expect(TOOL_CATALOG_LIMITS.maxArgumentBytes).toBe(262_144);
        const advertised = f.runtime.toolDefinitions(scope).map((tool) => tool.name);
        const initial = await f.runtime.get(scope);
        const initialAliases = initial.projection.tools.map((tool) => tool.alias);
        expect(initialAliases.sort()).toEqual([...advertised].sort());
        expect(initialAliases).not.toContain("jira_board_configuration");

        const selected = await f.runtime.select(
          ["GET /rest/agile/1.0/board/{boardId}/configuration"],
          scope,
        );
        const aliases = selected.projection.tools.map((tool) => tool.alias);
        expect([...aliases].sort()).toEqual([...advertised, "jira_board_configuration"].sort());
        expect(new Set(aliases).size).toBe(aliases.length);
        expect(Buffer.byteLength(JSON.stringify(selected.catalog), "utf8")).toBeLessThanOrEqual(
          262_144,
        );
        for (const alias of ["jira_draft", "jira_draft_batch"])
          expect(aliases.includes(alias)).toBe(scope.knowledgeScoped);
        expect(f.runtime.toolDefinitions(scope).map((tool) => tool.name)).toEqual(advertised);
        expect((await f.runtime.get(scope)).projection.tools.map((tool) => tool.alias)).toEqual(
          initial.projection.tools.map((tool) => tool.alias),
        );
      } finally {
        await f.runtime.close();
      }
    },
  );

  it("omits the batch companion from an unrelated selection without Knowledge scopes", async () => {
    const f = fixture();
    try {
      const selected = await f.runtime.select(["GET /rest/api/2/project"], {
        knowledgeScoped: false,
      });
      const aliases = selected.projection.tools.map((tool) => tool.alias);
      expect(aliases).toContain("jira_projects");
      expect(aliases).not.toContain("jira_draft");
      expect(aliases).not.toContain("jira_draft_batch");
    } finally {
      await f.runtime.close();
    }
  });

  it.each([
    { identities: ["composite:jira.draft"] },
    { identities: ["composite:jira.draft-batch"] },
    { identities: ["composite:jira.draft", "composite:jira.draft-batch"] },
  ])(
    "deduplicates the batch pair when explicitly selected: $identities",
    async ({ identities }) => {
      const f = fixture();
      try {
        const selected = await f.runtime.select(identities, { knowledgeScoped: true });
        const aliases = selected.projection.tools.map((tool) => tool.alias);
        for (const alias of ["jira_draft", "jira_draft_batch"])
          expect(aliases.filter((offered) => offered === alias)).toHaveLength(1);
      } finally {
        await f.runtime.close();
      }
    },
  );

  it("closes idempotently after the initializer has disposed its failed host", async () => {
    const f = fixture();
    f.write.mockImplementationOnce(() => {
      throw new Error("synthetic-sink-failure");
    });
    await expect(f.runtime.get()).rejects.toMatchObject({ reason: "log-unavailable" });
    const closed = f.runtime.close();
    expect(f.runtime.close()).toBe(closed);
    await expect(closed).resolves.toBeUndefined();
    await expect(f.runtime.get()).rejects.toMatchObject({ reason: "handler-unavailable" });
    expect(f.record).toHaveBeenCalledOnce();
  });

  it("refuses a selection larger than one host carries before any host is built", async () => {
    const f = fixture();
    try {
      const everything = jiraOperationDefinitions().map((definition) => definition.identity);
      expect(everything.length).toBeGreaterThan(320);
      await expect(f.runtime.select(everything)).rejects.toMatchObject({
        name: "ToolCatalogError",
        reason: "input-bound",
      });
      expect(
        (await f.runtime.select(["GET /rest/api/2/serverInfo"])).projection.tools.length,
      ).toBeGreaterThan(0);
    } finally {
      await f.runtime.close();
    }
  });

  it("keeps concurrent selected schema sets isolated and the initial advertisement unchanged", async () => {
    const f = fixture();
    try {
      expect(TOOL_CATALOG_LIMITS.maxArgumentBytes).toBe(262_144);
      const advertised = f.runtime.toolDefinitions().map((tool) => tool.name);
      expect(advertised).not.toContain("jira_board_configuration");
      expect(advertised).not.toContain("jira_server_info");
      const [board, server] = await Promise.all([
        f.runtime.select(["GET /rest/agile/1.0/board/{boardId}/configuration"]),
        f.runtime.select(["GET /rest/api/2/serverInfo"]),
      ]);
      const boardAliases = board.projection.tools.map((tool) => tool.alias);
      const serverAliases = server.projection.tools.map((tool) => tool.alias);
      expect([...boardAliases].sort()).toEqual([...advertised, "jira_board_configuration"].sort());
      expect([...serverAliases].sort()).toEqual([...advertised, "jira_server_info"].sort());
      expect(boardAliases).not.toContain("jira_server_info");
      expect(serverAliases).not.toContain("jira_board_configuration");
      for (const selected of [board, server])
        expect(Buffer.byteLength(JSON.stringify(selected.catalog), "utf8")).toBeLessThanOrEqual(
          262_144,
        );
      expect(f.runtime.toolDefinitions().map((tool) => tool.name)).toEqual(advertised);
      await board.close();
      expect(server.handlerBindings.every((binding) => binding.readiness() === "ready")).toBe(true);
      await f.runtime.close();
      expect(server.handlerBindings[0]?.readiness()).toBe("unavailable");
      await expect(f.runtime.select([])).rejects.toMatchObject({ reason: "handler-unavailable" });
    } finally {
      await f.runtime.close();
    }
  });

  it("refuses unknown or duplicate identities before admitting a selected host", async () => {
    const f = fixture();
    await expect(
      f.runtime.select(["GET https://unexpected.invalid/private"]),
    ).rejects.toMatchObject({ reason: "invalid-arguments" });
    await expect(
      f.runtime.select(["GET /rest/api/2/project", "GET /rest/api/2/project"]),
    ).rejects.toMatchObject({ reason: "invalid-arguments" });
    expect(f.write).not.toHaveBeenCalled();
    await f.runtime.close();
  });

  it("settles close while the failed initialization is still pending", async () => {
    const f = fixture();
    f.write.mockImplementationOnce(() => {
      throw new Error("synthetic-sink-failure");
    });
    const first = expect(f.runtime.get()).rejects.toMatchObject({ reason: "log-unavailable" });
    const second = expect(f.runtime.get()).rejects.toMatchObject({ reason: "log-unavailable" });
    const closing = expect(f.runtime.close()).resolves.toBeUndefined();
    await Promise.all([first, second, closing]);
    await expect(f.runtime.get()).rejects.toMatchObject({ reason: "handler-unavailable" });
    expect(f.record).toHaveBeenCalledOnce();
  });

  it("does not admit a completed initialization after close has started", async () => {
    const original = managedProvider.createManagedProviderCatalog;
    const release = releaseGate();
    const close = vi.fn<() => Promise<void>>();
    const create = vi
      .spyOn(managedProvider, "createManagedProviderCatalog")
      .mockImplementationOnce(async (input) => {
        await release.promise;
        const managed = await original(input);
        close.mockImplementation(managed.close);
        return { ...managed, close };
      });
    const f = fixture();
    const waiting = f.runtime.get();
    const observed = expect(waiting).rejects.toMatchObject({ reason: "handler-unavailable" });
    const closing = f.runtime.close();
    expect(f.runtime.close()).toBe(closing);
    release.release();
    await Promise.all([observed, closing]);
    await expect(f.runtime.get()).rejects.toMatchObject({ reason: "handler-unavailable" });
    expect(create).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves actual host-close errors without retrying or reopening the runtime", async () => {
    const original = managedProvider.createManagedProviderCatalog;
    const failure = new Error("synthetic-close-failure");
    const close = vi.fn<() => Promise<void>>();
    vi.spyOn(managedProvider, "createManagedProviderCatalog").mockImplementationOnce(
      async (input) => {
        const managed = await original(input);
        close.mockImplementation(async () => {
          await managed.close();
          throw failure;
        });
        return { ...managed, close };
      },
    );
    const f = fixture();
    await f.runtime.get();
    const closing = f.runtime.close();
    expect(f.runtime.close()).toBe(closing);
    await expect(closing).rejects.toBe(failure);
    await expect(f.runtime.get()).rejects.toMatchObject({ reason: "handler-unavailable" });
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("the advice about a draft that names no requirement (S16 of #4173)", () => {
  const turn = (userMessageId: string): Parameters<typeof untracedAdvisory>[2] => ({
    chatId: "chat-1",
    userMessageId,
    correlationId: "c-1",
  });
  const deps = { activityLog: undefined } as unknown as Parameters<typeof untracedAdvisory>[0];

  it("lets the same items pass once advised and advises about other items of the turn", () => {
    const advised = new Set<string>();
    const advise = untracedAdvisory(deps, advised, turn("m-1"));
    expect(advise(["epic", "task-1", "task-2"])).toBe(true);
    expect(advise(["task-2", "task-1", "epic"])).toBe(false);
    expect(advise(["task-1", "task-2"])).toBe(true);
    expect(advise(["task-1", "task-2"])).toBe(false);
    // A separate turn asks again; item names cannot run together across a separator.
    expect(untracedAdvisory(deps, advised, turn("m-2"))(["task-1", "task-2"])).toBe(true);
    expect(advise(["task-1,task-2"])).toBe(true);
  });

  it("stays bounded however many drafts a long session advises about", () => {
    const advised = new Set<string>();
    const advise = untracedAdvisory(deps, advised, turn("m-1"));
    for (let index = 0; index < 400; index += 1) advise([`item-${String(index)}`]);
    expect(advised.size).toBe(256);
  });
});
