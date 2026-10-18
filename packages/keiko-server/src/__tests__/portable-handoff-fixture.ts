import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { posixPortableActivationLayout } from "../update-portable-activation-files.js";
import {
  createPortableHandoffPlan,
  writePortableHandoffPlan,
  type PortableHandoffPlan,
} from "../update-portable-handoff-plan.js";

export interface HandoffFixture {
  readonly coordinator: string;
  readonly plan: PortableHandoffPlan;
  readonly stateDir: string;
  readonly supervisor: string;
}

const PLAN_FIELDS = {
  activationId: "a".repeat(32),
  sessionId: "session-1",
  stageId: "stage-1",
  targetVersion: "1.2.3",
  newLaunchId: "2".repeat(32),
  restoreLaunchId: "3".repeat(32),
  aggregateRevision: 7,
  previousRegistrationState: "present" as const,
  oldProcess: {
    pid: 123,
    launchId: "b".repeat(32),
    host: "127.0.0.1" as const,
    port: 1983,
    version: "1.2.2",
  },
  deadlines: {
    oldExitAt: 1_800_000_000_000,
    startAt: 1_800_000_030_000,
    verifyAt: 1_800_000_060_000,
    cleanupAt: 1_800_000_090_000,
  },
};

const DIGEST_FIELDS = {
  currentTreeSha256: "c".repeat(64),
  candidateTreeSha256: "d".repeat(64),
  candidateLauncherSha256: "e".repeat(64),
  candidateSupervisorSha256: "f".repeat(64),
  previousRegistrationSha256: "0".repeat(64),
  preparedRegistrationSha256: "1".repeat(64),
};

export function prepare(
  root: string,
  target: "macos-arm64" | "linux-x64" = "macos-arm64",
): HandoffFixture {
  const stateDir = join(root, "state");
  const parent = join(root, "install-parent");
  const managedRoot = join(parent, target === "linux-x64" ? "Keiko" : "Keiko.app");
  const stageRoot = join(parent, ".keiko-portable-updates", "stage-1");
  const candidateRoot = join(stageRoot, "Keiko", ...(target === "linux-x64" ? [] : ["Keiko.app"]));
  const current = posixPortableActivationLayout(target, managedRoot);
  const candidate = posixPortableActivationLayout(target, candidateRoot);
  const supervisor = join(current.resourceRoot, "runtime", "native", "keiko-runtime-supervisor");
  mkdirSync(dirname(current.launcherPath), { recursive: true });
  mkdirSync(dirname(supervisor), { recursive: true });
  mkdirSync(stageRoot, { recursive: true });
  writeFileSync(current.launcherPath, "coordinator");
  writeFileSync(supervisor, "supervisor");
  const plan = createPortableHandoffPlan({
    ...PLAN_FIELDS,
    target,
    paths: {
      managedRoot,
      stageRoot,
      candidateRoot,
      backupRoot: join(parent, `.keiko-previous-${PLAN_FIELDS.activationId}`),
      candidateLauncher: candidate.launcherPath,
      candidateSupervisor: join(
        candidate.resourceRoot,
        "runtime",
        "native",
        "keiko-runtime-supervisor",
      ),
    },
    digests: {
      ...DIGEST_FIELDS,
      currentLauncherSha256: createHash("sha256").update("coordinator").digest("hex"),
      currentSupervisorSha256: createHash("sha256").update("supervisor").digest("hex"),
    },
  });
  writePortableHandoffPlan({ stateDir, plan });
  return { coordinator: current.launcherPath, plan, stateDir, supervisor };
}
