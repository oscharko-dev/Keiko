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

describe("workspace state persistence", () => {
  it("persists a versioned envelope and reloads it after in-memory reset", async () => {
    const dataDir = tempDir();
    process.env.KEIKO_UI_DATA_DIR = dataDir;
    const body = {
      windows: [
        { id: "files-1", type: "files", x: 1, y: 2, w: 3, h: 4, z: 5, cfg: {}, max: false },
      ],
      connections: [],
    };

    const put = await handlePutWorkspaceState(
      context("PUT", body, { "if-match": '"workspace-state-0"' }),
    );
    expect(put.status).toBe(200);
    const stored = JSON.parse(readFileSync(join(dataDir, "workspace-state.json"), "utf8")) as {
      schemaVersion: number;
      workspace: { revision: number; windows: unknown[] };
    };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.workspace.revision).toBe(1);

    resetWorkspaceStateForTests();
    const get = handleGetWorkspaceState(context("GET"));

    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ workspace: { revision: 1 } });
  });

  it("quarantines a corrupt persisted envelope and starts from revision zero", () => {
    const dataDir = tempDir();
    process.env.KEIKO_UI_DATA_DIR = dataDir;
    writeFileSync(join(dataDir, "workspace-state.json"), "{not valid json", "utf8");

    const get = handleGetWorkspaceState(context("GET"));

    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ workspace: { revision: 0, windows: [], connections: [] } });
    const siblings = readdirSync(dataDir);
    expect(siblings.some((name) => name.startsWith("workspace-state.json.corrupt."))).toBe(true);
    expect(
      siblings.some((name) => /^workspace-state\.json\.corrupt\..*\.diagnostic\.json$/u.test(name)),
    ).toBe(true);
  });
});
