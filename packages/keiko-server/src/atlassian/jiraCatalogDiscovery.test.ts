import { describe, expect, it, vi, type Mock } from "vitest";
import { CatalogDispatchFault } from "../tool-catalog/catalogToolErrors.js";
import { ToolCatalogError } from "@oscharko-dev/keiko-tool-catalog";
import * as provider from "./jiraManagedProvider.js";
import {
  createJiraCatalogDiscoveryProvider,
  jiraToolsForIdentities,
} from "./jiraCatalogDiscovery.js";
import type { CatalogHandlerContext } from "../tool-catalog/catalogToolPorts.js";
import type { JiraChatCatalogConsumer } from "./jiraChatCatalogConsumer.js";

type Context = CatalogHandlerContext<JiraChatCatalogConsumer>;
type Tool = ReturnType<ReturnType<typeof createJiraCatalogDiscoveryProvider>["tools"]>[number];
function fixture(): {
  context: Context;
  select: Mock<NonNullable<Context["selectJiraOperations"]>>;
  discover: Tool;
  describe: Tool;
} {
  const select = vi
    .fn<NonNullable<CatalogHandlerContext<JiraChatCatalogConsumer>["selectJiraOperations"]>>()
    .mockResolvedValue(undefined);
  const context = {
    signal: new AbortController().signal,
    beforeEffect: () => true,
    jiraDiscoveryResultFits: () => true,
    selectJiraOperations: select,
  } as unknown as CatalogHandlerContext<JiraChatCatalogConsumer>;
  const tools = createJiraCatalogDiscoveryProvider().tools();
  const discover = tools.find((tool) => tool.name === "jira.discover");
  const describe = tools.find((tool) => tool.name === "jira.describe");
  if (discover === undefined || describe === undefined)
    throw new TypeError("Missing discovery tools");
  return { context, select, discover, describe };
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
    } finally { all.mockRestore(); }
  });

  it("bounds Coding metadata to the current server-owned tools and refuses foreign selections", async () => {
    const f = fixture();
    const tools = createJiraCatalogDiscoveryProvider({ tools: new Set(["jira.projects"]), nativeToolNames: true }).tools();
    const discovery = tools.find((tool) => tool.name === "jira.discover");
    const selection = tools.find((tool) => tool.name === "jira.describe");
    if (discovery === undefined || selection === undefined) throw new TypeError("Missing tools");
    expect((await discovery.execute({}, f.context)).data).toMatchObject({ total: 1,
      items: [{ identity: "GET /rest/api/2/project", tool: "jira.projects" }] });
    await expect(selection.execute({ identities: ["POST /rest/api/2/monitoring/app"] }, f.context))
      .rejects.toMatchObject({ reason: "effect-denied" });
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

  it("refuses unknown identities and duplicates without requesting another catalog", async () => {
    const f = fixture();
    for (const identities of [
      ["https://private.invalid/path"],
      ["GET /rest/api/2/project", "GET /rest/api/2/project"],
    ]) {
      await expect(f.describe.execute({ identities }, f.context)).rejects.toMatchObject({
        reason: "invalid-arguments",
      });
    }
    expect(f.select).not.toHaveBeenCalled();
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

  it("refuses a selected invalid schema while preserving unrelated programming failures", async () => {
    const f = fixture();
    f.select.mockRejectedValueOnce(new ToolCatalogError("invalid-schema"));
    expect(await f.describe.execute({ identities: ["GET /rest/api/2/project"] }, f.context))
      .toMatchObject({ isError: true, data: { reason: "selection-unavailable" } });
    const defect = new TypeError("Unexpected invariant defect");
    f.select.mockRejectedValueOnce(defect);
    await expect(f.describe.execute({ identities: ["GET /rest/api/2/project"] }, f.context)).rejects.toBe(defect);
  });

  it("honors the governed effect boundary even for local schema selection", async () => {
    const f = fixture();
    await expect(
      f.describe.execute({ identities: [] }, { ...f.context, beforeEffect: () => false }),
    ).rejects.toMatchObject({ reason: "effect-denied" });
    expect(f.select).not.toHaveBeenCalled();
  });
});
