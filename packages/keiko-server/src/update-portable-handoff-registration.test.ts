import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepare, type HandoffFixture } from "./__tests__/portable-handoff-fixture.js";
import { posixPortableActivationLayout } from "./update-portable-activation-files.js";
import { createPortableHandoffCoordinator } from "./update-portable-handoff.js";

const roots: string[] = [];
const mutations = [
  "setup-changed",
  "setup-missing",
  "setup-linked",
  "registration-changed",
  "registration-missing",
] as const;
type Mutation = (typeof mutations)[number];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function controlledCoordinator(fixture: HandoffFixture): {
  readonly begin: () => Promise<unknown>;
  readonly verify: ReturnType<typeof vi.fn>;
  readonly stop: Error;
} {
  const stop = new Error("Controlled stop before native execution");
  const verify = vi.fn(() => Promise.resolve());
  const coordinator = createPortableHandoffCoordinator({
    stateDir: fixture.stateDir,
    verifyNativeCopy: verify,
    persistPrepared: () => Promise.reject(stop),
    persistAccepted: () => Promise.resolve(),
    publishCoordinatorPid: () => true,
    spawnFn: (): never => {
      throw new Error("Native execution is forbidden in this fixture");
    },
  });
  return {
    begin: () =>
      coordinator.begin({
        sessionId: fixture.plan.sessionId,
        activationId: fixture.plan.activationId,
      }),
    verify,
    stop,
  };
}

function mutateInstall(
  fixture: HandoffFixture,
  target: "linux-x64" | "macos-arm64",
  mutation: Mutation,
): void {
  const path = mutation.startsWith("setup-")
    ? posixPortableActivationLayout(target, fixture.plan.paths.managedRoot).setupManifestPath
    : join(fixture.stateDir, "portable-install-state.json");
  if (mutation.endsWith("missing")) rmSync(path);
  else if (mutation.endsWith("linked")) linkSync(path, `${path}.alias`);
  else writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from("\n")]));
}

describe("portable handoff current registration", () => {
  it.each(
    (["linux-x64", "macos-arm64"] as const).flatMap((target) =>
      mutations.map((mutation) => ({ target, mutation })),
    ),
  )(
    "refuses $mutation on $target before verifying copied executables",
    async ({ target, mutation }) => {
      const root = mkdtempSync(join(tmpdir(), "keiko-handoff-registration-"));
      roots.push(root);
      const fixture = prepare(root, target);
      const healthy = controlledCoordinator(fixture);
      await expect(healthy.begin()).rejects.toBe(healthy.stop);
      expect(healthy.verify).toHaveBeenCalledTimes(2);

      mutateInstall(fixture, target, mutation);
      const changed = controlledCoordinator(fixture);
      await expect(changed.begin()).rejects.toThrow("current managed registration is invalid");
      expect(changed.verify).not.toHaveBeenCalled();
    },
  );
});
