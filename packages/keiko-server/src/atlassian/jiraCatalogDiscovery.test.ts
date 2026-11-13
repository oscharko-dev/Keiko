import { describe, expect, it, vi, type Mock } from "vitest";
import { CatalogDispatchFault } from "../tool-catalog/catalogToolErrors.js";
import { ToolCatalogError } from "@oscharko-dev/keiko-tool-catalog";
import { createManagedMcpHost, ManagedMcpError } from "@oscharko-dev/keiko-mcp";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import * as provider from "./jiraManagedProvider.js";
import {
  createJiraCatalogDiscoveryProvider,
  JIRA_CATALOG_DISCOVERY_TOOLS,
  jiraToolsForIdentities,
} from "./jiraCatalogDiscovery.js";
import type { CatalogHandlerContext } from "../tool-catalog/catalogToolPorts.js";
import { jiraChatCatalogRoutes, type JiraChatCatalogConsumer } from "./jiraChatCatalogConsumer.js";
import { createManagedProviderCatalog } from "../tool-catalog/managedProviderCatalog.js";
import type { CatalogLifecycleLogPort } from "../tool-catalog/catalogToolLifecycle.js";

type Context = CatalogHandlerContext<JiraChatCatalogConsumer>;
type Tool = ReturnType<ReturnType<typeof createJiraCatalogDiscoveryProvider>["tools"]>[number];
const INVALID_DESCRIPTION_ARGS: readonly CatalogJsonObject[] = [
  { identities: ["https://private.invalid/path"] },
  { identities: ["jira.unknown-operation"] },
  { identities: ["jira_create_nothing"] },
  { identities: ["GET /rest/api/2/project", "GET /rest/api/2/project"] },
  { identities: ["GET /rest/api/2/project", "GET /rest/api/2/unknown"] },
  { identities: "GET /rest/api/2/project" },
  { identities: [42] },
  {},
];
function fixture(): {
  context: Context;
  select: Mock<NonNullable<Context["selectJiraOperations"]>>;
  provider: ReturnType<typeof createJiraCatalogDiscoveryProvider>;
  discover: Tool;
  describe: Tool;
} {
  const select = vi
    .fn<NonNullable<CatalogHandlerContext<JiraChatCatalogConsumer>["selectJiraOperations"]>>()
    .mockResolvedValue(undefined);
  const context = {
    invocationId: "discovery-invocation",
    correlationId: "discovery-proof",
    signal: new AbortController().signal,
    beforeEffect: () => true,
    jiraDiscoveryResultFits: () => true,
    selectJiraOperations: select,
  } as unknown as CatalogHandlerContext<JiraChatCatalogConsumer>;
  const discoveryProvider = createJiraCatalogDiscoveryProvider();
  const tools = discoveryProvider.tools();
  const discover = tools.find((tool) => tool.name === "jira.discover");
  const describe = tools.find((tool) => tool.name === "jira.describe");
  if (discover === undefined || describe === undefined)
    throw new TypeError("Missing discovery tools");
  return { context, select, provider: discoveryProvider, discover, describe };
}

