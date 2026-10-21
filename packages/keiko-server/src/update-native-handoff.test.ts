import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepare } from "./__tests__/portable-handoff-fixture.js";
import {
  NativeAppControlError,
  type NativeAppHandoffControl,
} from "./update-native-app-control.js";
import { createPortableHandoffCoordinator } from "./update-portable-handoff.js";

const roots: string[] = [];

function fixture(): {
  readonly stateDir: string;
  readonly activationId: string;
  readonly oldLaunchId: string;
} {
  const root = mkdtempSync(join(tmpdir(), "keiko-native-handoff-"));
  roots.push(root);
  const { stateDir, plan } = prepare(root, "linux-x64");
  return { stateDir, activationId: plan.activationId, oldLaunchId: plan.oldProcess.launchId };
}

function controlFixture(): {
  readonly start: ReturnType<typeof vi.fn<NativeAppHandoffControl["start"]>>;
  readonly accept: ReturnType<typeof vi.fn<NativeAppHandoffControl["accept"]>>;
  readonly commit: ReturnType<typeof vi.fn<NativeAppHandoffControl["commit"]>>;
  readonly cancel: ReturnType<typeof vi.fn<NativeAppHandoffControl["cancel"]>>;
} {
  return {
    start: vi.fn(() => Promise.resolve(43_210)),
    accept: vi.fn(() => Promise.resolve()),
    commit: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(() => Promise.resolve()),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable handoff through the admitted native app owner", () => {
  it("publishes the actual coordinator before authorization and persists acceptance before commit", async () => {
    const selected = fixture();
    const control = controlFixture();
    const order: string[] = [];
    control.start.mockImplementation(() => {
      order.push("start");
      return Promise.resolve(43_210);
    });
    control.accept.mockImplementation(() => {
      order.push("authorize");
      return Promise.resolve();
    });
    control.commit.mockImplementation(() => {
      order.push("commit");
      return Promise.resolve();
    });
    const spawnFn = vi.fn();
    const coordinator = createPortableHandoffCoordinator({
      stateDir: selected.stateDir,
      persistPrepared: () => {
        order.push("prepared");
        return Promise.resolve();
      },
      persistAccepted: () => {
        order.push("accepted");
        return Promise.resolve();
      },
      publishCoordinatorPid: (_session, pid) => {
        expect(pid).toBe(43_210);
        order.push("published");
        return true;
      },
      verifyNativeCopy: () => Promise.resolve(),
      nativeControl: (launchId) => {
        expect(launchId).toBe(selected.oldLaunchId);
        return Promise.resolve(control);
      },
      spawnFn,
    });
    await coordinator.begin({ sessionId: "session-1", activationId: selected.activationId });
    expect(order).toStrictEqual([
      "prepared",
      "start",
      "published",
      "authorize",
      "accepted",
      "commit",
    ]);
    expect(control.cancel).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("cancels its native coordinator before returning a failed PID publication", async () => {
    const selected = fixture();
    const control = controlFixture();
    const coordinator = createPortableHandoffCoordinator({
      stateDir: selected.stateDir,
      persistPrepared: () => Promise.resolve(),
      persistAccepted: () => Promise.resolve(),
      publishCoordinatorPid: () => false,
      verifyNativeCopy: () => Promise.resolve(),
      nativeControl: () => Promise.resolve(control),
    });
    await expect(
      coordinator.begin({ sessionId: "session-1", activationId: selected.activationId }),
    ).rejects.toMatchObject({ nativeAuthorityMayBeLive: false });
    expect(control.accept).not.toHaveBeenCalled();
    expect(control.commit).not.toHaveBeenCalled();
    expect(control.cancel).toHaveBeenCalledOnce();
    expect(control.cancel.mock.calls[0]?.[0]).toBe(selected.activationId);
  });

  it("preserves a failed accepted checkpoint and missing positive cleanup as uncertainty", async () => {
    const selected = fixture();
    const control = controlFixture();
    const casFailure = new Error("synthetic accepted checkpoint conflict");
    const cleanupFailure = new Error("synthetic missing owned cleanup receipt");
    control.cancel.mockRejectedValue(cleanupFailure);
    const coordinator = createPortableHandoffCoordinator({
      stateDir: selected.stateDir,
      persistPrepared: () => Promise.resolve(),
      persistAccepted: () => Promise.reject(casFailure),
      publishCoordinatorPid: () => true,
      verifyNativeCopy: () => Promise.resolve(),
      nativeControl: () => Promise.resolve(control),
    });
    const failure: unknown = await coordinator
      .begin({ sessionId: "session-1", activationId: selected.activationId })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      nativeAuthorityMayBeLive: true,
      cause: { errors: [casFailure, cleanupFailure] },
    });
    expect(control.accept).toHaveBeenCalledOnce();
    expect(control.commit).not.toHaveBeenCalled();
  });

  it("never falls back to a child spawn after native admission refuses", async () => {
    const selected = fixture();
    const spawnFn = vi.fn();
    const control = controlFixture();
    control.start.mockRejectedValue(new NativeAppControlError(false));
    const coordinator = createPortableHandoffCoordinator({
      stateDir: selected.stateDir,
      persistPrepared: () => Promise.resolve(),
      persistAccepted: () => Promise.resolve(),
      publishCoordinatorPid: () => true,
      verifyNativeCopy: () => Promise.resolve(),
      nativeControl: () => Promise.resolve(control),
      spawnFn,
    });
    await expect(
      coordinator.begin({ sessionId: "session-1", activationId: selected.activationId }),
    ).rejects.toMatchObject({ nativeAuthorityMayBeLive: false });
    expect(control.cancel).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
