import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  recordNativeExternalRootsResolved,
  resolveNativeExternalReadRoots,
  type NativeExternalRootsInput,
} from "./opencodeNativeExternalRoots.js";
import { plantDirectoryRedirect, WINDOWS_HOST } from "../test-support/symlink-fixture.js";

const roots: string[] = [];

// The kernel read allowlist exists only for the macOS targets (productionOpenCodeBackend), so the
// root grammar below — `/`-separated depth, `../` containment — is reached on macOS alone. A Windows
// host runs the two platform-independent cases and states why it cannot run the rest (#4068).
const itWithKernelAllowlist = it.skipIf(WINDOWS_HOST);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A real directory layout: two accepted references, the run's own roots, a denied root and traps.
function layout(): Readonly<Record<string, string>> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-external-roots-")));
  roots.push(base);
  const paths = {
    docs: join(base, "reference", "docs"),
    specs: join(base, "reference", "specs"),
    workspace: join(base, "run", "workspace"),
    state: join(base, "run", "state"),
    denied: join(base, "denied"),
    file: join(base, "reference", "notes.txt"),
    link: join(base, "reference", "linked"),
  };
  for (const directory of [paths.docs, paths.specs, paths.workspace, paths.state, paths.denied])
    mkdirSync(directory, { recursive: true });
  writeFileSync(paths.file, "x");
  // A junction on Windows (no privilege needed), a directory symlink elsewhere (#4068).
  plantDirectoryRedirect(paths.docs, paths.link);
  return paths;
}

function input(
  paths: Readonly<Record<string, string>>,
  value: string | undefined,
): NativeExternalRootsInput {
  return {
    value,
    kernelAllowlist: true,
    workspaceRoot: paths.workspace ?? "",
    privateStateRoot: paths.state ?? "",
    deniedRoots: [paths.denied ?? ""],
  };
}

// #3900 AC5: only directories the operator explicitly accepted, read-only, all or none.
describe("accepted external read roots", () => {
  it("admits none when the operator named none", () => {
    const paths = layout();
    for (const value of [undefined, "", ` ${delimiter} `])
      expect(resolveNativeExternalReadRoots(input(paths, value))).toEqual({
        state: "absent",
        roots: [],
      });
  });

  itWithKernelAllowlist("admits existing link-free directories outside the run, once each", () => {
    const paths = layout();
    const value = [paths.docs, paths.specs, paths.docs].join(delimiter);
    expect(resolveNativeExternalReadRoots(input(paths, value))).toEqual({
      state: "admitted",
      roots: [paths.docs, paths.specs],
    });
  });

  it("admits none without a kernel read allowlist", () => {
    const paths = layout();
    expect(
      resolveNativeExternalReadRoots({ ...input(paths, paths.docs), kernelAllowlist: false }),
    ).toEqual({ state: "unsupported-platform", roots: [] });
  });

  itWithKernelAllowlist(
    "refuses the whole set for one entry it cannot accept, naming the reason",
    () => {
      const paths = layout();
      const cases: readonly [string, string][] = [
        ["relative/docs", "not-absolute"],
        [`${paths.docs ?? ""}/../docs`, "not-absolute"],
        ["/Users/someone", "too-broad"],
        [paths.file ?? "", "not-directory"],
        [join(paths.docs ?? "", "missing"), "not-directory"],
        [paths.link ?? "", "symlinked"],
        [`${paths.workspace ?? ""}/../workspace`, "not-absolute"],
        [paths.workspace ?? "", "overlaps-run"],
        [join(paths.state ?? ""), "overlaps-run"],
        [join(paths.denied ?? ""), "denied-root"],
      ];
      for (const [entry, reason] of cases)
        expect(
          resolveNativeExternalReadRoots(input(paths, [paths.docs, entry].join(delimiter))),
          entry,
        ).toEqual({ state: "refused", roots: [], reason });
      const many = Array.from({ length: 9 }, () => paths.docs).join(delimiter);
      expect(resolveNativeExternalReadRoots(input(paths, many))).toMatchObject({
        state: "refused",
        reason: "too-many",
      });
    },
  );

  itWithKernelAllowlist("refuses a root that contains the run's workspace", () => {
    const paths = layout();
    const containing = join(paths.workspace ?? "", "..");
    expect(resolveNativeExternalReadRoots(input(paths, realpathSync(containing)))).toMatchObject({
      state: "refused",
      reason: "overlaps-run",
    });
  });

  itWithKernelAllowlist(
    "records the outcome with counts and the closed reason, never a path",
    () => {
      const paths = layout();
      const records: ServerLogEvent[] = [];
      const sink: ServerLogSink = { write: (event) => void records.push(event) };
      recordNativeExternalRootsResolved(
        sink,
        "run-external-1",
        resolveNativeExternalReadRoots(input(paths, paths.docs)),
      );
      recordNativeExternalRootsResolved(
        sink,
        "run-external-1",
        resolveNativeExternalReadRoots(input(paths, paths.link)),
      );
      const [admitted, refused] = records.map((record) =>
        expectActivityLogProof(
          "coding-runtime.native-external-roots.resolved.emitted-line",
          formatActivityLogProofLine(record),
        ),
      );
      expect(admitted).toMatchObject({ state: "admitted", rootCount: 1 });
      expect(refused).toMatchObject({ state: "refused", rootCount: 0, reason: "symlinked" });
      expect(records[1]?.level).toBe("warn");
      expect(JSON.stringify(records)).not.toContain(paths.docs);
    },
  );
});
