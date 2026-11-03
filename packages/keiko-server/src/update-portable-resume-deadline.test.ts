import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepare, type HandoffFixture } from "./__tests__/portable-handoff-fixture.js";
import {
  createPortableHandoffPlan,
  writePortableHandoffPlan,
} from "./update-portable-handoff-plan.js";

const roots: string[] = [];
const compiledSubjects = new Map<string, string>();

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-resume-deadline-")));
  roots.push(root);
  return root;
}

function resumeFixture(
  restoring: boolean,
  target: "macos-arm64" | "linux-x64",
): HandoffFixture & { readonly gate: string } {
  const fixture = prepare(temporaryRoot(), target);
  if (fixture.plan.schemaVersion !== 2) throw new Error("Expected POSIX handoff fixture");
  const activationId = "d".repeat(32);
  const plan = createPortableHandoffPlan({
    ...fixture.plan,
    activationId,
    paths: {
      ...fixture.plan.paths,
      backupRoot: join(fixture.plan.paths.managedRoot, "..", `.keiko-previous-${activationId}`),
    },
    digests: {
      ...fixture.plan.digests,
      candidateLauncherSha256: createHash("sha256").update("candidate-launcher").digest("hex"),
    },
  });
  writePortableHandoffPlan({ stateDir: fixture.stateDir, plan });
  writeFileSync(fixture.coordinator, restoring ? "coordinator" : "candidate-launcher");
  const capsule = join(fixture.stateDir, "updates", "handoff", activationId);
  const gate = join(capsule, "fixture-gate");
  writeFileSync(gate, readFileSync(join(capsule, "plan.sha256")), { mode: 0o600 });
  return { ...fixture, plan, gate };
}

