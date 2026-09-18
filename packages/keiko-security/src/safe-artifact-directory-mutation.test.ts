import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT,
  type SafeArtifactDirectoryMutationRequest,
} from "./safe-artifact-directory-mutation-protocol.js";
import {
  runSafeArtifactDirectoryMutation,
  type SafeArtifactDirectoryMutationIo,
} from "./safe-artifact-directory-mutation-runtime.js";

const cleanups: string[] = [];
const helperPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../dist/safe-artifact-directory-mutation.js",
);

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

function freshDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "keiko-directory-mutation-"));
  cleanups.push(path);
  return path;
}

function runHelper(cwd: string, input: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [helperPath], {
    cwd,
    input,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 5_000,
    windowsHide: true,
  });
}

function entryIdentity(path: string): {
  readonly expectedEntryDev: string;
  readonly expectedEntryIno: string;
} {
  try {
    const stat = lstatSync(path, { bigint: true });
    return { expectedEntryDev: stat.dev.toString(), expectedEntryIno: stat.ino.toString() };
  } catch {
    return { expectedEntryDev: "0", expectedEntryIno: "0" };
  }
}

function request(
  cwd: string,
  operation: "link" | "rename" | "unlink",
  source: string,
  target?: string,
): SafeArtifactDirectoryMutationRequest {
  const stat = lstatSync(cwd, { bigint: true });
  const common = {
    operation,
    expectedDev: stat.dev.toString(),
    expectedIno: stat.ino.toString(),
    source,
  };
  if (operation === "unlink") return { ...common, ...entryIdentity(join(cwd, source)) };
  return target === undefined ? common : { ...common, target };
}

function runtimeIo(
  overrides: Partial<SafeArtifactDirectoryMutationIo> = {},
): SafeArtifactDirectoryMutationIo {
  return {
    directoryMatches: () => true,
    entryMatches: () => true,
    link: () => undefined,
    rename: () => undefined,
    unlink: () => undefined,
    ...overrides,
  };
}

function runtimeRequest(
  operation: "link" | "rename" | "unlink",
  source = "source",
  target?: string,
): SafeArtifactDirectoryMutationRequest {
  const common = { operation, expectedDev: "1", expectedIno: "2", source };
  if (operation === "unlink") return { ...common, expectedEntryDev: "3", expectedEntryIno: "4" };
  return target === undefined ? common : { ...common, target };
}

function mutationError(code?: unknown): Error {
  const error = new Error("mutation failed");
  if (code !== undefined) Object.assign(error, { code });
  return error;
}

describe("safe artifact directory mutation helper", () => {
  it("rejects malformed and path-shaped stdin without emitting output", () => {
    const cwd = freshDirectory();
    for (const input of ["{", JSON.stringify(request(cwd, "unlink", "../victim"))]) {
      const result = runHelper(cwd, input);
      expect(result.status).toBe(SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.invalidInput);
      expect(result.stdout).toBeNull();
      expect(result.stderr).toBeNull();
    }
  });

  it("rejects a mismatched current-directory identity before mutation", () => {
    const cwd = freshDirectory();
    const source = join(cwd, "source");
    writeFileSync(source, "preserved");
    const mismatched = {
      ...request(cwd, "unlink", "source"),
      expectedIno: (lstatSync(cwd, { bigint: true }).ino + 1n).toString(),
    };

    const result = runHelper(cwd, JSON.stringify(mismatched));
    expect(result.status).toBe(SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.directoryMismatch);
    expect(readFileSync(source, "utf8")).toBe("preserved");
  });

  it("links, renames, and unlinks only validated basenames in the attested current directory", () => {
    const cwd = freshDirectory();
    const source = join(cwd, "source");
    const target = join(cwd, "target");
    writeFileSync(source, "artifact");

    expect(runHelper(cwd, JSON.stringify(request(cwd, "link", "source", "target"))).status).toBe(
      SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success,
    );
    expect(readFileSync(target, "utf8")).toBe("artifact");
    expect(lstatSync(source).nlink).toBe(2);
    expect(runHelper(cwd, JSON.stringify(request(cwd, "unlink", "target"))).status).toBe(
      SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success,
    );
    expect(lstatSync(source).nlink).toBe(1);
    expect(readFileSync(source, "utf8")).toBe("artifact");
    expect(runHelper(cwd, JSON.stringify(request(cwd, "rename", "source", "target"))).status).toBe(
      SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success,
    );
    expect(readFileSync(target, "utf8")).toBe("artifact");
  });

  it("refuses to unlink a name that was replaced after the caller verified it", () => {
    const cwd = freshDirectory();
    const entry = join(cwd, "server.log");
    writeFileSync(entry, "verified");
    // Callers hold the verified inode open until the helper returns. Without a holder, Linux gives
    // the freed inode number straight to the replacement and no identity can tell the files apart.
    const held = openSync(entry, "r");
    try {
      const verified = request(cwd, "unlink", "server.log");
      unlinkSync(entry);
      writeFileSync(entry, "recreated by a concurrent writer");

      expect(runHelper(cwd, JSON.stringify(verified)).status).toBe(
        SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.entryMismatch,
      );
      expect(readFileSync(entry, "utf8")).toBe("recreated by a concurrent writer");
    } finally {
      closeSync(held);
    }
  });
});

