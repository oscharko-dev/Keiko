import type { IncomingMessage, ServerResponse } from "node:http";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { RouteContext } from "./routes.js";
import {
  handleGetWorkspaceState,
  handlePutWorkspaceState,
  resetWorkspaceStateForTests,
} from "./workspace-state-handlers.js";

const REAL_TMPDIR = realpathSync(tmpdir());
const tmpDirs: string[] = [];
const ORIGINAL_DATA_DIR = process.env.KEIKO_UI_DATA_DIR;

function tempDir(): string {
  const dir = mkdtempSync(join(REAL_TMPDIR, "keiko-workspace-state-"));
  tmpDirs.push(dir);
  return dir;
}

function context(
  method: string,
  body: unknown = {},
  headers: Record<string, string> = {},
): RouteContext {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as IncomingMessage;
  Object.assign(req, { method, headers });
  return {
    correlationId: undefined,
    req,
    res: {} as ServerResponse,
    params: {},
    url: new URL("http://localhost/api/workspace/state"),
  };
}

afterEach(() => {
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.KEIKO_UI_DATA_DIR;
  } else {
    process.env.KEIKO_UI_DATA_DIR = ORIGINAL_DATA_DIR;
  }
  resetWorkspaceStateForTests();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("workspace state ownership", () => {
  it("keeps layout in memory even when the launcher supplies a UI data directory", async () => {
    const dataDir = tempDir();
    process.env.KEIKO_UI_DATA_DIR = dataDir;
    const deps = { env: { KEIKO_UI_DATA_DIR: dataDir } };
    const windows = [{ id: "files-1", type: "files", cfg: { root: "/workspace" } }];
    const put = await handlePutWorkspaceState(
      context("PUT", { windows, connections: [] }, { "if-match": '"workspace-state-0"' }),
      deps,
    );
    expect(put.status).toBe(200);
    expect(handleGetWorkspaceState(context("GET"), deps).body).toMatchObject({
      workspace: { revision: 1, windows },
    });
    expect(readdirSync(dataDir)).toEqual([]);
    resetWorkspaceStateForTests();
    expect(handleGetWorkspaceState(context("GET"), deps).body).toMatchObject({
      workspace: { revision: 0, windows: [], connections: [] },
    });
  });

  it("never reads or quarantines an unrelated disk layout", () => {
    const dataDir = tempDir();
    process.env.KEIKO_UI_DATA_DIR = dataDir;
    writeFileSync(join(dataDir, "workspace-state.json"), "{not valid json", "utf8");
    const get = handleGetWorkspaceState(context("GET"));
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ workspace: { revision: 0, windows: [], connections: [] } });
    expect(readdirSync(dataDir)).toEqual(["workspace-state.json"]);
    expect(readFileSync(join(dataDir, "workspace-state.json"), "utf8")).toBe("{not valid json");
  });
});