describe("local Jira operation discovery", () => {
  it("shares one issued descriptor per discovery tool across provider constructions", () => {
    // Every Jira chat selection constructs this provider again; its descriptors are constants (#4288).
    const first = createJiraCatalogDiscoveryProvider().tools();
    const second = createJiraCatalogDiscoveryProvider({}).tools();
    expect(first.map((tool) => tool.name)).toEqual(["jira.discover", "jira.describe"]);
    first.forEach((tool, index) => {
      expect(second[index]?.descriptor).toBe(tool.descriptor);
    });
  });

  it("lists and resolves registry identities without compiling unrelated schemas", async () => {
    const all = vi.spyOn(provider, "jiraOperationContracts").mockImplementation(() => {
      throw new TypeError("Unrelated invalid descriptor");
    });
    // Ranking by ordinary words reads the generated summary table: no descriptor is built, so
    // a turn that never calls discover pays nothing, and one that does pays no compile (#4357).
    const one = vi.spyOn(provider, "jiraOperationForTool").mockImplementation(() => {
      throw new TypeError("Unrelated invalid descriptor");
    });
    try {
      const f = fixture();
      expect((await f.discover.execute({ maxResults: 1 }, f.context)).data.items).toHaveLength(1);
      const ranked = await f.discover.execute({ query: "who am I", maxResults: 3 }, f.context);
      expect((ranked.data.items as readonly { tool: string }[])[0]?.tool).toBe("jira_myself");
      expect(jiraToolsForIdentities(["GET /rest/api/2/project"])).toEqual(["jira.projects"]);
      expect(all).not.toHaveBeenCalled();
      expect(one).not.toHaveBeenCalled();
    } finally {
      all.mockRestore();
      one.mockRestore();
    }
  });

  it("bounds Coding metadata to the current server-owned tools and refuses foreign selections", async () => {
    const f = fixture();
    const tools = createJiraCatalogDiscoveryProvider({
      tools: new Set(["jira.projects"]),
      nativeToolNames: true,
    }).tools();
    const discovery = tools.find((tool) => tool.name === "jira.discover");
    const selection = tools.find((tool) => tool.name === "jira.describe");
    if (discovery === undefined || selection === undefined) throw new TypeError("Missing tools");
    expect((await discovery.execute({}, f.context)).data).toMatchObject({
      total: 1,
      items: [{ identity: "GET /rest/api/2/project", tool: "jira.projects" }],
    });
    await expect(
      selection.execute({ identities: ["POST /rest/api/2/monitoring/app"] }, f.context),
    ).rejects.toMatchObject({ reason: "effect-denied" });
    expect(f.select).not.toHaveBeenCalled();
  });
  it("pages implemented registry summaries without creating a selection or reading Jira", async () => {
    const f = fixture();
    const first = await f.discover.execute({ maxResults: 1 }, f.context);
    expect(first.data).toMatchObject({
      startAt: 0,
      nextStartAt: 1,
      items: [
        expect.objectContaining({
          identity: expect.any(String) as string,
          tool: expect.any(String) as string,
        }),
      ],
    });
    const total = first.data.total;
    if (typeof total !== "number") throw new TypeError("Missing discovery total");
    const last = await f.discover.execute({ startAt: total }, f.context);
    expect(last.data.items).toEqual([]);
    expect(last.data.nextStartAt).toBeUndefined();
    expect(f.select).not.toHaveBeenCalled();
  });

  it("ranks operations matching a plain-word query first, before any paging", async () => {
    const f = fixture();
    const unfiltered = await f.discover.execute({ maxResults: 100 }, f.context);
    const total = unfiltered.data.total;
    if (typeof total !== "number") throw new TypeError("Missing discovery total");
    const ranked = await f.discover.execute({ query: "create project", maxResults: 3 }, f.context);
    const items = ranked.data.items as readonly { identity: string; tool: string }[];
    expect(items[0]).toMatchObject({
      identity: "POST /rest/api/2/project",
      tool: "jira_create_project",
    });
    const matched = ranked.data.total;
    if (typeof matched !== "number") throw new TypeError("Missing ranked total");
    expect(matched).toBeGreaterThan(0);
    expect(matched).toBeLessThan(total);
    expect(ranked.data.nextStartAt).toBe(3);
    const synonym = await f.discover.execute({ query: "make project", maxResults: 100 }, f.context);
    expect(synonym.data.total).toBeGreaterThan(0);
    const blank = await f.discover.execute({ query: " -/ ", maxResults: 1 }, f.context);
    expect(blank.data.total).toBe(total);
    const none = await f.discover.execute({ query: "zzqqxx", maxResults: 1 }, f.context);
    expect(none.data).toMatchObject({ outcome: "succeeded", items: [], total: 0 });
    expect(f.select).not.toHaveBeenCalled();
  });
  it("binds a closed identity and passes the exact short receipt for next-round budget accounting", async () => {
    const f = fixture();
    const result = await f.describe.execute({ identities: ["GET /rest/api/2/project"] }, f.context);
    expect(result.data).toEqual({
      outcome: "succeeded",
      selectedFor: "next-round",
      items: [{ identity: "GET /rest/api/2/project", tool: "jira_projects" }],
    });
    expect(f.select).toHaveBeenCalledWith(["GET /rest/api/2/project"], result.data);
    expect(jiraToolsForIdentities(["GET /rest/api/2/project"])).toEqual(["jira.projects"]);
  });

  it("accepts the tool name jira.discover returns beside an identity and selects its exact identity", async () => {
    // The model copies the `tool` field of a discover item; 53 of 56 first describes were refused for it.
    const f = fixture();
    const discovered = await f.discover.execute({ query: "projects", maxResults: 100 }, f.context);
    const items = discovered.data.items as readonly { identity: string; tool: string }[];
    const projects = items.find((item) => item.identity === "GET /rest/api/2/project");
    expect(projects?.tool).toBe("jira_projects");
    const result = await f.describe.execute({ identities: ["jira_projects"] }, f.context);
    expect(result.isError).toBeUndefined();
    expect(result.data).toEqual({
      outcome: "succeeded",
      selectedFor: "next-round",
      items: [{ identity: "GET /rest/api/2/project", tool: "jira_projects" }],
    });
    expect(f.select).toHaveBeenCalledWith(["GET /rest/api/2/project"], result.data);
    const mixed = await f.describe.execute(
      { identities: ["jira_projects", "POST /rest/api/2/project"] },
      f.context,
    );
    expect(mixed.data).toMatchObject({ outcome: "succeeded" });
    expect(f.select).toHaveBeenLastCalledWith(
      ["GET /rest/api/2/project", "POST /rest/api/2/project"],
      mixed.data,
    );
  });

  it("accepts the dotted registry name Keiko's own descriptions use for the same operation", async () => {
    // Measured 2026-11-13: after only discover's `jira_priorities` was accepted, the model still
    // called `jira.priorities` first in 6 of 15 discovery turns and succeeded once the separator changed.
    const f = fixture();
    for (const name of ["jira.priorities", "jira_priorities"]) {
      f.select.mockClear();
      const result = await f.describe.execute({ identities: [name] }, f.context);
      expect(result.isError, name).toBeUndefined();
      expect(result.data.items, name).toEqual([
        { identity: "GET /rest/api/2/priority", tool: "jira_priorities" },
      ]);
      expect(f.select).toHaveBeenCalledWith(["GET /rest/api/2/priority"], result.data);
    }
    const hyphenated = await f.describe.execute(
      { identities: ["jira.project-statuses"] },
      f.context,
    );
    expect(hyphenated.data.items).toEqual([
      expect.objectContaining({ tool: "jira_project_statuses" }),
    ]);
    const both = await f.describe.execute(
      { identities: ["jira.priorities", "jira_priorities"] },
      f.context,
    );
    expect(both.isError).toBe(true);
    for (const refused of ["jira.priorities.", "jira priorities", "JIRA.PRIORITIES"]) {
      const result = await f.describe.execute({ identities: [refused] }, f.context);
      expect(result.isError, refused).toBe(true);
    }
  });

  it("accepts the dotted tool name only where jira.discover returns it, and never twice for one operation", async () => {
    const f = fixture();
    const native = createJiraCatalogDiscoveryProvider({
      tools: new Set(["jira.projects"]),
      nativeToolNames: true,
    })
      .tools()
      .find((tool) => tool.name === "jira.describe");
    if (native === undefined) throw new TypeError("Missing describe tool");
    const result = await native.execute({ identities: ["jira.projects"] }, f.context);
    expect(result.data).toMatchObject({
      outcome: "succeeded",
      items: [{ identity: "GET /rest/api/2/project", tool: "jira.projects" }],
    });
    expect(f.select).toHaveBeenCalledWith(["GET /rest/api/2/project"], result.data);
    f.select.mockClear();
    const twice = await f.describe.execute(
      { identities: ["jira_projects", "GET /rest/api/2/project"] },
      f.context,
    );
    expect(twice.isError).toBe(true);
    expect(twice.data).toMatchObject({ reason: "invalid-arguments" });
    const foreign = await native.execute({ identities: ["jira.create-project"] }, f.context);
    expect(foreign.isError).toBe(true);
    expect(f.select).not.toHaveBeenCalled();
  });

  it("names the operations a replacing selection drops, so none disappears unannounced (LIM22)", async () => {
    const f = fixture();
    const context = {
      ...f.context,
      selectedJiraOperations: (): readonly string[] => [
        "POST /rest/api/2/project",
        "GET /rest/api/2/project/type",
      ],
    };
    const result = await f.describe.execute(
      { identities: ["GET /rest/api/2/mypermissions", "GET /rest/api/2/project/type"] },
      context,
    );
    expect(result.data).toMatchObject({
      outcome: "succeeded",
      selectedFor: "next-round",
      deselected: [{ identity: "POST /rest/api/2/project", tool: "jira_create_project" }],
    });
    expect(result.data.guidance).toMatch(/no longer offered/u);
    expect(f.select).toHaveBeenCalledWith(
      ["GET /rest/api/2/mypermissions", "GET /rest/api/2/project/type"],
      result.data,
    );
    const kept = await f.describe.execute(
      { identities: ["POST /rest/api/2/project", "GET /rest/api/2/project/type"] },
      context,
    );
    expect(kept.data).not.toHaveProperty("deselected");
    expect(kept.data).not.toHaveProperty("guidance");
  });

  it("ends a discovery page at the current model budget and reports where to continue", async () => {
    const f = fixture();
    const response = await f.discover.execute(
      {},
      {
        ...f.context,
        jiraDiscoveryResultFits: (result) =>
          Array.isArray(result.items) && result.items.length <= 2,
      },
    );
    expect(response.data).toMatchObject({ nextStartAt: 2 });
    expect(response.data.items).toHaveLength(2);
  });

  it.each(INVALID_DESCRIPTION_ARGS)(
    "returns readable invalid arguments without selecting tools for %j",
    async (args) => {
      const f = fixture();
      const result = await f.describe.execute(args, f.context);
      expect(result.isError).toBe(true);
      expect(result.data).toMatchObject({
        outcome: "failed",
        reason: "invalid-arguments",
        items: [],
      });
      expect(result.data.guidance).toContain("jira.discover");
      expect(JSON.stringify(result.data)).not.toContain("private.invalid");
      expect(f.select).not.toHaveBeenCalled();
    },
  );

  it("marks an invalid describe identity as a managed tool error with private readable data", async () => {
    const f = fixture();
    const write = vi.fn<CatalogLifecycleLogPort["primary"]["write"]>();
    const host = createManagedMcpHost({ providers: [f.provider], log: { write } });
    try {
      await host.admit("discovery-invalid-identity");
      expect(f.describe.descriptor.toolRef.contractVersion).toBe(2);
      const failure: unknown = await host
        .call("jira.describe", { identities: ["https://private.invalid/path"] }, f.context)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ManagedMcpError);
      if (!(failure instanceof ManagedMcpError)) throw new TypeError("Expected managed tool error");
      expect(failure.reason).toBe("tool-error");
      expect(failure.structuredResult).toMatchObject({
        outcome: "failed",
        reason: "invalid-arguments",
        items: [],
      });
      expect(failure.structuredResult?.guidance).toContain("jira.discover");
      expect(Object.isFrozen(failure.structuredResult)).toBe(true);
      expect(JSON.stringify(failure.structuredResult)).not.toContain("private.invalid");
      expect(JSON.stringify(failure)).not.toMatch(
        /invalid-arguments|jira\.discover|private\.invalid/u,
      );
      expect(JSON.stringify(write.mock.calls)).not.toMatch(
        /invalid-arguments|jira\.discover|private\.invalid/u,
      );
      expect(f.select).not.toHaveBeenCalled();
    } finally {
      await host.close();
    }
  });

  it("preserves invalid describe guidance through the existing provider-reported-error adapter", async () => {
    const f = fixture();
    const write = vi.fn<CatalogLifecycleLogPort["primary"]["write"]>();
    const managed = await createManagedProviderCatalog({
      providers: [f.provider],
      routes: jiraChatCatalogRoutes(JIRA_CATALOG_DISCOVERY_TOOLS),
      profile: { id: "discovery-error-fixture", version: 1 },
      log: { primary: { write }, diagnostics: { record: vi.fn() } },
      correlationId: "discovery-invalid-adapter",
      now: () => 0,
    });
    try {
      const binding = managed.handlerBindings.find(
        (handler) => handler.toolRef.canonicalId === "keiko.jira.describe",
      );
      if (binding === undefined) throw new TypeError("Missing describe binding");
      const failure: unknown = await binding
        .execute({ identities: ["https://private.invalid/path"] }, f.context)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CatalogDispatchFault);
      if (!(failure instanceof CatalogDispatchFault))
        throw new TypeError("Expected provider-reported dispatch failure");
      expect(failure).toMatchObject({ status: "failed", reason: "provider-reported-error" });
      expect(failure.providerResult).toMatchObject({
        outcome: "failed",
        reason: "invalid-arguments",
        items: [],
      });
      expect(failure.providerResult?.guidance).toContain("jira.discover");
      expect(Object.isFrozen(failure.providerResult)).toBe(true);
      expect(JSON.stringify(failure.providerResult)).not.toContain("private.invalid");
      expect(JSON.stringify(failure)).not.toMatch(
        /invalid-arguments|jira\.discover|private\.invalid/u,
      );
      expect(JSON.stringify(write.mock.calls)).not.toMatch(
        /invalid-arguments|jira\.discover|private\.invalid/u,
      );
      expect(f.select).not.toHaveBeenCalled();
    } finally {
      await managed.close();
    }
  });

  it("returns an explicit budget refusal instead of silently truncating a selected schema set", async () => {
    const f = fixture();
    f.select.mockRejectedValue(new CatalogDispatchFault("denied", "budget-exhausted"));
    await expect(
      f.describe.execute({ identities: ["GET /rest/api/2/project"] }, f.context),
    ).resolves.toEqual({
      isError: true,
      data: { outcome: "failed", reason: "budget-exhausted", items: [] },
    });
  });

  it("tells the model an oversized selection is too large and how to narrow it", async () => {
    const f = fixture();
    f.select.mockRejectedValueOnce(new ToolCatalogError("input-bound"));
    const result = await f.describe.execute({ identities: ["GET /rest/api/2/project"] }, f.context);
    expect(result).toMatchObject({
      isError: true,
      data: { outcome: "failed", reason: "selection-too-large", items: [] },
    });
    expect(JSON.stringify(result.data)).toContain("Select only the operations needed");
  });

  it("refuses a selected invalid schema while preserving unrelated programming failures", async () => {
    const f = fixture();
    f.select.mockRejectedValueOnce(new ToolCatalogError("invalid-schema"));
    expect(
      await f.describe.execute({ identities: ["GET /rest/api/2/project"] }, f.context),
    ).toMatchObject({ isError: true, data: { reason: "selection-unavailable" } });
    const defect = new TypeError("Unexpected invariant defect");
    f.select.mockRejectedValueOnce(defect);
    await expect(
      f.describe.execute({ identities: ["GET /rest/api/2/project"] }, f.context),
    ).rejects.toBe(defect);
  });

  it("delivers every failure reason as a refusal through the real catalog adapter, never as success", async () => {
    const f = fixture();
    const managed = await createManagedProviderCatalog({
      providers: [f.provider],
      routes: jiraChatCatalogRoutes(JIRA_CATALOG_DISCOVERY_TOOLS),
      profile: { id: "discovery-failure-fixture", version: 1 },
      log: { primary: { write: vi.fn() }, diagnostics: { record: vi.fn() } },
      correlationId: "discovery-failure-classification",
      now: () => 0,
    });
    const binding = managed.handlerBindings.find(
      (handler) => handler.toolRef.canonicalId === "keiko.jira.describe",
    );
    if (binding === undefined) throw new TypeError("Missing describe binding");
    const identities = ["GET /rest/api/2/project"];
    const cases: readonly [string, Error | undefined, CatalogJsonObject][] = [
      ["invalid-arguments", undefined, { identities: ["jira.unknown-operation"] }],
      ["selection-too-large", new ToolCatalogError("input-bound"), { identities }],
      ["selection-unavailable", new ToolCatalogError("invalid-schema"), { identities }],
      ["budget-exhausted", new CatalogDispatchFault("denied", "budget-exhausted"), { identities }],
    ];
    try {
      for (const [reason, selectFault, args] of cases) {
        if (selectFault !== undefined) f.select.mockRejectedValueOnce(selectFault);
        const direct = await f.describe.execute(args, f.context);
        expect(direct).toMatchObject({ isError: true, data: { outcome: "failed", reason } });
        if (selectFault !== undefined) f.select.mockRejectedValueOnce(selectFault);
        const failure: unknown = await binding.execute(args, f.context).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(CatalogDispatchFault);
        expect(failure).toMatchObject({ status: "failed", reason: "provider-reported-error" });
        expect((failure as CatalogDispatchFault).providerResult).toMatchObject({ reason });
      }
    } finally {
      await managed.close();
    }
  });

  it("honors the governed effect boundary even for local schema selection", async () => {
    const f = fixture();
    await expect(
      f.describe.execute({ identities: [] }, { ...f.context, beforeEffect: () => false }),
    ).rejects.toMatchObject({ reason: "effect-denied" });
    expect(f.select).not.toHaveBeenCalled();
  });
});

