import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  portableHandoffRoot,
  syncPortableHandoffDirectory,
} from "./update-portable-handoff-plan.js";

const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const RECEIPT_NAME = /^(?<sequence>\d{6})\.khr$/u;
const RECEIPT_KINDS = new Set([
  "prepared",
  "old-exit",
  "promote",
  "register",
  "start",
  "verify",
  "restore",
  "restored-start",
  "restored-verify",
  "cleanup",
  "complete",
]);
const MAX_RECEIPT_BYTES = 4096;
const MAX_RECEIPTS = 15;
const VERIFIED_ACK_FILE = "verified.ack";
const VERIFIED_ACK_BYTES = 69;
const VERIFIED_ACK_TEMP = /^\.verified-ack-(?:[1-9]\d*)\.tmp$/u;
const MAX_HANDOFF_ROOT_ENTRIES = 32;

export type PortableHandoffReceiptKind =
  | "prepared"
  | "old-exit"
  | "promote"
  | "register"
  | "start"
  | "verify"
  | "restore"
  | "restored-start"
  | "restored-verify"
  | "cleanup"
  | "complete";

export interface PortableHandoffReceipt {
  readonly schemaVersion: 1;
  readonly activationId: string;
  readonly planSha256: string;
  readonly sequence: number;
  readonly kind: PortableHandoffReceiptKind;
  readonly outcome: "intent" | "completed";
  readonly at: number;
  readonly previousSha256?: string | undefined;
}

export class PortableHandoffReceiptError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PortableHandoffReceiptError";
  }
}

interface StableFileReadRules {
  readonly changedMessage: string;
  readonly expectedLinks: number;
  readonly isValidDescriptorSize: (size: number) => boolean;
  readonly isValidNamedSize: (size: number) => boolean;
  readonly unsafeMessage: string;
}

function readNamedSafeFile(path: string, rules: StableFileReadRules): Stats {
  let named: Stats;
  try {
    named = lstatSync(path);
  } catch {
    fail(rules.unsafeMessage);
  }
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== rules.expectedLinks ||
    !rules.isValidNamedSize(named.size)
  ) {
    fail(rules.unsafeMessage);
  }
  return named;
}

function openSafeReadDescriptor(path: string, rules: StableFileReadRules): number {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return fail(rules.unsafeMessage);
  }
}

function readDescriptorSnapshot(
  descriptor: number,
  named: Stats,
  rules: StableFileReadRules,
): Stats {
  const snapshot = fstatSync(descriptor);
  if (
    !snapshot.isFile() ||
    snapshot.nlink !== rules.expectedLinks ||
    !rules.isValidDescriptorSize(snapshot.size) ||
    snapshot.dev !== named.dev ||
    snapshot.ino !== named.ino
  ) {
    fail(rules.unsafeMessage);
  }
  return snapshot;
}

function readDescriptorBytes(descriptor: number, size: number, changedMessage: string): Buffer {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < content.length) {
    const count = readSync(descriptor, content, offset, content.length - offset, null);
    if (count === 0) fail(changedMessage);
    offset += count;
  }
  return content;
}

function snapshotMatches(snapshot: Stats, before: Stats, expectedLinks: number): boolean {
  return (
    snapshot.dev === before.dev &&
    snapshot.ino === before.ino &&
    snapshot.size === before.size &&
    snapshot.mtimeMs === before.mtimeMs &&
    snapshot.ctimeMs === before.ctimeMs &&
    snapshot.nlink === expectedLinks
  );
}

function assertReadPathUnchanged(
  path: string,
  descriptor: number,
  before: Stats,
  rules: StableFileReadRules,
): void {
  const after = fstatSync(descriptor);
  const current = lstatSync(path);
  if (
    !snapshotMatches(after, before, rules.expectedLinks) ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    !snapshotMatches(current, before, rules.expectedLinks)
  ) {
    fail(rules.changedMessage);
  }
}

function verifiedAckContent(planSha256: string): Buffer {
  if (!HEX_SHA256.test(planSha256)) fail("portable handoff verified acknowledgement is malformed");
  return Buffer.from(`KHV1${planSha256}\n`, "ascii");
}

