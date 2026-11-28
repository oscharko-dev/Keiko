import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UiHandlerDeps } from "./deps.js";
import { resolveRoot } from "./files.js";
import { buildRedactor, createInMemoryUiStore } from "./index.js";
import {
  handleNativeFileDialogOpen,
  type NativeFileDialogRouteOptions,
} from "./native-file-dialog/route.js";
import type { RouteContext } from "./routes.js";
import { projectReadable, projectsWithWorkspaceAvailability } from "./workspace-root-membership.js";

// Every canonical-path check on these asynchronous paths must stay off the event loop: the blocking
// realpath is replaced by one that fails when reached, and which the old synchronous predicate read
// as an unresolvable name and refused, so an ordinary folder would have been denied.
const armed = vi.hoisted(() => ({ on: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // Armed by a test only around the call under test: fixture setup uses the real one.
  const blocked = (): never => {
    throw new Error("synchronous realpath reached the event loop");
  };
  const guarded = Object.assign(
    (path: string, ...rest: [] | [never]) =>
      armed.on ? blocked() : actual.realpathSync(path, ...rest),
    {
      native: (path: string, ...rest: [] | [never]) =>
        armed.on ? blocked() : actual.realpathSync.native(path, ...rest),
    },
  );
  return { ...actual, realpathSync: guarded };
});

const dirs: string[] = [];

afterEach(async () => {
  armed.on = false;
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "keiko-async-containment-")));
  dirs.push(dir);
  return dir;
}

function context(body: unknown): RouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body), "utf8"),
  ]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    req,
    res: new EventEmitter() as unknown as ServerResponse,
    params: {},
    url: new URL("http://localhost/api/native-file-dialog/open"),
    correlationId: "async-containment-corr",
  };
}

function dialogDeps(options: NativeFileDialogRouteOptions): UiHandlerDeps {
  return {
    store: createInMemoryUiStore(),
    redactor: buildRedactor({}),
    diagnostics: { record: (): void => undefined },
    activityLog: { write: (): void => undefined },
    nativeFileDialog: options,
  } as unknown as UiHandlerDeps;
}

describe("Files root selection", () => {
  it("resolves an arbitrary root without a blocking realpath", async () => {
    const root = await tempDir();
    const store = createInMemoryUiStore();
    armed.on = true;
    const resolved = await resolveRoot(store, root, buildRedactor({}));
    expect(resolved.realRoot).toBe(root);
  });

  it("resolves a registered project root without a blocking realpath", async () => {
    const root = await tempDir();
    const store = createInMemoryUiStore();
    store.createProject(root, "ordinary");
    armed.on = true;
    const resolved = await resolveRoot(store, root, buildRedactor({}));
    expect(resolved.realRoot).toBe(root);
  });

  it("still refuses a deny-listed root", async () => {
    const root = await tempDir();
    armed.on = true;
    await expect(
      resolveRoot(createInMemoryUiStore(), join(root, ".ssh"), buildRedactor({})),
    ).rejects.toMatchObject({ code: "DENIED" });
  });
});

describe("the project listing", () => {
  it("marks an ordinary project readable without a blocking realpath", async () => {
    const root = await tempDir();
    const store = createInMemoryUiStore();
    const project = store.createProject(root, "ordinary");
    armed.on = true;
    await expect(projectReadable(project)).resolves.toBe(true);
    const listed = await projectsWithWorkspaceAvailability(store, store.listProjects());
    expect(listed).toEqual([expect.objectContaining({ path: root, readable: true })]);
  });

  it("lists a deny-listed folder unreadable", async () => {
    const store = createInMemoryUiStore();
    const project = store.createProject(await tempDir(), "ordinary");
    armed.on = true;
    await expect(projectReadable({ ...project, path: "/home/me/.config/repo" })).resolves.toBe(
      false,
    );
  });
});

describe("the native file dialog", () => {
  it("accepts a folder and a file selection without a blocking realpath", async () => {
    const root = await tempDir();
    const file = join(root, "alpha.txt");
    await writeFile(file, "a");
    armed.on = true;
    const folder = await handleNativeFileDialogOpen(
      context({ mode: "open-directory" }),
      dialogDeps({ adapter: adapterReturning([root]) }),
    );
    expect(folder.status).toBe(200);
    expect(folder.body).toMatchObject({ selections: [{ path: root, kind: "directory" }] });
    const picked = await handleNativeFileDialogOpen(
      context({ mode: "open-files" }),
      dialogDeps({ adapter: adapterReturning([file]) }),
    );
    expect(picked.body).toMatchObject({ selections: [{ path: file, kind: "file" }] });
  });
});

function adapterReturning(paths: readonly string[]): NativeFileDialogRouteOptions["adapter"] {
  return {
    open: () => Promise.resolve({ cancelled: false, paths }),
    cancel: (): void => undefined,
  };
}
