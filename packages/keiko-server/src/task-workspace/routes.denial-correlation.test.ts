import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "../index.js";
import { mockRequest } from "../_support.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import type { RouteContext } from "../routes.js";
import { handleListTaskWorkspaces } from "./routes.js";
import type { WorkspaceLifecycleService } from "./types.js";

let base: string;

beforeEach(async (): Promise<void> => {
  base = await realpath(await mkdtemp(join(tmpdir(), "keiko-tw-denial-")));
});

afterEach(async (): Promise<void> => {
  resetServerLogger();
  await rm(base, { recursive: true, force: true });
});

describe("a task-workspace route that resolves a denied root", (): void => {
  it("records the denial on the workspace-root line under the request's correlation id", async (): Promise<void> => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "debug" }));
    const denied = join(base, ".ssh");
    await mkdir(denied);
    const deps = {
      store: createInMemoryUiStore(),
      redactor: buildRedactor({}),
      workspaceLifecycle: {
        listAll: () => [],
        list: () => [],
      } as unknown as WorkspaceLifecycleService,
    } as unknown as UiHandlerDeps;
    const ctx = {
      req: mockRequest({ method: "GET" }),
      url: new URL(`http://127.0.0.1/api/task-workspaces?root=${encodeURIComponent(denied)}`),
      correlationId: "corr-task-workspace-deny",
    } as unknown as RouteContext;

    await handleListTaskWorkspaces(ctx, deps).catch(() => undefined);

    const lines = sink.events.filter((event) => event.op === "workspace.root.denied");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      correlationId: "corr-task-workspace-deny",
      extra: { reason: "denied-locus" },
    });
  });
});
