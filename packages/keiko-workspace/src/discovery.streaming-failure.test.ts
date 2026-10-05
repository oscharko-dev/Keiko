import { describe, expect, it } from "vitest";
import { memFs } from "./_memfs.js";
import { visitWorkspaceFiles } from "./discovery.js";
import { PathDeniedError, WorkspaceReadError } from "./errors.js";
import type { WorkspaceDirEntry, WorkspaceFs } from "./fs.js";
import { createStructuralExecutionControl } from "./structuralExecution.js";
import type { WorkspaceInfo } from "./types.js";

const WORKSPACE: WorkspaceInfo = {
  root: "/ws",
  selectedRoot: "/ws",
  name: "fixture",
  version: undefined,
  testFramework: "unknown",
  sourceDirs: [],
  testDirs: [],
  languages: [],
  ignoreLines: [],
};

function streamingFs(): WorkspaceFs {
  const base = memFs(WORKSPACE.root, { "src/deep/target.ts": "export const target = 1;" });
  return {
    ...base,
    iterateDirectory: async function* (path): AsyncIterable<WorkspaceDirEntry> {
      for (const entry of base.readDir(path)) yield await Promise.resolve(entry);
    },
  };
}

describe("streaming discovery failure ownership", () => {
  it.each([
    new TypeError("private scoring message"),
    new PathDeniedError("private policy message", "src/deep/target.ts"),
  ])(
    "preserves the exact collector failure instead of relabelling the containing directory (%s)",
    async (failure) => {
      const visited: string[] = [];
      await expect(
        visitWorkspaceFiles(
          WORKSPACE,
          [],
          false,
          streamingFs(),
          createStructuralExecutionControl(null),
          (file) => {
            visited.push(file.relativePath);
            return Promise.reject(failure);
          },
        ),
      ).rejects.toBe(failure);
      expect(visited).toEqual(["src/deep/target.ts"]);
    },
  );

  it("retains the original IO cause while keeping a translated directory message body-free", async () => {
    const failure = Object.assign(new Error("PRIVATE_DIRECTORY_MESSAGE"), { code: "EACCES" });
    const fs: WorkspaceFs = {
      ...streamingFs(),
      iterateDirectory: async function* () {
        yield* [];
        await Promise.reject(failure);
      },
    };
    const result = visitWorkspaceFiles(
      WORKSPACE,
      [],
      false,
      fs,
      createStructuralExecutionControl(null),
      () => Promise.resolve(),
    );
    await expect(result).rejects.toBeInstanceOf(WorkspaceReadError);
    await expect(result).rejects.toMatchObject({ requestedPath: "", cause: failure });
    await expect(result).rejects.not.toHaveProperty(
      "message",
      expect.stringContaining("PRIVATE_DIRECTORY_MESSAGE"),
    );
  });
});
