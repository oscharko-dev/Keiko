import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRedactor, createInMemoryUiStore } from "../../index.js";
import {
  createFakeSessionPairingPort,
  fakePairingRequestBody,
} from "../../coding-app-session/_support.js";
import { createCodingAppSessionChannel } from "../../coding-app-session/sessionChannel.js";
import { APP_SESSION_COOKIE_NAME } from "../../coding-app-session/sessionCookie.js";
import { createSessionRegistry } from "../../coding-app-session/sessionRegistry.js";
import type { UiHandlerDeps } from "../../deps.js";
import { API_ROUTES, type RouteContext } from "../../routes.js";
import type { UiStore } from "../../store/index.js";
import {
  captureEditorLocalHistorySafely,
  resolveEditorLocalHistoryRoot,
} from "./localHistoryCapture.js";
import {
  createEditorLocalHistoryStore,
  type EditorLocalHistoryStore,
} from "./localHistoryStore.js";
import {
  handleDeleteEditorLocalHistory,
  handleListEditorLocalHistory,
  handlePinEditorLocalHistory,
  handleReadEditorLocalHistory,
} from "./localHistoryRoutes.js";

const VAULT_KEY = Buffer.alloc(32, 0x29).toString("base64");
let root: string;
let stateDir: string;
let outside: string;
let store: UiStore;
let history: EditorLocalHistoryStore;
let deps: UiHandlerDeps;
let sessionCookie: string;

function context(
  method: string,
  path: string,
  params: Record<string, string> = {},
  body?: unknown,
  withSession = true,
): RouteContext {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  const req = Readable.from(chunks) as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  req.headers = withSession ? { cookie: sessionCookie } : {};
  return {
    req,
    res: {} as unknown as ServerResponse,
    params,
    url: new URL(path, "http://localhost"),
  };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keiko-history-route-root-")));
  stateDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keiko-history-route-state-")));
  outside = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "keiko-history-route-out-")));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.ts"), "checkpoint marker\n", "utf8");
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
  history = createEditorLocalHistoryStore({
    stateDir,
    env: { KEIKO_EDITOR_LOCAL_HISTORY_KEY: VAULT_KEY },
  });
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
  });
  const paired = channel.pair(fakePairingRequestBody());
  if (!paired.paired) throw new Error("local-history route pairing failed");
  sessionCookie = `${APP_SESSION_COOKIE_NAME}=${paired.cookieToken}`;
  deps = {
    store,
    redactor: buildRedactor({}),
    editorLocalHistoryStore: history,
    codingAppSessionChannel: channel,
  } as unknown as UiHandlerDeps;
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function capture(): string {
  const nowMs = Date.now();
  captureEditorLocalHistorySafely({
    deps,
    realRoot: root,
    relativePath: "src/app.ts",
    absolutePath: join(root, "src", "app.ts"),
    content: "checkpoint marker\n",
    origin: "user-save",
    nowMs,
  });
  const identity = resolveEditorLocalHistoryRoot(deps, root);
  return history.list(identity, "src/app.ts", nowMs + 1)[0]?.entryRef ?? "missing";
}

