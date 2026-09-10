import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { UpdatePortableTarget } from "@oscharko-dev/keiko-contracts";
import { atomicPublishRename } from "@oscharko-dev/keiko-security/fs-atomic-rename";
import { PORTABLE_STAGE_DIR_PREFIX } from "./update-portable-staging-shared.js";

const ACTIVATION_ID = /^[a-f0-9]{32}$/u;
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;
const MAX_PLAN_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 32 * 1024;
const PLAN_FILE = "plan.khp";
const PLAN_DIGEST_FILE = "plan.sha256";

export const PORTABLE_HANDOFF_ACTIONS = Object.freeze([
  "old-exit",
  "promote",
  "register",
  "start",
  "verify",
  "cleanup",
] as const);

interface PortableHandoffPlanFields {
  readonly activationId: string;
  readonly sessionId: string;
  readonly stageId: string;
  readonly target: UpdatePortableTarget;
  readonly targetVersion: string;
  readonly newLaunchId: string;
  readonly restoreLaunchId: string;
  readonly aggregateRevision: number;
  readonly previousRegistrationState: "present" | "absent";
  readonly oldProcess: {
    readonly pid: number;
    readonly launchId: string;
    readonly host: "127.0.0.1";
    readonly port: number;
    readonly version: string;
  };
  readonly paths: {
    readonly managedRoot: string;
    readonly stageRoot: string;
    readonly candidateRoot: string;
    readonly backupRoot: string;
    readonly candidateLauncher: string;
    readonly candidateSupervisor: string;
  };
  readonly digests: {
    readonly currentTreeSha256: string;
    readonly candidateTreeSha256: string;
    readonly currentLauncherSha256: string;
    readonly currentSupervisorSha256: string;
    readonly candidateLauncherSha256: string;
    readonly candidateSupervisorSha256: string;
    readonly previousRegistrationSha256: string;
    readonly preparedRegistrationSha256: string;
  };
  readonly deadlines: {
    readonly oldExitAt: number;
    readonly startAt: number;
    readonly verifyAt: number;
    readonly cleanupAt: number;
  };
  readonly actions: typeof PORTABLE_HANDOFF_ACTIONS;
}

type CommonPortableHandoffPlanInput = Omit<PortableHandoffPlanFields, "actions">;

export interface MacosPortableHandoffPlan extends PortableHandoffPlanFields {
  readonly schemaVersion: 2;
  readonly target: "linux-x64" | "macos-arm64" | "macos-x64";
}

export interface WindowsPortableHandoffPlan extends PortableHandoffPlanFields {
  readonly schemaVersion: 3;
  readonly target: "windows-x64";
  readonly cutoverKind: "windows-generation-v1";
  readonly currentGenerationTreeSha256: string;
  readonly candidateGenerationTreeSha256: string;
  readonly currentSetupManifestSha256: string;
  readonly candidateSetupManifestSha256: string;
}

export type PortableHandoffPlan = MacosPortableHandoffPlan | WindowsPortableHandoffPlan;
export type PortableHandoffPlanInput =
  | Omit<MacosPortableHandoffPlan, "schemaVersion" | "actions">
  | Omit<WindowsPortableHandoffPlan, "schemaVersion" | "actions">;

export class PortableHandoffPlanError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PortableHandoffPlanError";
  }
}

function fail(message: string): never {
  throw new PortableHandoffPlanError(message);
}

function assertRegularSingleLink(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail(`${label} is unsafe`);
}

function sameOpenedFile(before: Stats, after: Stats): boolean {
  return (
    after.isFile() &&
    after.nlink === 1 &&
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.size === before.size &&
    after.mtimeMs === before.mtimeMs &&
    after.ctimeMs === before.ctimeMs
  );
}

function safeOpenedFile(stat: Stats, maximumBytes: number): boolean {
  return stat.isFile() && stat.nlink === 1 && stat.size >= 0 && stat.size <= maximumBytes;
}

function currentPathMatchesOpened(current: Stats, opened: Stats): boolean {
  return (
    current.isFile() &&
    !current.isSymbolicLink() &&
    current.nlink === 1 &&
    current.dev === opened.dev &&
    current.ino === opened.ino &&
    current.size === opened.size &&
    current.mtimeMs === opened.mtimeMs &&
    current.ctimeMs === opened.ctimeMs
  );
}

function namedFileBeforeOpen(path: string, maximumBytes: number, label: string): Stats {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`${label} is unsafe`);
  }
  if (stat.isSymbolicLink() || !safeOpenedFile(stat, maximumBytes)) fail(`${label} is unsafe`);
  return stat;
}

