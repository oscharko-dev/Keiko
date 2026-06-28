import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  type UiHandlerDeps,
} from "../index.js";
import type { RouteContext } from "../routes.js";
import type { UiStore } from "../store/index.js";
import { handleRuntimeCapabilities } from "./capabilityRoutes.js";
import { type HostExecutableProbe, type HostExecutableProbeResult } from "./capabilityDetector.js";

let root: string;
let store: UiStore;

class EmptyProbe implements HostExecutableProbe {
  public probe(): HostExecutableProbeResult {
    return { state: "missing" as const, unavailableReason: "executable-not-found" as const };
  }
}

function deps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
  };
}

function ctx(path: string): RouteContext {
  return {
    req: Readable.from([]) as unknown as IncomingMessage,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL(`http://localhost${path}`),
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "keiko-runtime-route-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ packageManager: "npm@10.9.8", scripts: { test: "node should-not-run.js" } }),
    "utf8",
  );
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("GET /api/runtime/capabilities", () => {
  it("returns host capabilities without a root and no absolute workspace path", async () => {
    const result = await handleRuntimeCapabilities(ctx("/api/runtime/capabilities"), deps(), {
      probe: new EmptyProbe(),
      now: () => 0,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ schemaVersion: "1" });
    expect(JSON.stringify(result.body)).not.toContain(root);
  });

  it("returns registered-root command sources with relative paths only", async () => {
    const result = await handleRuntimeCapabilities(
      ctx(`/api/runtime/capabilities?root=${encodeURIComponent(root)}`),
      deps(),
      { probe: new EmptyProbe(), specs: [], now: () => 0 },
    );

    expect(result.status).toBe(200);
    const serialized = JSON.stringify(result.body);
    expect(serialized).toContain('"path":"package.json"');
    expect(serialized).toContain('"scriptName":"test"');
    expect(serialized).not.toContain("should-not-run");
    expect(serialized).not.toContain(root);
  });

  it("rejects unregistered roots through the existing files route error envelope", async () => {
    const other = await mkdtemp(join(tmpdir(), "keiko-runtime-route-other-"));
    try {
      const result = await handleRuntimeCapabilities(
        ctx(`/api/runtime/capabilities?root=${encodeURIComponent(other)}`),
        deps(),
        { probe: new EmptyProbe(), specs: [], now: () => 0 },
      );

      expect(result.status).toBe(403);
      expect(result.body).toMatchObject({ error: { code: "WORKSPACE_NOT_REGISTERED" } });
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