describe("editor local-history routes", () => {
  it("registers the list, read, pin, and delete route contract", () => {
    const routes = API_ROUTES.filter((route) =>
      route.pattern.startsWith("/api/editor/local-history"),
    );
    expect(routes.map((route) => [route.method, route.pattern])).toEqual([
      ["GET", "/api/editor/local-history"],
      ["GET", "/api/editor/local-history/:entryRef"],
      ["PATCH", "/api/editor/local-history/:entryRef"],
      ["DELETE", "/api/editor/local-history/:entryRef"],
    ]);
  });

  it("lists, reads, pins, unpins, and deletes one authenticated file checkpoint", async () => {
    const entryRef = capture();
    const query = `?root=${encodeURIComponent(root)}&path=src/app.ts`;
    const listed = await handleListEditorLocalHistory(
      context("GET", `/api/editor/local-history${query}`),
      deps,
    );
    expect(listed).toMatchObject({ status: 200, body: { entries: [{ entryRef }] } });

    const entryQuery = `?root=${encodeURIComponent(root)}`;
    const routeParams = { entryRef };
    const read = await handleReadEditorLocalHistory(
      context("GET", `/api/editor/local-history/${entryRef}${entryQuery}`, routeParams),
      deps,
    );
    expect(read).toMatchObject({
      status: 200,
      body: { entry: { entryRef, origin: "user-save" }, content: "checkpoint marker\n" },
    });

    const pinned = await handlePinEditorLocalHistory(
      context("PATCH", `/api/editor/local-history/${entryRef}${entryQuery}`, routeParams, {
        pinned: true,
      }),
      deps,
    );
    expect(pinned).toMatchObject({ status: 200, body: { entry: { pinned: true } } });

    const unpinned = await handlePinEditorLocalHistory(
      context("PATCH", `/api/editor/local-history/${entryRef}${entryQuery}`, routeParams, {
        pinned: false,
      }),
      deps,
    );
    expect(unpinned).toMatchObject({ status: 200, body: { entry: { pinned: false } } });

    const deleted = await handleDeleteEditorLocalHistory(
      context("DELETE", `/api/editor/local-history/${entryRef}${entryQuery}`, routeParams),
      deps,
    );
    expect(deleted).toEqual({ status: 200, body: { deleted: true } });
    const missing = await handleReadEditorLocalHistory(
      context("GET", `/api/editor/local-history/${entryRef}${entryQuery}`, routeParams),
      deps,
    );
    expect(missing).toMatchObject({ status: 404, body: { error: { code: "ENTRY_NOT_FOUND" } } });
  });

  it("keeps a checkpoint readable, pinnable and deletable after its file is deleted", async () => {
    const entryRef = capture();
    rmSync(join(root, "src", "app.ts"));
    const query = `?root=${encodeURIComponent(root)}`;
    const routeParams = { entryRef };

    const listed = await handleListEditorLocalHistory(
      context("GET", `/api/editor/local-history${query}&path=src/app.ts`),
      deps,
    );
    const read = await handleReadEditorLocalHistory(
      context("GET", `/api/editor/local-history/${entryRef}${query}`, routeParams),
      deps,
    );
    const pinned = await handlePinEditorLocalHistory(
      context("PATCH", `/api/editor/local-history/${entryRef}${query}`, routeParams, {
        pinned: true,
      }),
      deps,
    );
    const deleted = await handleDeleteEditorLocalHistory(
      context("DELETE", `/api/editor/local-history/${entryRef}${query}`, routeParams),
      deps,
    );

    expect(listed).toMatchObject({ status: 200, body: { entries: [{ entryRef }] } });
    expect(read).toMatchObject({ status: 200, body: { content: "checkpoint marker\n" } });
    expect(pinned).toMatchObject({ status: 200, body: { entry: { pinned: true } } });
    expect(deleted).toEqual({ status: 200, body: { deleted: true } });
  });

  it("keeps a checkpoint readable after its file is renamed away", async () => {
    const entryRef = capture();
    renameSync(join(root, "src", "app.ts"), join(root, "src", "renamed.ts"));

    const read = await handleReadEditorLocalHistory(
      context("GET", `/api/editor/local-history/${entryRef}?root=${encodeURIComponent(root)}`, {
        entryRef,
      }),
      deps,
    );

    expect(read).toMatchObject({
      status: 200,
      body: { entry: { relativePath: "src/app.ts" }, content: "checkpoint marker\n" },
    });
  });

  it("still refuses escaping and denied history paths that do not exist", async () => {
    capture();
    const query = `?root=${encodeURIComponent(root)}`;

    const escaping = await handleListEditorLocalHistory(
      context(
        "GET",
        `/api/editor/local-history${query}&path=${encodeURIComponent("../escape.ts")}`,
      ),
      deps,
    );
    const denied = await handleListEditorLocalHistory(
      context("GET", `/api/editor/local-history${query}&path=${encodeURIComponent(".ssh/id_rsa")}`),
      deps,
    );
    const rootItself = await handleListEditorLocalHistory(
      context("GET", `/api/editor/local-history${query}&path=`),
      deps,
    );

    expect(escaping).toMatchObject({ status: 400, body: { error: { code: "PATH_ESCAPE" } } });
    expect(denied).toMatchObject({ status: 403, body: { error: { code: "DENIED" } } });
    expect(rootItself).toMatchObject({ status: 400, body: { error: { code: "BAD_PATH" } } });
  });

  it("refuses a stored path that now resolves outside the root through a symlink", async () => {
    const entryRef = capture();
    writeFileSync(join(outside, "secret.txt"), "outside marker\n", "utf8");
    rmSync(join(root, "src", "app.ts"));
    symlinkSync(join(outside, "secret.txt"), join(root, "src", "app.ts"));

    const read = await handleReadEditorLocalHistory(
      context("GET", `/api/editor/local-history/${entryRef}?root=${encodeURIComponent(root)}`, {
        entryRef,
      }),
      deps,
    );

    expect(read).toMatchObject({ status: 403, body: { error: { code: "PATH_ESCAPE" } } });
  });

  it("refuses a stored path whose directory leaves the root even with the leaf gone", async () => {
    // The escape hides one level up. realpath fails on the missing leaf, so a guard that only ever
    // resolves the full path skips containment entirely and accepts a path sitting under a
    // directory symlinked out of the root.
    const entryRef = capture();
    rmSync(join(root, "src"), { recursive: true });
    symlinkSync(outside, join(root, "src"));

    const read = await handleReadEditorLocalHistory(
      context("GET", `/api/editor/local-history/${entryRef}?root=${encodeURIComponent(root)}`, {
        entryRef,
      }),
      deps,
    );

    expect(read).toMatchObject({ status: 403, body: { error: { code: "PATH_ESCAPE" } } });
  });

  it("refuses a stored path whose containment cannot be verified at all", async () => {
    // realpath failing is not the same as the path being absent. An unsearchable ancestor answers
    // EACCES, and a guard that reads every failure as "missing" walks past the root and accepts a
    // path it never actually checked. Absence of proof is not proof of containment.
    const entryRef = capture();
    // A symlink cycle answers ELOOP for every user, root included — unlike a permission trigger,
    // which a root-running container would simply walk through.
    rmSync(join(root, "src", "app.ts"));
    symlinkSync(join(root, "src", "loop.ts"), join(root, "src", "app.ts"));
    symlinkSync(join(root, "src", "app.ts"), join(root, "src", "loop.ts"));

    const read = await handleReadEditorLocalHistory(
      context("GET", `/api/editor/local-history/${entryRef}?root=${encodeURIComponent(root)}`, {
        entryRef,
      }),
      deps,
    );

    expect(read).toMatchObject({ status: 403, body: { error: { code: "DENIED" } } });
  });

  it("refuses a stored path that now resolves onto a denied location inside the root", async () => {
    const entryRef = capture();
    mkdirSync(join(root, ".ssh"));
    writeFileSync(join(root, ".ssh", "id_rsa"), "private key\n", "utf8");
    rmSync(join(root, "src", "app.ts"));
    symlinkSync(join(root, ".ssh", "id_rsa"), join(root, "src", "app.ts"));

    const read = await handleReadEditorLocalHistory(
      context("GET", `/api/editor/local-history/${entryRef}?root=${encodeURIComponent(root)}`, {
        entryRef,
      }),
      deps,
    );

    expect(read).toMatchObject({ status: 403, body: { error: { code: "DENIED" } } });
    expect(JSON.stringify(read.body)).not.toContain("private key");
  });

  it("keeps route failures content-free", async () => {
    const entryRef = capture();
    const result = await handlePinEditorLocalHistory(
      context(
        "PATCH",
        `/api/editor/local-history/${entryRef}?root=${encodeURIComponent(root)}`,
        { entryRef },
        { pinned: "checkpoint marker" },
      ),
      deps,
    );

    expect(result).toMatchObject({ status: 400, body: { error: { code: "BAD_REQUEST" } } });
    expect(JSON.stringify(result.body)).not.toContain("checkpoint marker");
  });

  it("returns content-free projections before any lookup without an app session", async () => {
    const entryRef = capture();
    const listed = await handleListEditorLocalHistory(
      context("GET", "/api/editor/local-history?root=/not-observable", {}, undefined, false),
      deps,
    );
    const read = await handleReadEditorLocalHistory(
      context(
        "GET",
        `/api/editor/local-history/${entryRef}?root=/not-observable`,
        { entryRef },
        undefined,
        false,
      ),
      deps,
    );
    const pin = await handlePinEditorLocalHistory(
      context(
        "PATCH",
        `/api/editor/local-history/${entryRef}?root=/not-observable`,
        { entryRef },
        undefined,
        false,
      ),
      deps,
    );
    const deleted = await handleDeleteEditorLocalHistory(
      context(
        "DELETE",
        `/api/editor/local-history/${entryRef}?root=/not-observable`,
        { entryRef },
        undefined,
        false,
      ),
      deps,
    );

    expect(listed).toEqual({ status: 200, body: { session: "unpaired", entries: [] } });
    expect(read).toMatchObject({ status: 404, body: { error: { code: "ENTRY_NOT_FOUND" } } });
    expect(pin).toEqual(read);
    expect(deleted).toEqual(read);
    expect(
      `${JSON.stringify(listed.body)}${JSON.stringify(read.body)}${JSON.stringify(pin.body)}${JSON.stringify(deleted.body)}`,
    ).not.toContain("checkpoint marker");
  });
});