function readBoundedRegularFile(path: string, maximumBytes: number, label: string): Buffer {
  const namedBefore = namedFileBeforeOpen(path, maximumBytes, label);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail(`${label} is unsafe`);
  }
  try {
    const before = fstatSync(descriptor);
    if (!safeOpenedFile(before, maximumBytes) || !currentPathMatchesOpened(namedBefore, before)) {
      fail(`${label} is unsafe`);
    }
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const count = readSync(descriptor, content, offset, content.length - offset, null);
      if (count === 0) fail(`${label} changed while reading`);
      offset += count;
    }
    const after = fstatSync(descriptor);
    const current = lstatSync(path);
    if (!sameOpenedFile(before, after) || !currentPathMatchesOpened(current, before)) {
      fail(`${label} changed while reading`);
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function assertSafeHandoffTree(stateDir: string, activationId: string): string {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (lstatSync(stateDir).isSymbolicLink() || !lstatSync(stateDir).isDirectory()) {
    fail("portable handoff path is unsafe");
  }
  const canonicalState = realpathSync(stateDir);
  const segments = ["updates", "handoff", activationId];
  let cursor = canonicalState;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    if (
      existsSync(cursor) &&
      (lstatSync(cursor).isSymbolicLink() || !lstatSync(cursor).isDirectory())
    ) {
      fail("portable handoff path is unsafe");
    }
  }
  return join(canonicalState, ...segments);
}

function isContained(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function assertTopology(plan: PortableHandoffPlan): void {
  const parent = dirname(resolve(plan.paths.managedRoot));
  const stagingBase = join(parent, PORTABLE_STAGE_DIR_PREFIX);
  const expectedStage = join(stagingBase, plan.stageId);
  const expectedBackup = join(parent, `.keiko-previous-${plan.activationId}`);
  if (
    resolve(plan.paths.stageRoot) !== resolve(expectedStage) ||
    resolve(plan.paths.backupRoot) !== resolve(expectedBackup) ||
    !isContained(plan.paths.stageRoot, plan.paths.candidateRoot) ||
    !isContained(plan.paths.candidateRoot, plan.paths.candidateLauncher) ||
    !isContained(plan.paths.candidateRoot, plan.paths.candidateSupervisor)
  ) {
    fail("portable handoff topology is invalid");
  }
}

function isTarget(value: unknown): value is UpdatePortableTarget {
  return (
    value === "linux-x64" ||
    value === "windows-x64" ||
    value === "macos-arm64" ||
    value === "macos-x64"
  );
}

function hasValidLaunchIdentity(plan: PortableHandoffPlan): boolean {
  return (
    BOUNDED_ID.test(plan.newLaunchId) &&
    BOUNDED_ID.test(plan.restoreLaunchId) &&
    plan.restoreLaunchId !== plan.newLaunchId &&
    plan.restoreLaunchId !== plan.oldProcess.launchId
  );
}

function assertPlanIdentity(plan: PortableHandoffPlan): void {
  if (!ACTIVATION_ID.test(plan.activationId)) fail("portable handoff activation id is invalid");
  if (!BOUNDED_ID.test(plan.sessionId) || !BOUNDED_ID.test(plan.stageId)) {
    fail("portable handoff identity is invalid");
  }
  if (!isTarget(plan.target) || !VERSION.test(plan.targetVersion))
    fail("portable handoff target is invalid");
  if (!hasValidLaunchIdentity(plan)) fail("portable handoff launch identity is invalid");
  if (!Number.isSafeInteger(plan.aggregateRevision) || plan.aggregateRevision < 1) {
    fail("portable handoff revision is invalid");
  }
}

function assertOldProcess(plan: PortableHandoffPlan): void {
  const old = plan.oldProcess;
  if (
    !Number.isSafeInteger(old.pid) ||
    old.pid < 1 ||
    old.pid > 2_147_483_647 ||
    !BOUNDED_ID.test(old.launchId) ||
    // Parsed protocol bytes are untrusted despite the narrowed caller-facing type.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    old.host !== "127.0.0.1" ||
    !Number.isSafeInteger(old.port) ||
    old.port < 1 ||
    old.port > 65_535 ||
    !VERSION.test(old.version)
  )
    fail("portable handoff old process identity is invalid");
}

function appendWindowsDigests(plan: WindowsPortableHandoffPlan, digests: string[]): void {
  if (plan.previousRegistrationState !== "present") {
    fail("portable Windows handoff requires a previous registration");
  }
  digests.push(
    plan.currentGenerationTreeSha256,
    plan.candidateGenerationTreeSha256,
    plan.currentSetupManifestSha256,
    plan.candidateSetupManifestSha256,
  );
  // Parsed protocol bytes are untrusted despite the literal caller-facing type.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (plan.cutoverKind !== "windows-generation-v1") {
    fail("portable handoff cutover kind is invalid");
  }
}