// #4357 discoverability: a person's ordinary words must find the operation, and a hit must read as a
// plain sentence, not as the authority action. Everything here goes through the real discover and
// describe tools over the real operation registry.
const ORDINARY_WORD_QUERIES: readonly (readonly [query: string, tool: string])[] = [
  ["who am I", "jira.myself"],
  ["current user", "jira.myself"],
  ["connected account user name", "jira.myself"],
  ["project statuses", "jira.project-statuses"],
  ["statuses of a project", "jira.project-statuses"],
  ["watch issue", "jira.watch"],
  ["add me as a watcher", "jira.watch"],
  ["stop watching", "jira.unwatch"],
  ["remove watcher", "jira.unwatch"],
  ["who watches this issue", "jira.watchers"],
  ["delete issue", "jira.delete-issue"],
  ["priorities", "jira.priorities"],
  ["board configuration", "jira.board-configuration"],
  ["project versions", "jira.versions"],
  // The everyday operations the lab's deployment model did not reach (3 of 3 wrong tool each).
  ["list all fields", "jira.fields"],
  ["all fields", "jira.fields"],
  ["search users", "jira.users"],
  ["find a user", "jira.users"],
];
const FIRST_PAGE = 5;

describe("finding an operation in ordinary words (#4357)", () => {
  it.each(ORDINARY_WORD_QUERIES)(
    "puts the operation for %j on the first page",
    async (query, tool) => {
      const f = fixture();
      const found = await f.discover.execute({ query, maxResults: 100 }, f.context);
      const items = found.data.items as readonly { identity: string; tool: string }[];
      const names = items.slice(0, FIRST_PAGE).map((item) => item.tool);
      expect(names, query).toContain(tool.replace(/[.-]/gu, "_"));
      // The listed tool name is the one jira.describe accepts for the same operation.
      const hit = items.find((item) => item.tool === tool.replace(/[.-]/gu, "_"));
      const selected = await f.describe.execute({ identities: [hit?.tool ?? ""] }, f.context);
      expect(selected.isError, query).toBeUndefined();
    },
  );

  it("describes each hit in one plain sentence instead of the authority action", async () => {
    const f = fixture();
    const found = await f.discover.execute(
      { query: "project statuses", maxResults: 20 },
      f.context,
    );
    const items = found.data.items as readonly { tool: string; description: string }[];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.description, item.tool).toMatch(/^[A-Z][^\n]{10,139}$/u);
      expect(item.description, item.tool).not.toMatch(/^jira[._-]/iu);
    }
    const statuses = items.find((item) => item.tool === "jira_project_statuses");
    expect(statuses?.description).toMatch(/project/iu);
  });

  it.each(["zzqqxx", "weather forecast tomorrow", "quantum entanglement"])(
    "returns nothing, and invents no match, for the unrelated query %j",
    async (query) => {
      const f = fixture();
      const none = await f.discover.execute({ query, maxResults: 20 }, f.context);
      expect(none.data).toMatchObject({ outcome: "succeeded", items: [], total: 0 });
    },
  );

  it("tells the model when to search and to phrase another language in English operation words", () => {
    const f = fixture();
    const description = f.discover.descriptor.description;
    expect(description).toMatch(
      /whenever no offered tool does what was asked, before answering that it cannot be done/u,
    );
    expect(description).toMatch(/another language in these English words/u);
    expect(description).not.toMatch(/stable identity/u);
  });

  it("keeps an unlisted operation out of reach whatever the words say", async () => {
    const f = fixture();
    const restricted = createJiraCatalogDiscoveryProvider({
      tools: new Set(["jira.projects"]),
      nativeToolNames: true,
    }).tools();
    const discover = restricted.find((tool) => tool.name === "jira.discover");
    const describeTool = restricted.find((tool) => tool.name === "jira.describe");
    if (discover === undefined || describeTool === undefined) throw new TypeError("Missing tools");
    for (const query of ["who am I", "watch issue", "delete issue", "project statuses"]) {
      const found = await discover.execute({ query, maxResults: 100 }, f.context);
      const names = (found.data.items as readonly { tool: string }[]).map((item) => item.tool);
      expect(
        names.every((name) => name === "jira.projects"),
        query,
      ).toBe(true);
    }
    await expect(
      describeTool.execute({ identities: ["jira.myself"] }, f.context),
    ).resolves.toMatchObject({ isError: true });
    expect(f.select).not.toHaveBeenCalled();
  });
});
