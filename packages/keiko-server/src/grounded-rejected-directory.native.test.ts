import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SelectedScope } from "@oscharko-dev/keiko-contracts/connected-context";
import {
  detectWorkspaceAt,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";

const NOW = 1_700_000_000_000;
const VISIBLE = "src/visible.ts";
const CASES = [
  { path: "src/ignored.ts", bytes: 54_928 },
  { path: "src/ignored-helper.ts", bytes: 50_900 },
] as const;
let root = "";

interface NativeRead {
  readonly path: string;
  readonly kind: string;
  readonly byteLimit: number | undefined;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-rejected-directory-")));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), CASES.map(({ path }) => path).join("\n") + "\n");
  writeFileSync(join(root, VISIBLE), "export const visibleValue = 211;\n");
  for (const item of CASES)
    writeFileSync(
      join(root, item.path),
      "export function hiddenFlow() { return 937; }\n".padEnd(item.bytes, " "),
    );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function watchedFs(reads: NativeRead[]): WorkspaceFs {
  const fs = { ...nodeWorkspaceFs };
  for (const key of [
    "readFileUtf8",
    "readFileUtf8SameDescriptor",
    "readFileUtf8WithinRootSameDescriptor",
    "readFileUtf8Prefix",
    "readFileBytes",
    "openFileReader",
  ] as const) {
    const port = fs[key];
    if (port === undefined) continue;
    Object.defineProperty(fs, key, {
      value: (...args: unknown[]): unknown => {
        reads.push({
          path: String(args[key === "readFileUtf8WithinRootSameDescriptor" ? 1 : 0]),
          kind: key,
          byteLimit: typeof args[1] === "number" ? args[1] : undefined,
        });
        return Reflect.apply(port, nodeWorkspaceFs, args);
      },
      enumerable: true,
    });
  }
  return fs;
}

async function retrieve(
  text: string,
  kind: SelectedScope["kind"],
  paths: readonly string[],
): Promise<{
  readonly result: Awaited<ReturnType<typeof retrieveConnectedContextPack>>;
  readonly reads: readonly NativeRead[];
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
  readonly workspace: WorkspaceInfo | undefined;
}> {
  const reads: NativeRead[] = [];
  const log = createBufferedServerLogSink();
  let workspace: WorkspaceInfo | undefined;
  const result = await retrieveConnectedContextPack(
    {
      workspaceRoot: root,
      scope: {
        schemaVersion: "1",
        scopeId: "native-rejected-directory",
        workspaceRoot: root,
        kind,
        relativePaths: paths,
        conversationId: "native-rejected-directory-chat",
        connectedAtMs: NOW,
        explicitConnection: true,
      },
      query: {
        kind: "natural-language",
        text,
        caseSensitive: false,
        maxResults: 100,
        emittedAtMs: NOW,
      },
    },
    {
      fs: watchedFs(reads),
      activityLog: log,
      correlationId: "native-rejected-directory-request",
      nowMs: (): number => NOW,
      detectWorkspace: (selectedRoot, fs): WorkspaceInfo => {
        workspace = detectWorkspaceAt(selectedRoot, fs, { scanSourceFilesForLanguages: false });
        return workspace;
      },
      answerer: { answer: (): Promise<string> => Promise.reject(new Error("retrieval-only")) },
    },
  );
  return { result, reads, log, workspace };
}

function rejected(result: Awaited<ReturnType<typeof retrieve>>, path: string): void {
  expect(result.workspace?.ignoreLines).toContain(path);
  expect(result.result.pack.files.map((file) => file.scopePath)).not.toContain(path);
  expect(
    result.log.events.find((event) => event.op === "search.connected-context.source-details")
      ?.extra,
  ).toMatchObject({
    explicitPathRejectedCount: 1,
    explicitPathRejectionReasons: ["ignored"],
  });
  expect(result.reads.filter((read) => read.path === join(root, path))).toEqual([]);
}

describe("native rejected-path eligibility after explicit admission", () => {
  it.each(CASES)("never reads rejected directory source $path ($bytes bytes)", async ({ path }) => {
    rejected(await retrieve(`Explain ${path}`, "directory", ["src"]), path);
  });
  it.each(CASES)("retains workspace-root no-read control for $path", async ({ path }) => {
    rejected(await retrieve(`Explain ${path}`, "workspace-root", []), path);
  });
  it.each(CASES)("retains human-selected Files exemption for $path", async ({ path }) => {
    const result = await retrieve(`Explain ${path}`, "files", [path]);
    expect(result.workspace?.ignoreLines).toContain(path);
    expect(result.result.pack.files.map((file) => file.scopePath)).toContain(path);
    expect(result.reads.some((read) => read.path === join(root, path))).toBe(true);
    expect(
      result.log.events.find((event) => event.op === "search.connected-context.source-details")
        ?.extra,
    ).toMatchObject({
      explicitPathAdmittedCount: 1,
      explicitPathRejectedCount: 0,
    });
  });
  it.each([true, false])(
    "retains the admitted sibling with rejected path first=%s",
    async (first) => {
      const path = CASES[0].path;
      const ordered = first ? [path, VISIBLE] : [VISIBLE, path];
      const result = await retrieve(`Explain ${ordered.join(" and ")}`, "directory", ["src"]);
      rejected(result, path);
      expect(result.result.pack.files.map((file) => file.scopePath)).toContain(VISIBLE);
      expect(result.reads.some((read) => read.path === join(root, VISIBLE))).toBe(true);
    },
  );
  it("never reads the rejected source through relationship helpers", async () => {
    const path = CASES[0].path;
    const result = await retrieve(`How does ${path} relate to ${VISIBLE}?`, "directory", ["src"]);
    rejected(result, path);
    expect(result.result.pack.files.map((file) => file.scopePath)).toContain(VISIBLE);
  });
  it("never reads the rejected source through basename admission", async () => {
    const path = CASES[0].path;
    rejected(await retrieve("Explain ignored.ts", "directory", ["src"]), path);
  });
  it("counts a basename match independently of an earlier full-path admission", async () => {
    const result = await retrieve(`Explain ${VISIBLE} and visible.ts`, "directory", ["src"]);
    expect(result.result.pack.files.map((file) => file.scopePath)).toContain(VISIBLE);
    expect(
      result.log.events.find((event) => event.op === "search.connected-context.source-details")
        ?.extra,
    ).toMatchObject({
      basenameDiscoveryTermCount: 1,
      basenameDiscoveryMatchCount: 1,
      explicitPathAdmittedCount: 1,
      explicitPathRejectedCount: 0,
    });
  });
  it("records an ignored ordinary HTML basename before later directory search", async () => {
    const path = "src/ignored.html";
    writeFileSync(join(root, path), "<html><body>hiddenFlow 937</body></html>\n");
    writeFileSync(join(root, ".gitignore"), `${path}\n`);
    const result = await retrieve("Explain ignored.html", "directory", ["src"]);
    rejected(result, path);
    expect(
      result.log.events.find((event) => event.op === "search.connected-context.source-details")
        ?.extra,
    ).toMatchObject({ basenameDiscoveryMatchCount: 0 });
  });
  it("does not count raw binary basename metadata as a classified match", async () => {
    const path = "src/binary.ts";
    writeFileSync(join(root, path), "\0".repeat(32));
    const result = await retrieve("Explain binary.ts", "directory", ["src"]);
    expect(result.result.pack.files.map((file) => file.scopePath)).not.toContain(path);
    expect(result.reads.some((read) => read.path === join(root, path))).toBe(true);
    expect(
      result.log.events.find((event) => event.op === "search.connected-context.source-details")
        ?.extra,
    ).toMatchObject({
      basenameDiscoveryMatchCount: 0,
      explicitPathAdmittedCount: 0,
      explicitPathRejectedCount: 1,
      explicitPathRejectionReasons: ["binary"],
    });
  });
  it.each(["probe*.ts", "probe?.ts"])(
    "keeps literal basename %s distinct from wildcard siblings before retention",
    async (basename) => {
      const path = `src/${basename}`;
      writeFileSync(join(root, path), "export const literalFact = 937;\n");
      for (let index = 0; index < 100; index += 1) {
        const directory = `src/decoy-${String(index).padStart(3, "0")}`;
        mkdirSync(join(root, directory));
        writeFileSync(join(root, directory, "probe0.ts"), "export const siblingFact = 211;\n");
      }
      const result = await retrieve(`Explain \`${basename}\``, "directory", ["src"]);
      expect(result.result.pack.files.map((file) => file.scopePath)).toContain(path);
      expect(
        result.log.events.find((event) => event.op === "search.connected-context.source-details")
          ?.extra,
      ).toMatchObject({
        basenameDiscoveryMatchCount: 1,
        explicitPathAdmittedCount: 1,
        explicitPathRejectedCount: 0,
      });
    },
  );
  it("never reads a rejected manifest through metadata helpers", async () => {
    const path = "src/package.json";
    writeFileSync(join(root, path), '{"name":"fixture","version":"1.0.0"}\n');
    writeFileSync(join(root, ".gitignore"), `${path}\n`);
    rejected(await retrieve(`Explain ${path}`, "directory", ["src"]), path);
  });
  it("preserves ordinary Directory reads without a query-path rejection", async () => {
    const result = await retrieve("Explain hiddenFlow", "directory", ["src"]);
    expect(result.result.pack.files.some((file) => file.scopePath === CASES[0].path)).toBe(true);
    expect(result.reads.some((read) => read.path === join(root, CASES[0].path))).toBe(true);
    expect(
      result.log.events.find((event) => event.op === "search.connected-context.source-details")
        ?.extra,
    ).toMatchObject({ explicitPathRejectedCount: 0 });
  });
});