function runResume(
  fixture: ReturnType<typeof resumeFixture>,
  now: number,
  restoring: boolean,
  failureAt = 0,
  timing = 0,
): unknown {
  const compiledSubject = compiledSubjects.get(fixture.plan.target);
  if (compiledSubject === undefined) throw new Error("Native resume fixture was not compiled");
  const child = spawnSync(
    compiledSubject,
    [
      failureAt === 0 ? "direct" : "rollback",
      fixture.plan.activationId,
      fixture.coordinator,
      fixture.gate,
      String(now),
      String(failureAt),
      fixture.stateDir,
      restoring ? "restore" : "forward",
      String(timing),
    ],
    { encoding: "utf8", timeout: 3_500, env: { KEIKO_STATE_DIR: fixture.stateDir } },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stderr).toBe("");
  const parsed: unknown = JSON.parse(child.stdout);
  return parsed;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("actual POSIX resume phase deadlines", () => {
  beforeAll(() => {
    const compiler = process.platform === "darwin" ? "/usr/bin/clang" : "cc";
    for (const target of ["macos-arm64", "linux-x64"]) {
      const executable = join(temporaryRoot(), "resume-deadline");
      const compiled = spawnSync(
        compiler,
        [
          "-std=c17",
          "-Wall",
          "-Wextra",
          "-Wpedantic",
          "-Werror",
          "-Wno-deprecated-declarations",
          "-D_GNU_SOURCE",
          `-DKEIKO_PORTABLE_TARGET="${target}"`,
          fileURLToPath(
            new URL("../../../tests/fixtures/portable-resume-deadline.c", import.meta.url),
          ),
          "-o",
          executable,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(compiled.status, compiled.stderr).toBe(0);
      compiledSubjects.set(target, executable);
    }
  }, 35_000);

  describe.each(["macos-arm64", "linux-x64"] as const)("%s plan", (target) => {
    describe.each([false, true])("restoring %s", (restoring) => {
      it.each([
        ["poll at expiry", 1],
        ["read at expiry", 2],
        ["poll after expiry", 3],
        ["read after expiry", 4],
        ["partial gate after expiry", 5],
        ["interrupted poll at expiry", 6],
      ] as const)("preserves the grant across %s", (_name, timing) => {
        const fixture = resumeFixture(restoring, target);
        const deadline = fixture.plan.deadlines[restoring ? "cleanupAt" : "startAt"];
        expect(runResume(fixture, deadline - 10, restoring, 0, timing)).toMatchObject({
          admitted: 0,
        });
      });

      it.each([
        [1, 11],
        [2, 11],
        [3, 12],
        [4, 12],
        [5, 13],
        [6, 11],
      ])("admits timely gate I/O under timing port %s", (timing, remaining) => {
        const fixture = resumeFixture(restoring, target);
        const deadline = fixture.plan.deadlines[restoring ? "cleanupAt" : "startAt"];
        expect(runResume(fixture, deadline - remaining, restoring, 0, timing)).toMatchObject({
          admitted: 1,
        });
      });

      it("refuses authority if the monotonic clock fails after reading the gate", () => {
        const fixture = resumeFixture(restoring, target);
        const deadline = fixture.plan.deadlines[restoring ? "cleanupAt" : "startAt"];
        expect(runResume(fixture, deadline - 100, restoring, 0, 7)).toMatchObject({ admitted: 0 });
      });
    });

    it.each([
      { name: "forward before start", restoring: false, phase: "startAt", offset: -1, admitted: 1 },
      { name: "forward after start", restoring: false, phase: "startAt", offset: 1, admitted: 0 },
      { name: "forward at start", restoring: false, phase: "startAt", offset: 0, admitted: 0 },
      { name: "restore before start", restoring: true, phase: "startAt", offset: -1, admitted: 1 },
      { name: "restore after start", restoring: true, phase: "startAt", offset: 1, admitted: 1 },
      { name: "restore after verify", restoring: true, phase: "verifyAt", offset: 1, admitted: 1 },
      {
        name: "restore after cleanup",
        restoring: true,
        phase: "cleanupAt",
        offset: 1,
        admitted: 0,
      },
      { name: "restore at cleanup", restoring: true, phase: "cleanupAt", offset: 0, admitted: 0 },
    ] as const)(
      "enforces the existing deadline for $name",
      ({ restoring, phase, offset, admitted }) => {
        const fixture = resumeFixture(restoring, target);
        expect(runResume(fixture, fixture.plan.deadlines[phase] + offset, restoring)).toMatchObject(
          {
            admitted,
          },
        );
      },
    );

    it.each([
      { name: "early verification failure", phase: "startAt", offset: -1 },
      { name: "verification timeout", phase: "verifyAt", offset: 1 },
    ] as const)("admits the whole engine's restored start after $name", ({ phase, offset }) => {
      const fixture = resumeFixture(false, target);
      expect(
        runResume(
          fixture,
          fixture.plan.deadlines.startAt - 1000,
          false,
          fixture.plan.deadlines[phase] + offset,
        ),
      ).toMatchObject({ admitted: 1, restoredCalls: 1, restoredAdmissions: 1 });
    });

    it("refuses restoration after the cleanup grant expires during verification", () => {
      const fixture = resumeFixture(false, target);
      expect(
        runResume(
          fixture,
          fixture.plan.deadlines.startAt - 1000,
          false,
          fixture.plan.deadlines.cleanupAt + 1,
        ),
      ).toMatchObject({ admitted: 0, restoredCalls: 1, restoredAdmissions: 0 });
    });

    it("still validates the restored image inside its cleanup grant", () => {
      const fixture = resumeFixture(true, target);
      writeFileSync(fixture.coordinator, "tampered image");
      expect(runResume(fixture, fixture.plan.deadlines.startAt + 1, true)).toMatchObject({
        admitted: 0,
      });
    });

    it("still validates the restored start gate inside its cleanup grant", () => {
      const fixture = resumeFixture(true, target);
      const gate = readFileSync(fixture.gate, "utf8");
      writeFileSync(fixture.gate, `${gate.startsWith("0") ? "1" : "0"}${gate.slice(1)}`);
      expect(runResume(fixture, fixture.plan.deadlines.startAt + 1, true)).toMatchObject({
        admitted: 0,
      });
    });
  });
});
