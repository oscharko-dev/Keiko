import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandDeniedError } from "@oscharko-dev/keiko-security";
import { ISOLATION_UNAVAILABLE_DENIAL_PREFIX } from "@oscharko-dev/keiko-verification";
import { closeFileServerLogSinks, createActivityLogSink } from "../observability/index.js";
import {
  expectActivityLogProof,
  persistedActivityLogLines,
  readPersistedActivityLog,
} from "../../../../tests/support/activity-log-proof.js";
import {
  defineWindowsStepDrives,
  mapWindowsStepDrives,
  substDriveHost,
  unmapWindowsStepDrives,
  type WindowsDriveDefinition,
  type WindowsDriveHost,
  type WindowsStepDriveScope,
} from "./windowsStepDrives.js";
import type { WindowsStepDrive } from "@oscharko-dev/keiko-contracts";

const roots: string[] = [];

afterEach(() => {
  closeFileServerLogSinks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface FakeHost extends WindowsDriveHost {
  readonly defined: Map<string, string>;
  readonly stranded: Set<string>;
}

/**
 * Windows refuses letters in `taken` (they name a drive) and in `refuse`; a letter in `strand` is
 * defined but left invisible and unremoved; `keep` letters refuse every removal; `throwAt` makes the
 * n-th definition throw, as a host without subst.exe would.
 */
function fakeHost(
  options: {
    taken?: string[];
    refuse?: string[];
    strand?: string[];
    keep?: string[];
    throwAt?: number;
  } = {},
): FakeHost {
  const defined = new Map<string, string>();
  const stranded = new Set<string>();
  let calls = 0;
  return {
    defined,
    stranded,
    define: (drive, root): WindowsDriveDefinition => {
      calls++;
      if (options.throwAt === calls) throw new Error("subst.exe is not in System32");
      if (options.taken?.includes(drive) === true || options.refuse?.includes(drive) === true) {
        return "refused";
      }
      if (options.strand?.includes(drive) === true) {
        stranded.add(drive);
        return "stranded";
      }
      defined.set(drive, root);
      return "defined";
    },
    remove: (drive): boolean => {
      if (options.keep?.includes(drive) === true) return false;
      return stranded.delete(drive) || defined.delete(drive);
    },
  };
}

function scope(host: WindowsDriveHost): WindowsStepDriveScope & { readonly stateRoot: string } {
  const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-step-drives-log-")));
  roots.push(stateRoot);
  return {
    host,
    activityLog: createActivityLogSink(stateRoot),
    correlationId: "step-drives-proof",
    stateRoot,
  };
}

function recorded(stateRoot: string): readonly Record<string, unknown>[] {
  closeFileServerLogSinks();
  return persistedActivityLogLines(
    readPersistedActivityLog(stateRoot),
    "editor.verification.windows-step-drives",
  ).map((line) =>
    expectActivityLogProof("editor.verification.windows-step-drives.emitted-line", line),
  );
}

// Every letter from Z: down to E:, leaving D: the last free one.
const TAKEN_TO_E = Array.from({ length: 22 }, (_, index) => `${String.fromCodePoint(90 - index)}:`);

const WORK = String.raw`C:\Users\dev\keiko-step-1`;
const JDK = String.raw`C:\Program Files\Java\jdk-21`;

describe("defineWindowsStepDrives (#4496)", () => {
  it("gives each distinct drive directory a letter from the end of the alphabet", () => {
    const drives: WindowsStepDrive[] = [];
    const definition = defineWindowsStepDrives(
      [WORK, JDK, `${WORK.toUpperCase()}\\`, "D:\\", "E:", String.raw`\\server\share\tools`],
      fakeHost({ taken: ["Z:"] }),
      drives,
    );
    expect(definition).toEqual({ outcome: "mapped", refusedCount: 1 });
    expect(drives).toEqual([
      { root: WORK, drive: "Y:" },
      { root: JDK, drive: "X:" },
    ]);
  });

  it("names a root by its directory, without a trailing separator", () => {
    const drives: WindowsStepDrive[] = [];
    defineWindowsStepDrives([`${JDK}\\`], fakeHost(), drives);
    expect(drives).toEqual([{ root: JDK, drive: "Z:" }]);
  });

  it("skips every refused letter, and stops when none is left", () => {
    const skipped: WindowsStepDrive[] = [];
    expect(
      defineWindowsStepDrives([WORK], fakeHost({ refuse: TAKEN_TO_E.slice(0, 5) }), skipped),
    ).toEqual({ outcome: "mapped", refusedCount: 5 });
    expect(skipped).toEqual([{ root: WORK, drive: "U:" }]);
    const partial: WindowsStepDrive[] = [];
    expect(defineWindowsStepDrives([WORK, JDK], fakeHost({ taken: TAKEN_TO_E }), partial)).toEqual({
      outcome: "no-free-letter",
      refusedCount: 22,
    });
    expect(partial).toEqual([{ root: WORK, drive: "D:" }]);
  });
});

describe("mapWindowsStepDrives (#4496)", () => {
  it("records the letters it defined and their removal, by count only", () => {
    const host = fakeHost();
    const steps = scope(host);
    const drives = mapWindowsStepDrives([WORK, JDK], steps);
    expect(drives.map(({ drive }) => drive)).toEqual(["Z:", "Y:"]);
    unmapWindowsStepDrives(drives, steps);
    expect(host.defined.size).toBe(0);
    const lines = recorded(steps.stateRoot);
    expect(lines).toMatchObject([
      { correlationId: "step-drives-proof", outcome: "mapped", driveCount: 2, refusedCount: 0 },
      { correlationId: "step-drives-proof", outcome: "released", driveCount: 2, refusedCount: 0 },
    ]);
    expect(JSON.stringify(lines)).not.toContain("Program Files");
    expect(JSON.stringify(lines)).not.toContain('"Z:"');
  });

  it("refuses the step as isolation unavailable and removes the letters it had defined", () => {
    const host = fakeHost({ taken: TAKEN_TO_E });
    const steps = scope(host);
    let refusal: unknown;
    try {
      mapWindowsStepDrives([WORK, JDK], steps);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(CommandDeniedError);
    expect((refusal as Error).message.startsWith(ISOLATION_UNAVAILABLE_DENIAL_PREFIX)).toBe(true);
    expect(host.defined.size).toBe(0);
    expect(recorded(steps.stateRoot)).toMatchObject([
      { outcome: "no-free-letter", driveCount: 1, refusedCount: 22 },
      { outcome: "released", driveCount: 1 },
    ]);
  });

  it("refuses the step when the host throws, and removes the letters defined before", () => {
    const host = fakeHost({ throwAt: 2 });
    const steps = scope(host);
    expect(() => mapWindowsStepDrives([WORK, JDK], steps)).toThrow(CommandDeniedError);
    expect(host.defined.size).toBe(0);
    expect(recorded(steps.stateRoot)).toMatchObject([{ outcome: "released", driveCount: 1 }]);
  });

  it("records nothing for a step that needed no letter", () => {
    const steps = scope(fakeHost());
    unmapWindowsStepDrives(mapWindowsStepDrives(["C:\\"], steps), steps);
    expect(recorded(steps.stateRoot)).toMatchObject([{ outcome: "mapped", driveCount: 0 }]);
  });

  it("never throws from the release, also when the host itself throws", () => {
    const steps = scope({
      define: (): WindowsDriveDefinition => "defined",
      remove: () => {
        throw new Error("subst.exe is not in System32");
      },
    });
    expect(() => {
      unmapWindowsStepDrives([{ root: WORK, drive: "Z:" }], steps);
    }).not.toThrow();
    expect(recorded(steps.stateRoot)).toEqual([]);
  });

  it("records a letter Windows keeps instead of throwing", () => {
    const host = fakeHost({ keep: ["Z:"] });
    const steps = scope(host);
    const drives = mapWindowsStepDrives([WORK, JDK], steps);
    expect(() => {
      unmapWindowsStepDrives(drives, steps);
    }).not.toThrow();
    expect(recorded(steps.stateRoot)[1]).toMatchObject({
      outcome: "release-failed",
      driveCount: 2,
      refusedCount: 1,
    });
  });

  it("releases a stranded letter right away and moves on to the next one (#4568 review)", () => {
    const host = fakeHost({ strand: ["Z:"] });
    const steps = scope(host);
    expect(mapWindowsStepDrives([WORK], steps)).toEqual([{ root: WORK, drive: "Y:" }]);
    expect(host.stranded.size).toBe(0);
    expect(recorded(steps.stateRoot)).toMatchObject([
      { outcome: "mapped", driveCount: 1, refusedCount: 0 },
      { outcome: "released", driveCount: 1, refusedCount: 0 },
    ]);
  });

  it("releases a stranded letter also when the host throws on a later letter", () => {
    const host = fakeHost({ strand: ["Z:"], throwAt: 2 });
    const steps = scope(host);
    expect(() => mapWindowsStepDrives([WORK], steps)).toThrow(CommandDeniedError);
    expect(host.stranded.size).toBe(0);
    expect(recorded(steps.stateRoot)).toMatchObject([
      { outcome: "released", driveCount: 1, refusedCount: 0 },
    ]);
  });

  it("records a stranded letter Windows still keeps as a failed release, never as a refusal", () => {
    const host = fakeHost({ strand: ["Z:"], keep: ["Z:"] });
    const steps = scope(host);
    expect(mapWindowsStepDrives([WORK], steps)).toEqual([{ root: WORK, drive: "Y:" }]);
    expect(host.stranded).toEqual(new Set(["Z:"]));
    expect(recorded(steps.stateRoot)).toMatchObject([
      { outcome: "mapped", driveCount: 1, refusedCount: 0 },
      { outcome: "release-failed", driveCount: 1, refusedCount: 1 },
    ]);
  });
});

describe("substDriveHost (#4496)", () => {
  function runner(results: Record<string, boolean>): {
    readonly calls: string[];
    readonly run: (args: readonly string[]) => boolean;
  } {
    const calls: string[] = [];
    return {
      calls,
      run: (args): boolean => {
        const call = args.join(" ");
        calls.push(call);
        return results[call] ?? false;
      },
    };
  }

  it("keeps a letter subst defined and Windows shows", () => {
    const subst = runner({ "K: D:\\work": true });
    expect(substDriveHost(subst.run, () => true).define("K:", "D:\\work")).toBe("defined");
    expect(subst.calls).toEqual(["K: D:\\work"]);
  });

  it("removes a letter subst defined but Windows does not show, so no mapping is left behind", () => {
    const subst = runner({ "K: D:\\work": true, "K: /D": true });
    expect(substDriveHost(subst.run, () => false).define("K:", "D:\\work")).toBe("refused");
    expect(subst.calls).toEqual(["K: D:\\work", "K: /D"]);
  });

  it("names a letter stranded when subst /D fails after an invisible definition", () => {
    const subst = runner({ "K: D:\\work": true, "K: /D": false });
    expect(substDriveHost(subst.run, () => false).define("K:", "D:\\work")).toBe("stranded");
    expect(subst.calls).toEqual(["K: D:\\work", "K: /D"]);
  });

  it("removes nothing when subst refused the letter", () => {
    const subst = runner({});
    const visible = (): boolean => {
      throw new Error("a refused letter is never probed");
    };
    expect(substDriveHost(subst.run, visible).define("K:", "D:\\work")).toBe("refused");
    expect(subst.calls).toEqual(["K: D:\\work"]);
  });

  it("removes a letter through subst /D", () => {
    const subst = runner({ "K: /D": true });
    expect(substDriveHost(subst.run, () => true).remove("K:")).toBe(true);
    expect(subst.calls).toEqual(["K: /D"]);
  });
});
