import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloneRepositoryHandler } from "./gitRepositoryRoutes.js";
import type { RouteContext } from "./routes.js";
import { createRunRegistry, type UiHandlerDeps } from "./index.js";
import { createInMemoryUiStore, type UiStore } from "./store/index.js";

let tmp: string;
let store: UiStore;

function deps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: (value: unknown) => value,
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
  };
}

function ctx(body: unknown): RouteContext {
  return {
    req: Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage,
    res: {} as ServerResponse,
    params: {},
    url: new URL("http://127.0.0.1/api/repositories/clone"),
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "keiko-repo-route-"));
  store = createInMemoryUiStore();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("git repository routes", () => {
  it("clones a repository into a destination folder and registers it", async () => {
    const destination = join(tmp, "app");
    const cloneRunner = vi.fn((_repositoryUrl: string, destinationPath: string) => {
      mkdirSync(destinationPath);
      return Promise.resolve(null);
    });
    const handler = createCloneRepositoryHandler(cloneRunner);

    const result = await handler(
      ctx({
        repositoryUrl: "https://github.com/acme/app.git",
        destinationPath: destination,
        name: "Customer App",
      }),
      deps(),
    );

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      project: { path: destination, name: "Customer App", available: true },
    });
    expect(cloneRunner).toHaveBeenCalledWith("https://github.com/acme/app.git", destination);
    expect(store.listProjects()).toContainEqual(
      expect.objectContaining({ path: destination, name: "Customer App" }),
    );
  });

  it("rejects repository URLs that embed credentials", async () => {
    const cloneRunner = vi.fn(() => Promise.resolve(null));
    const handler = createCloneRepositoryHandler(cloneRunner);

    const result = await handler(
      ctx({
        repositoryUrl: "https://token@example.test/acme/app.git",
        destinationPath: join(tmp, "app"),
      }),
      deps(),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(cloneRunner).not.toHaveBeenCalled();
  });

  it("rejects an already existing destination before invoking git", async () => {
    const destination = join(tmp, "app");
    mkdirSync(destination);
    const cloneRunner = vi.fn(() => Promise.resolve(null));
    const handler = createCloneRepositoryHandler(cloneRunner);

    const result = await handler(
      ctx({
        repositoryUrl: "git@example.test:acme/app.git",
        destinationPath: destination,
      }),
      deps(),
    );

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(cloneRunner).not.toHaveBeenCalled();
  });
});