function assertDigestsAndDeadlines(plan: PortableHandoffPlan): void {
  if (!new Set<string>(["present", "absent"]).has(plan.previousRegistrationState)) {
    fail("portable handoff registration state is invalid");
  }
  const digests = Object.values(plan.digests);
  if (plan.target === "windows-x64") {
    appendWindowsDigests(plan, digests);
  }
  if (!digests.every((value) => HEX_SHA256.test(value))) fail("portable handoff digest is invalid");
  const deadlines = Object.values(plan.deadlines);
  if (!deadlines.every((value) => Number.isSafeInteger(value) && value > 0)) {
    fail("portable handoff deadline is invalid");
  }
  if (!(
    plan.deadlines.oldExitAt < plan.deadlines.startAt &&
    plan.deadlines.startAt < plan.deadlines.verifyAt &&
    plan.deadlines.verifyAt < plan.deadlines.cleanupAt
  ))
    fail("portable handoff deadlines are invalid");
}

function assertPathsAndActions(plan: PortableHandoffPlan): void {
  if (plan.actions.join("|") !== PORTABLE_HANDOFF_ACTIONS.join("|")) {
    fail("portable handoff action list is invalid");
  }
  Object.values(plan.paths).forEach((path) => {
    if (
      !isAbsolute(path) ||
      resolve(path) !== path ||
      path.includes("\0") ||
      (sep === "/" && path.includes("\\")) ||
      Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES
    )
      fail("portable handoff path is invalid");
  });
  assertTopology(plan);
}

function assertPlan(plan: PortableHandoffPlan): void {
  assertPlanIdentity(plan);
  assertOldProcess(plan);
  assertDigestsAndDeadlines(plan);
  assertPathsAndActions(plan);
}

export function createPortableHandoffPlan(input: PortableHandoffPlanInput): PortableHandoffPlan {
  const plan = {
    schemaVersion: input.target === "windows-x64" ? (3 as const) : (2 as const),
    ...input,
    actions: PORTABLE_HANDOFF_ACTIONS,
  } as PortableHandoffPlan;
  assertPlan(plan);
  return plan;
}

function planFields(plan: PortableHandoffPlan): readonly string[] {
  const common = [
    plan.activationId,
    plan.sessionId,
    plan.stageId,
    plan.target,
    plan.targetVersion,
    plan.newLaunchId,
    plan.restoreLaunchId,
    String(plan.aggregateRevision),
    plan.previousRegistrationState,
    String(plan.oldProcess.pid),
    plan.oldProcess.launchId,
    plan.oldProcess.host,
    String(plan.oldProcess.port),
    plan.oldProcess.version,
    plan.paths.managedRoot,
    plan.paths.stageRoot,
    plan.paths.candidateRoot,
    plan.paths.backupRoot,
    plan.paths.candidateLauncher,
    plan.paths.candidateSupervisor,
    plan.digests.currentTreeSha256,
    plan.digests.candidateTreeSha256,
    plan.digests.currentLauncherSha256,
    plan.digests.currentSupervisorSha256,
    plan.digests.candidateLauncherSha256,
    plan.digests.candidateSupervisorSha256,
    plan.digests.previousRegistrationSha256,
    plan.digests.preparedRegistrationSha256,
    String(plan.deadlines.oldExitAt),
    String(plan.deadlines.startAt),
    String(plan.deadlines.verifyAt),
    String(plan.deadlines.cleanupAt),
  ];
  return plan.target === "windows-x64"
    ? [
        ...common,
        plan.cutoverKind,
        plan.currentGenerationTreeSha256,
        plan.candidateGenerationTreeSha256,
        plan.currentSetupManifestSha256,
        plan.candidateSetupManifestSha256,
      ]
    : common;
}

export function encodePortableHandoffPlan(plan: PortableHandoffPlan): Buffer {
  assertPlan(plan);
  const fields = planFields(plan).map((field) => Buffer.from(field, "utf8"));
  const header = Buffer.alloc(8);
  header.write("KHP1", 0, "ascii");
  header.writeUInt16LE(plan.schemaVersion, 4);
  header.writeUInt16LE(fields.length, 6);
  return Buffer.concat([
    header,
    ...fields.flatMap((field) => {
      const length = Buffer.alloc(4);
      length.writeUInt32LE(field.length);
      return [length, field];
    }),
  ]);
}

