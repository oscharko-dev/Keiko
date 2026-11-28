import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { buildRedactor } from "./index.js";
import { readConnectedFileBytes, resolveRoot } from "./files.js";
import { pathDeniedAsyncRecorded } from "./files-deny.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { createInMemoryUiStore } from "./index.js";

let base: string;

beforeEach(async (): Promise<void> => {
  base = await realpath(await mkdtemp(join(tmpdir(), "keiko-deny-async-")));
});

afterEach(async (): Promise<void> => {
  resetServerLogger();
  await rm(base, { recursive: true, force: true });
});

function capture(): ReturnType<typeof createBufferedServerLogSink> {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  return sink;
}

describe("asynchronous path denials are recorded", (): void => {
  it("a denied Files root answers 403 and leaves the body-free denial line with the correlation id", async (): Promise<void> => {
    const sink = capture();
    const denied = join(base, ".ssh");
    await mkdir(denied);

    await expect(
      resolveRoot(createInMemoryUiStore(), denied, buildRedactor({}), "corr-async-deny"),
    ).rejects.toMatchObject({ status: 403 });

    const lines = sink.events.filter((event) => event.op === "workspace.root.denied");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      category: "security",
      correlationId: "corr-async-deny",
      errorKind: "authority-denied",
      extra: { decision: "denied", reason: "denied-locus", failureKind: "DENIED" },
    });
    expect(JSON.stringify(lines)).not.toContain(base);
  });

  it("a connected-file read of a denied root records the denial under the request's correlation id", async (): Promise<void> => {
    const sink = capture();
    const denied = join(base, ".ssh");
    await mkdir(denied);
    const deps = { store: createInMemoryUiStore(), redactor: buildRedactor({}) };

    await expect(
      readConnectedFileBytes(deps, denied, "id_rsa", 1024, "corr-connected-deny"),
    ).rejects.toMatchObject({ status: 403 });

    const lines = sink.events.filter((event) => event.op === "workspace.root.denied");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ correlationId: "corr-connected-deny" });
  });

  it("an allowed path writes no denial line", async (): Promise<void> => {
    const sink = capture();
    await expect(pathDeniedAsyncRecorded(base, "corr-ok")).resolves.toBe(false);
    expect(sink.events.filter((event) => event.op === "workspace.root.denied")).toHaveLength(0);
  });
});
