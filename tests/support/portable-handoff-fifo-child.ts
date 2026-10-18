// Isolated reader regression fixture; native execution is forbidden.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createPortableHandoffCoordinator } from "../../packages/keiko-server/dist/update-portable-handoff.js";
import {
  portableHandoffPlanSha256,
  readPortableHandoffPlan,
  syncPortableHandoffDirectory,
} from "../../packages/keiko-server/dist/update-portable-handoff-plan.js";
import {
  appendPortableHandoffReceipt,
  portableHandoffVerifiedAckMatches,
  publishPortableHandoffVerifiedAck,
  readPortableHandoffReceipts,
} from "../../packages/keiko-server/dist/update-portable-handoff-receipts.js";
import {
  prepare,
  type HandoffFixture,
} from "../../packages/keiko-server/dist/__tests__/portable-handoff-fixture.js";
function replaceWithFifo(path: string): void {
  fs.rmSync(path, { recursive: true, force: true });
  execFileSync("/usr/bin/mkfifo", [path], { timeout: 5_000 });
}
function replaceAtOpen(selected: string): () => void {
  const original = fs.openSync;
  let replaced = false;
  fs.openSync = (path, flags, mode): number => {
    if (!replaced && path === selected) {
      replaced = true;
      replaceWithFifo(selected);
    }
    return original(path, flags, mode);
  };
  syncBuiltinESMExports();
  return (): void => {
    fs.openSync = original;
    syncBuiltinESMExports();
    if (!replaced) throw new Error("The selected open boundary was not reached");
  };
}
async function coordinator(fixture: HandoffFixture): Promise<boolean> {
  const stop = new Error("Controlled stop before native execution");
  let verifications = 0;
  let prepared = 0;
  let spawns = 0;
  const port = createPortableHandoffCoordinator({
    stateDir: fixture.stateDir,
    verifyNativeCopy: (): Promise<void> => {
      verifications += 1;
      return Promise.resolve();
    },
    persistPrepared: (): Promise<never> => {
      prepared += 1;
      return Promise.reject(stop);
    },
    persistAccepted: (): Promise<void> => Promise.resolve(),
    publishCoordinatorPid: (): boolean => true,
    spawnFn: (): never => {
      spawns += 1;
      throw new Error("Native execution is forbidden in this fixture");
    },
  });
  try {
    await port.begin({
      sessionId: fixture.plan.sessionId,
      activationId: fixture.plan.activationId,
    });
  } catch (error) {
    if (!(error instanceof Error) || spawns !== 0) throw error;
    return error === stop && verifications === 2 && prepared === 1;
  }
  throw new Error("The controlled preparation stop was not reached");
}
async function copyScenario(
  root: string,
  subject: string,
  target: "linux-x64" | "macos-arm64",
): Promise<void> {
  if (!(await coordinator(prepare(join(root, "healthy"), target)))) {
    throw new Error("Healthy native copy did not reach its controlled stop");
  }
  const fixture = prepare(join(root, "subject"), target);
  const directory = join(fixture.stateDir, "updates", "handoff", fixture.plan.activationId);
  const restore = subject === "copy-directory-race" ? replaceAtOpen(directory) : undefined;
  if (restore === undefined) {
    replaceWithFifo(subject === "copy-coordinator" ? fixture.coordinator : fixture.supervisor);
  }
  try {
    if (await coordinator(fixture)) throw new Error("Unsafe copy was accepted");
  } finally {
    restore?.();
  }
}
function reader(fixture: HandoffFixture, kind: string): () => boolean {
  const { stateDir, plan } = fixture;
  const activationId = plan.activationId;
  const planSha256 = portableHandoffPlanSha256(plan);
  appendPortableHandoffReceipt({
    stateDir,
    activationId,
    planSha256,
    kind: "prepared",
    outcome: "completed",
    at: 1,
  });
  publishPortableHandoffVerifiedAck({ stateDir, activationId, planSha256 });
  if (kind === "plan")
    return (): boolean =>
      readPortableHandoffPlan(stateDir, activationId).activationId === activationId;
  if (kind === "receipt")
    return (): boolean => readPortableHandoffReceipts(stateDir, activationId).length === 1;
  return (): boolean => portableHandoffVerifiedAckMatches({ stateDir, activationId, planSha256 });
}
function assertRefused(read: () => unknown): void {
  try {
    if (read() === false) return;
  } catch (error) {
    if (error instanceof Error) return;
    throw error;
  }
  throw new Error("Unsafe input was accepted");
}
function readScenario(root: string, subject: string): void {
  const fixture = prepare(root, "linux-x64");
  const kind = subject.split("-")[0] ?? "";
  const read = reader(fixture, kind);
  if (!read()) throw new Error("Healthy reader was not reachable");
  const base = join(fixture.stateDir, "updates", "handoff", fixture.plan.activationId);
  const leaf =
    kind === "plan"
      ? ["plan.khp"]
      : kind === "receipt"
        ? ["receipts", "000001.khr"]
        : ["verified.ack"];
  const selected = join(base, ...leaf);
  const restore = subject.endsWith("-race") ? replaceAtOpen(selected) : undefined;
  if (restore === undefined) replaceWithFifo(selected);
  try {
    assertRefused(read);
  } finally {
    restore?.();
  }
}
async function main(): Promise<void> {
  const root = process.argv[2];
  const subject = process.argv[3];
  const target = process.argv[4];
  if (!root || !subject || (target !== "linux-x64" && target !== "macos-arm64")) {
    throw new TypeError("Invalid FIFO fixture arguments");
  }
  if (subject.startsWith("copy-")) await copyScenario(root, subject, target);
  else if (subject === "directory-fifo") {
    fs.mkdirSync(root, { recursive: true });
    syncPortableHandoffDirectory(root);
    replaceWithFifo(root);
    assertRefused(() => {
      syncPortableHandoffDirectory(root);
    });
  } else readScenario(root, subject);
  process.stdout.write("refused-after-healthy-control");
}
await main();
