import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adoptStateDirUpdateSessionLockForRecovery,
  claimStateDirUpdateSessionLockForRecovery,
  createStateDirUpdateSessionLock,
  releaseStateDirUpdateSessionLockForRecovery,
  updateSessionLockPath,
} from "./update-session-lock.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture(): { readonly stateDir: string; readonly lockPath: string } {
  const stateDir = mkdtempSync(join(tmpdir(), "keiko-update-lock-recovery-"));
  roots.push(stateDir);
  const lock = createStateDirUpdateSessionLock(stateDir, {
    processIdentity: "old-owner",
    pidAlive: () => false,
  });
  expect(
    lock.acquire({
      sessionId: "session-1",
      targetVersion: "1.2.3",
      startedAt: "2026-09-07T10:00:00.000Z",
      pid: 101,
    }),
  ).toBe(true);
  expect(lock.updateChildPid("session-1", 202)).toBe(true);
  return { stateDir, lockPath: updateSessionLockPath(stateDir) };
}

describe("update session recovery ownership", () => {
  it("fails child publication closed when its durable rename fails", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-update-lock-recovery-"));
    roots.push(stateDir);
    const lock = createStateDirUpdateSessionLock(stateDir, {
      processIdentity: "owner",
      rename: () => {
        throw Object.assign(new Error("injected child publication failure"), { code: "EIO" });
      },
    });
    expect(
      lock.acquire({
        sessionId: "session-publish",
        targetVersion: "1.2.3",
        startedAt: "2026-09-07T10:00:00.000Z",
        pid: 101,
      }),
    ).toBe(true);

    expect(lock.updateChildPid("session-publish", 202)).toBe(false);
    expect(readdirSync(join(stateDir, "updates"))).toEqual(["update-session.lock"]);
  });

  it("claims only an exact lock whose recorded owner and child are both dead", () => {
    const { stateDir, lockPath } = fixture();
    expect(
      claimStateDirUpdateSessionLockForRecovery(
        stateDir,
        { sessionId: "session-1", targetVersion: "wrong" },
        { currentPid: 303, processIdentity: "recovery-cli", pidAlive: () => false },
      ),
    ).toBeUndefined();
    expect(
      claimStateDirUpdateSessionLockForRecovery(
        stateDir,
        { sessionId: "session-1", targetVersion: "1.2.3" },
        { currentPid: 303, processIdentity: "recovery-cli", pidAlive: (pid) => pid === 202 },
      ),
    ).toBeUndefined();

    const claimed = claimStateDirUpdateSessionLockForRecovery(
      stateDir,
      { sessionId: "session-1", targetVersion: "1.2.3" },
      { currentPid: 303, processIdentity: "recovery-cli", pidAlive: () => false },
    );
    expect(claimed).toMatchObject({ sessionId: "session-1", targetVersion: "1.2.3" });
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
      pid: 303,
      childPid: 202,
      processIdentity: "recovery-cli",
    });

    const reclaimedAfterCrash = claimStateDirUpdateSessionLockForRecovery(
      stateDir,
      { sessionId: "session-1", targetVersion: "1.2.3" },
      { currentPid: 404, processIdentity: "second-recovery-cli", pidAlive: () => false },
    );
    expect(reclaimedAfterCrash).toBeDefined();
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
      pid: 404,
      childPid: 202,
      processIdentity: "second-recovery-cli",
    });
  });

  it("keeps the canonical owner visible while publishing a recovery replacement", () => {
    const { stateDir, lockPath } = fixture();
    const contender = createStateDirUpdateSessionLock(stateDir, {
      processIdentity: "contender",
      pidAlive: () => false,
      staleMs: 0,
    });
    let contenderAcquired: boolean | undefined;
    const claimed = claimStateDirUpdateSessionLockForRecovery(
      stateDir,
      { sessionId: "session-1", targetVersion: "1.2.3" },
      {
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: () => false,
        rename: (from, to) => {
          contenderAcquired = contender.acquire({
            sessionId: "session-2",
            targetVersion: "2.0.0",
            startedAt: "2026-09-07T10:01:00.000Z",
            pid: 505,
          });
          renameSync(from, to);
        },
      },
    );
    expect(contenderAcquired).toBe(false);
    expect(claimed).toBeDefined();
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
      sessionId: "session-1",
      pid: 303,
      childPid: 202,
    });
  });

  it("retains the previous canonical owner when replacement publication fails", () => {
    const { stateDir, lockPath } = fixture();
    const claimed = claimStateDirUpdateSessionLockForRecovery(
      stateDir,
      { sessionId: "session-1", targetVersion: "1.2.3" },
      {
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: () => false,
        rename: () => {
          throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
        },
      },
    );
    expect(claimed).toBeUndefined();
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
      sessionId: "session-1",
      pid: 101,
    });
    expect(
      claimStateDirUpdateSessionLockForRecovery(
        stateDir,
        { sessionId: "session-1", targetVersion: "1.2.3" },
        { currentPid: 404, processIdentity: "retry", pidAlive: () => false },
      ),
    ).toBeDefined();
  });

  it("blocks a missing child identity and adopts/releases by exact lock identity", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-update-lock-recovery-"));
    roots.push(stateDir);
    const lock = createStateDirUpdateSessionLock(stateDir, {
      processIdentity: "old-owner",
      pidAlive: () => false,
    });
    expect(
      lock.acquire({
        sessionId: "session-2",
        targetVersion: "2.0.0",
        startedAt: "2026-09-07T10:00:00.000Z",
        pid: 111,
      }),
    ).toBe(true);
    expect(
      claimStateDirUpdateSessionLockForRecovery(
        stateDir,
        { sessionId: "session-2", targetVersion: "2.0.0" },
        { currentPid: 333, processIdentity: "recovery-cli", pidAlive: () => false },
      ),
    ).toBeUndefined();
    expect(lock.updateChildPid("session-2", 222)).toBe(true);
    const claimed = claimStateDirUpdateSessionLockForRecovery(
      stateDir,
      { sessionId: "session-2", targetVersion: "2.0.0" },
      { currentPid: 333, processIdentity: "recovery-cli", pidAlive: () => false },
    );
    expect(claimed).toBeDefined();
    if (claimed === undefined) throw new TypeError("expected recovery ownership");
    const adopted = adoptStateDirUpdateSessionLockForRecovery(stateDir, claimed, {
      currentPid: 444,
      processIdentity: "recovery-bff",
    });
    expect(adopted?.lockIdentity).not.toBe(claimed.lockIdentity);
    expect(releaseStateDirUpdateSessionLockForRecovery(stateDir, claimed)).toBe(false);
    expect(adopted).toBeDefined();
    if (adopted === undefined) throw new TypeError("expected adopted ownership");
    expect(releaseStateDirUpdateSessionLockForRecovery(stateDir, adopted)).toBe(true);
    expect(existsSync(updateSessionLockPath(stateDir))).toBe(false);
  });
});
