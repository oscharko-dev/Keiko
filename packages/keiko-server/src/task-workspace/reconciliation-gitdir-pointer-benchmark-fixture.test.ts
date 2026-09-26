import { describe, expect, it } from "vitest";
import { parseGitdirPointerTarget } from "./gitdir-identity.js";
import {
  BENCHMARK_GITDIR_TARGET,
  benchmarkGitdirPointer,
} from "./reconciliation-gitdir-pointer-benchmark-fixture.js";

describe("gitdir pointer benchmark fixture", () => {
  it("extracts the exact target under the benchmark padding", () => {
    expect(parseGitdirPointerTarget(benchmarkGitdirPointer(2_500, 2_500))).toBe(
      BENCHMARK_GITDIR_TARGET,
    );
  });
});
