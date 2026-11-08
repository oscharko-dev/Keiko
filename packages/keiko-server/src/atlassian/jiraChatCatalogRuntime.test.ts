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
import * as managedProvider from "../tool-catalog/managedProviderCatalog.js";
import { createJiraChatCatalogRuntime, untracedAdvisory } from "./jiraChatCatalogRuntime.js";
import { KNOWLEDGE_CHAT_TOOLS } from "../requirementsToolName.js";

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

describe("application-owned Jira catalog initialization", () => {
  it("advertises discovery, Knowledge and batch execution schemas before an explicit selection", async () => {
    const f = fixture();
    expect(
      f.runtime
        .toolDefinitions()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(
      [
        "jira_draft",
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
    expect(first.catalog.descriptors).toHaveLength(4 + KNOWLEDGE_CHAT_TOOLS.length);
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

  it("keeps concurrent selected schema sets isolated and the initial advertisement unchanged", async () => {
    const f = fixture();
    const [projects, issue] = await Promise.all([
      f.runtime.select(["GET /rest/api/2/project"]),
      f.runtime.select(["GET /rest/api/2/issue/{issueIdOrKey}"]),
    ]);
    expect(projects.projection.tools.map((tool) => tool.alias)).toContain("jira_projects");
    expect(projects.projection.tools.map((tool) => tool.alias)).not.toContain("jira_issue");
    expect(issue.projection.tools.map((tool) => tool.alias)).toContain("jira_issue");
    expect(issue.projection.tools.map((tool) => tool.alias)).not.toContain("jira_projects");
    expect(f.runtime.toolDefinitions().map((tool) => tool.name)).not.toContain("jira_projects");
    await projects.close();
    expect(issue.handlerBindings.every((binding) => binding.readiness() === "ready")).toBe(true);
    await f.runtime.close();
    expect(issue.handlerBindings[0]?.readiness()).toBe("unavailable");
    await expect(f.runtime.select([])).rejects.toMatchObject({ reason: "handler-unavailable" });
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
