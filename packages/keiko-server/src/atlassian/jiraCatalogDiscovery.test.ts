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
  { identities: ["jira.create"] },
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
  it("lists and resolves registry identities without compiling unrelated schemas", async () => {
    const all = vi.spyOn(provider, "jiraOperationContracts").mockImplementation(() => {
      throw new TypeError("Unrelated invalid descriptor");
    });
    try {
      const f = fixture();
      expect((await f.discover.execute({ maxResults: 1 }, f.context)).data.items).toHaveLength(1);
      expect(jiraToolsForIdentities(["GET /rest/api/2/project"])).toEqual(["jira.projects"]);
      expect(all).not.toHaveBeenCalled();
    } finally {
      all.mockRestore();
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

  it("honors the governed effect boundary even for local schema selection", async () => {
    const f = fixture();
    await expect(
      f.describe.execute({ identities: [] }, { ...f.context, beforeEffect: () => false }),
    ).rejects.toMatchObject({ reason: "effect-denied" });
    expect(f.select).not.toHaveBeenCalled();
  });
});