function readVerifiedAck(path: string, expectedLinks = 1): Buffer {
  const rules: StableFileReadRules = {
    changedMessage: "portable handoff verified acknowledgement changed while reading",
    expectedLinks,
    isValidDescriptorSize: (size) => size === VERIFIED_ACK_BYTES,
    isValidNamedSize: (size) => size === VERIFIED_ACK_BYTES,
    unsafeMessage: "portable handoff verified acknowledgement is unsafe",
  };
  const named = readNamedSafeFile(path, rules);
  const descriptor = openSafeReadDescriptor(path, rules);
  try {
    const before = readDescriptorSnapshot(descriptor, named, rules);
    const content = readDescriptorBytes(descriptor, VERIFIED_ACK_BYTES, rules.changedMessage);
    assertReadPathUnchanged(path, descriptor, before, rules);
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function verifiedAckDestination(destination: string, expected: Buffer): Stats | undefined {
  let stat: Stats;
  try {
    stat = lstatSync(destination);
  } catch {
    return undefined;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 2 ||
    stat.size !== VERIFIED_ACK_BYTES ||
    !readVerifiedAck(destination, 2).equals(expected)
  ) {
    return undefined;
  }
  return stat;
}

function temporaryVerifiedAckNames(root: string): string[] {
  const directory = opendirSync(root);
  const candidates: string[] = [];
  let entries = 0;
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      entries += 1;
      if (entries > MAX_HANDOFF_ROOT_ENTRIES)
        fail("portable handoff verified acknowledgement directory is unsafe");
      if (VERIFIED_ACK_TEMP.test(entry.name)) candidates.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return candidates;
}

function isLinkedTemporaryVerifiedAck(root: string, name: string, destination: Stats): boolean {
  try {
    const candidate = lstatSync(join(root, name));
    return (
      candidate.isFile() &&
      !candidate.isSymbolicLink() &&
      candidate.nlink === 2 &&
      candidate.dev === destination.dev &&
      candidate.ino === destination.ino
    );
  } catch {
    return false;
  }
}

function linkedTemporaryVerifiedAck(root: string, destination: Stats): string | undefined {
  const matching = temporaryVerifiedAckNames(root).filter((name) =>
    isLinkedTemporaryVerifiedAck(root, name, destination),
  );
  if (matching.length !== 1) return undefined;
  return matching[0];
}

function reconcileLinkedVerifiedAck(root: string, destination: string, expected: Buffer): boolean {
  const destinationStat = verifiedAckDestination(destination, expected);
  if (destinationStat === undefined) return false;
  const temporary = linkedTemporaryVerifiedAck(root, destinationStat);
  if (temporary === undefined) return false;
  unlinkSync(join(root, temporary));
  syncPortableHandoffDirectory(root);
  return readVerifiedAck(destination).equals(expected);
}

function existingVerifiedAckMatches(root: string, destination: string, expected: Buffer): boolean {
  try {
    return readVerifiedAck(destination).equals(expected);
  } catch (error) {
    if (!(error instanceof PortableHandoffReceiptError)) throw error;
    return reconcileLinkedVerifiedAck(root, destination, expected);
  }
}

function removeTemporaryVerifiedAck(temporary: string, descriptor: number | undefined): void {
  if (descriptor !== undefined) closeSync(descriptor);
  try {
    unlinkSync(temporary);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

export function publishPortableHandoffVerifiedAck(input: {
  readonly stateDir: string;
  readonly activationId: string;
  readonly planSha256: string;
}): void {
  const root = portableHandoffRoot(input.stateDir, input.activationId);
  const destination = join(root, VERIFIED_ACK_FILE);
  const expected = verifiedAckContent(input.planSha256);
  if (existsSync(destination)) {
    if (!existingVerifiedAckMatches(root, destination, expected)) {
      fail("portable handoff verified acknowledgement does not match");
    }
    return;
  }
  const temporary = join(root, `.verified-ack-${String(process.pid)}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, expected);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, destination);
    syncPortableHandoffDirectory(root);
  } catch (error) {
    if (existsSync(destination) && readVerifiedAck(destination).equals(expected)) return;
    throw error;
  } finally {
    removeTemporaryVerifiedAck(temporary, descriptor);
  }
}

export function portableHandoffVerifiedAckMatches(input: {
  readonly stateDir: string;
  readonly activationId: string;
  readonly planSha256: string;
}): boolean {
  const path = join(portableHandoffRoot(input.stateDir, input.activationId), VERIFIED_ACK_FILE);
  return existsSync(path) && readVerifiedAck(path).equals(verifiedAckContent(input.planSha256));
}

function fail(message: string): never {
  throw new PortableHandoffReceiptError(message);
}

function receiptContent(receipt: PortableHandoffReceipt): Buffer {
  const fields = [
    receipt.activationId,
    receipt.planSha256,
    String(receipt.sequence),
    receipt.kind,
    receipt.outcome,
    String(receipt.at),
    receipt.previousSha256 ?? "",
  ].map((field) => Buffer.from(field, "utf8"));
  const header = Buffer.alloc(8);
  header.write("KHR1", 0, "ascii");
  header.writeUInt16LE(1, 4);
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

export function portableHandoffReceiptSha256(receipt: PortableHandoffReceipt): string {
  return createHash("sha256").update(receiptContent(receipt)).digest("hex");
}

function receiptRoot(stateDir: string, activationId: string): string {
  return join(portableHandoffRoot(stateDir, activationId), "receipts");
}

function assertReceiptIdentity(receipt: PortableHandoffReceipt): void {
  // Receipt bytes are untrusted despite the narrowed caller-facing type.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (receipt.schemaVersion !== 1 || !/^[a-f0-9]{32}$/u.test(receipt.activationId)) {
    fail("portable handoff receipt is malformed");
  }
  if (!HEX_SHA256.test(receipt.planSha256) || !RECEIPT_KINDS.has(receipt.kind)) {
    fail("portable handoff receipt is malformed");
  }
}

function assertReceiptSequence(receipt: PortableHandoffReceipt): void {
  if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) {
    fail("portable handoff receipt is malformed");
  }
  // Receipt bytes are untrusted despite the narrowed caller-facing type.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (receipt.outcome !== "intent" && receipt.outcome !== "completed") {
    fail("portable handoff receipt is malformed");
  }
  if (!Number.isSafeInteger(receipt.at) || receipt.at < 0) {
    fail("portable handoff receipt is malformed");
  }
}

function assertReceiptHeader(content: Buffer): void {
  if (
    content.length < 8 ||
    content.subarray(0, 4).toString("ascii") !== "KHR1" ||
    content.readUInt16LE(4) !== 1 ||
    content.readUInt16LE(6) !== 7 ||
    content.length > MAX_RECEIPT_BYTES
  ) {
    fail("portable handoff receipt is malformed");
  }
}

function receiptFields(content: Buffer): readonly string[] {
  assertReceiptHeader(content);
  const fields: string[] = [];
  let offset = 8;
  for (let index = 0; index < 7; index += 1) {
    if (offset + 4 > content.length) fail("portable handoff receipt is malformed");
    const length = content.readUInt32LE(offset);
    offset += 4;
    if (length > MAX_RECEIPT_BYTES || offset + length > content.length)
      fail("portable handoff receipt is malformed");
    try {
      fields.push(
        new TextDecoder("utf-8", { fatal: true }).decode(content.subarray(offset, offset + length)),
      );
    } catch {
      fail("portable handoff receipt is malformed");
    }
    offset += length;
  }
  if (offset !== content.length) fail("portable handoff receipt is malformed");
  return fields;
}

function requiredField(fields: readonly string[], index: number): string {
  const value = fields[index];
  if (value === undefined) fail("portable handoff receipt is malformed");
  return value;
}

function parseReceipt(content: Buffer): PortableHandoffReceipt {
  const fields = receiptFields(content);
  const previousSha256 = requiredField(fields, 6);
  const receipt = {
    schemaVersion: 1 as const,
    activationId: requiredField(fields, 0),
    planSha256: requiredField(fields, 1),
    sequence: canonicalNumber(requiredField(fields, 2)),
    kind: requiredField(fields, 3) as PortableHandoffReceiptKind,
    outcome: requiredField(fields, 4) as "intent" | "completed",
    at: canonicalNumber(requiredField(fields, 5)),
    ...(previousSha256 === "" ? {} : { previousSha256 }),
  };
  assertReceiptIdentity(receipt);
  assertReceiptSequence(receipt);
  if (receipt.previousSha256 !== undefined && !HEX_SHA256.test(receipt.previousSha256))
    fail("portable handoff receipt is malformed");
  if (!receiptContent(receipt).equals(content)) fail("portable handoff receipt is not canonical");
  return receipt;
}

function canonicalNumber(value: string): number {
  if (!/^(?:0|[1-9]\d{0,15})$/u.test(value)) fail("portable handoff receipt is malformed");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail("portable handoff receipt is malformed");
  return parsed;
}

function readReceipt(path: string): PortableHandoffReceipt {
  const rules: StableFileReadRules = {
    changedMessage: "portable handoff receipt changed while reading",
    expectedLinks: 1,
    isValidDescriptorSize: (size) => size <= MAX_RECEIPT_BYTES,
    isValidNamedSize: (size) => size >= 0 && size <= MAX_RECEIPT_BYTES,
    unsafeMessage: "portable handoff receipt is unsafe",
  };
  const named = readNamedSafeFile(path, rules);
  const descriptor = openSafeReadDescriptor(path, rules);
  try {
    const before = readDescriptorSnapshot(descriptor, named, rules);
    const content = readDescriptorBytes(descriptor, before.size, rules.changedMessage);
    assertReadPathUnchanged(path, descriptor, before, rules);
    return parseReceipt(content);
  } finally {
    closeSync(descriptor);
  }
}

function assertReceiptRoot(root: string): void {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    fail("portable handoff receipt path is unsafe");
}

function receiptNames(root: string): string[] {
  const directory = opendirSync(root);
  const names: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > MAX_RECEIPTS) fail("portable handoff has too many receipts");
    }
  } finally {
    directory.closeSync();
  }
  return names.sort((left, right) => left.localeCompare(right, "en-US"));
}

function readReceiptJournal(root: string, activationId: string): PortableHandoffReceipt[] {
  const receipts: PortableHandoffReceipt[] = [];
  let previousSha256: string | undefined;
  for (const [index, name] of receiptNames(root).entries()) {
    if (!RECEIPT_NAME.test(name)) fail("portable handoff receipt name is invalid");
    const receipt = readReceipt(join(root, name));
    if (receipt.activationId !== activationId || receipt.sequence !== index + 1)
      fail("portable handoff receipt sequence is invalid");
    if (receipt.previousSha256 !== previousSha256)
      fail("portable handoff previous receipt digest is invalid");
    previousSha256 = portableHandoffReceiptSha256(receipt);
    receipts.push(receipt);
  }
  return receipts;
}

export function readPortableHandoffReceipts(
  stateDir: string,
  activationId: string,
): readonly PortableHandoffReceipt[] {
  const root = receiptRoot(stateDir, activationId);
  if (!existsSync(root)) return [];
  assertReceiptRoot(root);
  return readReceiptJournal(root, activationId);
}

const ORDERED_RECEIPTS: readonly (readonly [PortableHandoffReceiptKind, "intent" | "completed"])[] =
  [
    ["prepared", "completed"],
    ["old-exit", "intent"],
    ["old-exit", "completed"],
    ["promote", "intent"],
    ["promote", "completed"],
    ["register", "intent"],
    ["register", "completed"],
    ["start", "intent"],
    ["start", "completed"],
    ["verify", "intent"],
    ["verify", "completed"],
    ["cleanup", "intent"],
    ["cleanup", "completed"],
    ["complete", "completed"],
  ];

const RESTORE_RECEIPTS: readonly (readonly [PortableHandoffReceiptKind, "intent" | "completed"])[] =
  [
    ["restore", "intent"],
    ["restore", "completed"],
    ["restored-start", "intent"],
    ["restored-start", "completed"],
    ["restored-verify", "intent"],
    ["restored-verify", "completed"],
  ];

function startsRestoration(receipt: PortableHandoffReceipt, restoring: boolean): boolean {
  return !restoring && receipt.kind === "restore" && receipt.outcome === "intent";
}

function assertRestorationCanStart(
  receipts: readonly PortableHandoffReceipt[],
  index: number,
): void {
  const verifiedTarget = receipts.slice(0, index).some((prior) => prior.kind === "verify");
  if (index < 3 || verifiedTarget) fail("portable handoff receipt order is invalid");
}

function assertExpectedReceipt(
  receipt: PortableHandoffReceipt,
  expected: readonly [PortableHandoffReceiptKind, "intent" | "completed"] | undefined,
  activationId: string,
  planSha256: string,
): void {
  if (
    expected === undefined ||
    receipt.activationId !== activationId ||
    receipt.planSha256 !== planSha256 ||
    receipt.kind !== expected[0] ||
    receipt.outcome !== expected[1]
  ) {
    fail("portable handoff receipt order is invalid");
  }
}

export function validatePortableHandoffReceiptSequence(input: {
  readonly activationId: string;
  readonly planSha256: string;
  readonly receipts: readonly PortableHandoffReceipt[];
}): void {
  let restoring = false;
  let restoreIndex = 0;
  for (const [index, receipt] of input.receipts.entries()) {
    if (startsRestoration(receipt, restoring)) {
      assertRestorationCanStart(input.receipts, index);
      restoring = true;
    }
    const expected = restoring ? RESTORE_RECEIPTS[restoreIndex++] : ORDERED_RECEIPTS[index];
    assertExpectedReceipt(receipt, expected, input.activationId, input.planSha256);
  }
}

interface PortableHandoffReceiptAppendInput {
  readonly activationId: string;
  readonly at: number;
  readonly kind: PortableHandoffReceiptKind;
  readonly outcome: "intent" | "completed";
  readonly planSha256: string;
  readonly previousSha256?: string | undefined;
  readonly stateDir: string;
}

function newReceipt(
  input: PortableHandoffReceiptAppendInput,
  sequence: number,
): PortableHandoffReceipt {
  return {
    schemaVersion: 1,
    activationId: input.activationId,
    planSha256: input.planSha256,
    sequence,
    kind: input.kind,
    outcome: input.outcome,
    at: input.at,
    ...(input.previousSha256 === undefined ? {} : { previousSha256: input.previousSha256 }),
  };
}

function persistReceipt(
  stateDir: string,
  activationId: string,
  receipt: PortableHandoffReceipt,
): void {
  const root = receiptRoot(stateDir, activationId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${String(receipt.sequence).padStart(6, "0")}.khr`);
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, receiptContent(receipt));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  syncPortableHandoffDirectory(root);
}

export function appendPortableHandoffReceipt(input: {
  readonly stateDir: string;
  readonly activationId: string;
  readonly planSha256: string;
  readonly kind: PortableHandoffReceiptKind;
  readonly outcome: "intent" | "completed";
  readonly at: number;
  readonly previousSha256?: string | undefined;
}): {
  readonly receipt: PortableHandoffReceipt;
  readonly sha256: string;
  readonly sequence: number;
} {
  const prior = readPortableHandoffReceipts(input.stateDir, input.activationId);
  const previous = prior.at(-1);
  const expectedPrevious =
    previous === undefined ? undefined : portableHandoffReceiptSha256(previous);
  if (input.previousSha256 !== expectedPrevious)
    fail("portable handoff previous receipt digest is invalid");
  const receipt = newReceipt(input, prior.length + 1);
  parseReceipt(receiptContent(receipt));
  validatePortableHandoffReceiptSequence({
    activationId: input.activationId,
    planSha256: input.planSha256,
    receipts: [...prior, receipt],
  });
  persistReceipt(input.stateDir, input.activationId, receipt);
  return {
    receipt,
    sha256: portableHandoffReceiptSha256(receipt),
    sequence: receipt.sequence,
  };
}