describe("safe artifact directory mutation runtime", () => {
  it.each([
    undefined,
    null,
    [],
    {},
    { ...runtimeRequest("unlink"), operation: 1 },
    { ...runtimeRequest("unlink"), operation: "copy" },
    { ...runtimeRequest("unlink"), expectedDev: 1 },
    { ...runtimeRequest("unlink"), expectedDev: "01" },
    { ...runtimeRequest("unlink"), expectedIno: "-1" },
    runtimeRequest("unlink", ""),
    runtimeRequest("unlink", "."),
    runtimeRequest("unlink", ".."),
    runtimeRequest("unlink", "a\0b"),
    runtimeRequest("unlink", "../source"),
    runtimeRequest("link", "source"),
    runtimeRequest("link", "source", "../target"),
    { ...runtimeRequest("unlink"), target: "target" },
    { operation: "unlink", expectedDev: "1", expectedIno: "2", source: "source" },
    { ...runtimeRequest("unlink"), expectedEntryDev: "01" },
    { ...runtimeRequest("unlink"), expectedEntryIno: 4 },
    { ...runtimeRequest("link", "source", "target"), expectedEntryDev: "3" },
  ])("rejects an invalid request without touching the directory", (value) => {
    const directoryMatches = vi.fn(() => true);
    expect(runSafeArtifactDirectoryMutation(value, runtimeIo({ directoryMatches }))).toBe(
      SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.invalidInput,
    );
    expect(directoryMatches).not.toHaveBeenCalled();
  });

  it("executes validated link, rename, and unlink requests and rechecks directory identity", () => {
    const link = vi.fn();
    const rename = vi.fn();
    const unlink = vi.fn();
    const directoryMatches = vi.fn(() => true);
    const io = runtimeIo({ directoryMatches, link, rename, unlink });

    expect(runSafeArtifactDirectoryMutation(runtimeRequest("link", "source", "target"), io)).toBe(
      SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success,
    );
    expect(runSafeArtifactDirectoryMutation(runtimeRequest("unlink"), io)).toBe(
      SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success,
    );
    expect(runSafeArtifactDirectoryMutation(runtimeRequest("rename", "source", "target"), io)).toBe(
      SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success,
    );
    expect(link).toHaveBeenCalledWith("source", "target");
    expect(rename).toHaveBeenCalledWith("source", "target");
    expect(unlink).toHaveBeenCalledWith("source");
    expect(directoryMatches).toHaveBeenCalledWith(1n, 2n);
  });

  it("refuses an initial mismatch and reports a post-mutation directory replacement", () => {
    expect(
      runSafeArtifactDirectoryMutation(
        runtimeRequest("unlink"),
        runtimeIo({ directoryMatches: () => false }),
      ),
    ).toBe(SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.directoryMismatch);
    const directoryMatches = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(
      runSafeArtifactDirectoryMutation(
        runtimeRequest("link", "source", "target"),
        runtimeIo({ directoryMatches }),
      ),
    ).toBe(SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.directoryMismatch);
  });

  it("refuses an unlink whose entry no longer has the verified identity", () => {
    const unlink = vi.fn();
    const entryMatches = vi.fn(() => false);

    expect(
      runSafeArtifactDirectoryMutation(
        runtimeRequest("unlink"),
        runtimeIo({ entryMatches, unlink }),
      ),
    ).toBe(SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.entryMismatch);
    expect(entryMatches).toHaveBeenCalledWith("source", 3n, 4n);
    expect(unlink).not.toHaveBeenCalled();
  });

  it.each([
    ["link", mutationError("EEXIST"), SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.targetExists],
    ["link", mutationError("EPERM"), SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.unsupported],
    ["link", mutationError(1), SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.failed],
    ["link", mutationError(), SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.failed],
    ["unlink", mutationError("EEXIST"), SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.failed],
  ] as const)("maps a %s mutation failure to a closed exit code", (operation, error, exitCode) => {
    const fail = (): never => {
      throw error;
    };
    const io = runtimeIo({ link: fail, unlink: fail });
    const value =
      operation === "link"
        ? runtimeRequest(operation, "source", "target")
        : runtimeRequest(operation);
    expect(runSafeArtifactDirectoryMutation(value, io)).toBe(exitCode);
  });
});