export function portableHandoffPlanSha256(plan: PortableHandoffPlan): string {
  return createHash("sha256").update(encodePortableHandoffPlan(plan)).digest("hex");
}

export function portableHandoffRoot(stateDir: string, activationId: string): string {
  if (!ACTIVATION_ID.test(activationId)) fail("portable handoff activation id is invalid");
  return assertSafeHandoffTree(stateDir, activationId);
}

function durableWrite(path: string, content: string | Uint8Array): void {
  const noFollow = constants.O_NOFOLLOW;
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export interface PortableHandoffSyncOps {
  readonly close: (descriptor: number) => void;
  readonly fsync: (descriptor: number) => void;
  readonly openDirectory: (path: string) => number;
  readonly platform: NodeJS.Platform;
}

const HANDOFF_SYNC_OPS: PortableHandoffSyncOps = {
  close: closeSync,
  fsync: fsyncSync,
  openDirectory: (path) => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
  platform: process.platform,
};

export function syncPortableHandoffDirectory(
  path: string,
  ops: PortableHandoffSyncOps = HANDOFF_SYNC_OPS,
): void {
  let descriptor: number | undefined;
  try {
    descriptor = ops.openDirectory(path);
    ops.fsync(descriptor);
  } catch (error) {
    if (!windowsDirectorySyncUnsupported(error, ops.platform)) throw error;
  } finally {
    if (descriptor !== undefined) ops.close(descriptor);
  }
}

function windowsDirectorySyncUnsupported(error: unknown, platform: NodeJS.Platform): boolean {
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  return platform === "win32" && ["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(code);
}

export function writePortableHandoffPlan(input: {
  readonly stateDir: string;
  readonly plan: PortableHandoffPlan;
}): { readonly path: string; readonly sha256: string } {
  const root = assertSafeHandoffTree(input.stateDir, input.plan.activationId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertSafeHandoffTree(input.stateDir, input.plan.activationId);
  const path = join(root, PLAN_FILE);
  const digestPath = join(root, PLAN_DIGEST_FILE);
  if (existsSync(path) || existsSync(digestPath)) fail("portable handoff plan already exists");
  const content = encodePortableHandoffPlan(input.plan);
  if (content.byteLength > MAX_PLAN_BYTES) fail("portable handoff plan is too large");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const temporary = join(root, `.plan-${String(process.pid)}.tmp`);
  durableWrite(temporary, content);
  atomicPublishRename(temporary, path, { rename: renameSync });
  durableWrite(digestPath, `${sha256}\n`);
  syncPortableHandoffDirectory(root);
  assertRegularSingleLink(path, "portable handoff plan");
  assertRegularSingleLink(digestPath, "portable handoff digest");
  return { path, sha256 };
}

function planHeader(content: Buffer): { readonly version: 2 | 3; readonly fieldCount: 32 | 37 } {
  const version = content.length >= 8 ? content.readUInt16LE(4) : 0;
  const fieldCount = content.length >= 8 ? content.readUInt16LE(6) : 0;
  if (
    content.length < 8 ||
    content.subarray(0, 4).toString("ascii") !== "KHP1" ||
    content.length > MAX_PLAN_BYTES
  ) {
    fail("portable handoff plan is malformed");
  }
  if (version === 2 && fieldCount === 32) return { version, fieldCount };
  if (version === 3 && fieldCount === 37) return { version, fieldCount };
  fail("portable handoff plan is malformed");
}

function readPlanFields(content: Buffer): {
  readonly version: 2 | 3;
  readonly fields: readonly string[];
} {
  const header = planHeader(content);
  const fields: string[] = [];
  let offset = 8;
  for (let index = 0; index < header.fieldCount; index += 1) {
    if (offset + 4 > content.length) fail("portable handoff plan is malformed");
    const length = content.readUInt32LE(offset);
    offset += 4;
    if (length > MAX_PLAN_BYTES || offset + length > content.length) {
      fail("portable handoff plan is malformed");
    }
    try {
      fields.push(
        new TextDecoder("utf-8", { fatal: true }).decode(content.subarray(offset, offset + length)),
      );
    } catch {
      fail("portable handoff plan is malformed");
    }
    offset += length;
  }
  if (offset !== content.length) fail("portable handoff plan is malformed");
  return { version: header.version, fields };
}

function numericField(value: string | undefined): number {
  if (value === undefined || !/^(?:0|[1-9]\d{0,15})$/u.test(value))
    fail("portable handoff plan is malformed");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail("portable handoff plan is malformed");
  return parsed;
}

function requiredField(fields: readonly string[], index: number): string {
  const value = fields[index];
  if (value === undefined) fail("portable handoff plan is malformed");
  return value;
}

function parseCommonPlanFields(field: readonly string[]): CommonPortableHandoffPlanInput {
  return {
    activationId: requiredField(field, 0),
    sessionId: requiredField(field, 1),
    stageId: requiredField(field, 2),
    target: requiredField(field, 3) as UpdatePortableTarget,
    targetVersion: requiredField(field, 4),
    newLaunchId: requiredField(field, 5),
    restoreLaunchId: requiredField(field, 6),
    aggregateRevision: numericField(field[7]),
    previousRegistrationState: requiredField(field, 8) as "present" | "absent",
    oldProcess: {
      pid: numericField(field[9]),
      launchId: requiredField(field, 10),
      host: requiredField(field, 11) as "127.0.0.1",
      port: numericField(field[12]),
      version: requiredField(field, 13),
    },
    paths: {
      managedRoot: requiredField(field, 14),
      stageRoot: requiredField(field, 15),
      candidateRoot: requiredField(field, 16),
      backupRoot: requiredField(field, 17),
      candidateLauncher: requiredField(field, 18),
      candidateSupervisor: requiredField(field, 19),
    },
    digests: {
      currentTreeSha256: requiredField(field, 20),
      candidateTreeSha256: requiredField(field, 21),
      currentLauncherSha256: requiredField(field, 22),
      currentSupervisorSha256: requiredField(field, 23),
      candidateLauncherSha256: requiredField(field, 24),
      candidateSupervisorSha256: requiredField(field, 25),
      previousRegistrationSha256: requiredField(field, 26),
      preparedRegistrationSha256: requiredField(field, 27),
    },
    deadlines: {
      oldExitAt: numericField(field[28]),
      startAt: numericField(field[29]),
      verifyAt: numericField(field[30]),
      cleanupAt: numericField(field[31]),
    },
  } as const;
}

function parsePlan(content: Buffer): PortableHandoffPlan {
  const parsed = readPlanFields(content);
  const field = parsed.fields;
  const common = parseCommonPlanFields(field);
  const target = common.target;
  if (parsed.version === 2) {
    if (target !== "linux-x64" && target !== "macos-arm64" && target !== "macos-x64")
      fail("portable handoff plan is malformed");
    return createPortableHandoffPlan({ ...common, target });
  }
  if (target !== "windows-x64") fail("portable handoff plan is malformed");
  return createPortableHandoffPlan({
    ...common,
    target,
    cutoverKind: requiredField(field, 32) as "windows-generation-v1",
    currentGenerationTreeSha256: requiredField(field, 33),
    candidateGenerationTreeSha256: requiredField(field, 34),
    currentSetupManifestSha256: requiredField(field, 35),
    candidateSetupManifestSha256: requiredField(field, 36),
  });
}

export function readPortableHandoffPlan(
  stateDir: string,
  activationId: string,
): PortableHandoffPlan {
  const root = assertSafeHandoffTree(stateDir, activationId);
  const path = join(root, PLAN_FILE);
  const digestPath = join(root, PLAN_DIGEST_FILE);
  const content = readBoundedRegularFile(path, MAX_PLAN_BYTES, "portable handoff plan");
  const digestContent = readBoundedRegularFile(digestPath, 65, "portable handoff digest").toString(
    "latin1",
  );
  if (!/^[a-f0-9]{64}\n$/u.test(digestContent)) fail("portable handoff plan digest mismatch");
  const expected = digestContent.slice(0, 64);
  const actual = createHash("sha256").update(content).digest("hex");
  if (!HEX_SHA256.test(expected) || expected !== actual)
    fail("portable handoff plan digest mismatch");
  const plan = parsePlan(content);
  if (!encodePortableHandoffPlan(plan).equals(content))
    fail("portable handoff plan is not canonical");
  if (plan.activationId !== activationId) fail("portable handoff activation id mismatch");
  return plan;
}

export function discardPortableHandoffPreparation(stateDir: string, activationId: string): void {
  const root = portableHandoffRoot(stateDir, activationId);
  rmSync(root, { recursive: true, force: true });
}
