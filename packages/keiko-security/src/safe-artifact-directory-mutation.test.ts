import { afterEach, describe, expect, it } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAFE_ARTIFACT_DIRECTORY_MUTATION_EXIT,
  type SafeArtifactDirectoryMutationRequest,
} from "./safe-artifact-directory-mutation-protocol.js";

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

function runHelper(cwd: string, input: string): SpawnSyncReturns<null> {
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
