import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function request(
  cwd: string,
  operation: "link" | "unlink",
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
  return target === undefined ? common : { ...common, target };
}

function runtimeIo(
  overrides: Partial<SafeArtifactDirectoryMutationIo> = {},
): SafeArtifactDirectoryMutationIo {
  return {
    directoryMatches: () => true,
    link: () => undefined,
    rename: () => undefined,
    unlink: () => undefined,
    ...overrides,
  };
}

function runtimeRequest(
  operation: "link" | "unlink",
  source = "source",
  target?: string,
): SafeArtifactDirectoryMutationRequest {
  const common = { operation, expectedDev: "1", expectedIno: "2", source };
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

  it("links and unlinks only validated basenames in the attested current directory", () => {
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
  ])("rejects an invalid request without touching the directory", (value) => {
    const directoryMatches = vi.fn(() => true);
    expect(runSafeArtifactDirectoryMutation(value, runtimeIo({ directoryMatches }))).toBe(
      SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.invalidInput,
    );
    expect(directoryMatches).not.toHaveBeenCalled();
  });

  it("executes validated link and unlink requests and rechecks the directory identity", () => {
    const link = vi.fn();
    const unlink = vi.fn();
    const directoryMatches = vi.fn(() => true);
    const io = runtimeIo({ directoryMatches, link, unlink });

    expect(runSafeArtifactDirectoryMutation(runtimeRequest("link", "source", "target"), io)).toBe(
      SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success,
    );
    expect(runSafeArtifactDirectoryMutation(runtimeRequest("unlink"), io)).toBe(
      SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT.success,
    );
    expect(link).toHaveBeenCalledWith("source", "target");
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
