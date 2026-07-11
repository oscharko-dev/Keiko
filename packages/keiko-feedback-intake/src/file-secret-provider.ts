import {
  constants,
  lstatSync,
  fstatSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  fsyncSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  DAY_MS,
  type IntakeSecretKey,
  type IntakeSecretProvider,
  type IntakeSecretSnapshot,
} from "./types.js";

type KeyKind = "abuse" | "dedupe";
interface KeyDeletionEvent {
  readonly keyClass: KeyKind;
  readonly keyId: string;
  readonly timestamp: Date;
}
export type PendingKeyDeletionEvidence = KeyDeletionEvent & { readonly result: "pending" };
export type DestroyedKeyDeletionEvidence = KeyDeletionEvent & { readonly result: "destroyed" };
export type KeyDeletionEvidence = PendingKeyDeletionEvidence | DestroyedKeyDeletionEvidence;
export interface KeyDeletionLedger {
  pendingDeletions(keyClass: KeyKind): Promise<readonly PendingKeyDeletionEvidence[]>;
  beginDeletion(evidence: PendingKeyDeletionEvidence): Promise<void>;
  completeDeletion(evidence: DestroyedKeyDeletionEvidence): Promise<void>;
}
interface KeyFile extends IntakeSecretKey {
  readonly path: string;
}

export interface FileSecretProviderOptions {
  readonly directory: string;
  readonly kind: KeyKind;
  readonly now: () => Date;
}

const MAX_KEY_FILE_BYTES = 512;
const FILE_NAME = /^[a-z0-9-]+\.json$/u;

function within(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function secureDirectory(path: string): string {
  const original = lstatSync(path);
  if (!original.isDirectory() || original.isSymbolicLink() || (original.mode & 0o077) !== 0) {
    throw new Error("Feedback secret custody is unavailable");
  }
  const resolved = realpathSync(path);
  const stats = lstatSync(resolved);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0 ||
    stats.dev !== original.dev ||
    stats.ino !== original.ino
  ) {
    throw new Error("Feedback secret custody is unavailable");
  }
  return resolved;
}

function secureFileStats(stats: Stats): boolean {
  return (
    stats.isFile() &&
    (stats.mode & 0o077) === 0 &&
    stats.size > 0 &&
    stats.size <= MAX_KEY_FILE_BYTES
  );
}

function readSecureKey(
  root: string,
  name: string,
): { readonly path: string; readonly value: unknown } {
  if (!FILE_NAME.test(name)) throw new Error("Feedback secret custody is unavailable");
  const candidate = resolve(root, name);
  if (!within(root, candidate)) throw new Error("Feedback secret custody is unavailable");
  const original = lstatSync(candidate);
  if (original.isSymbolicLink()) throw new Error("Feedback secret custody is unavailable");
  let descriptor: number | undefined;
  let value: unknown;
  try {
    if (typeof constants.O_NOFOLLOW !== "number") {
      throw new Error("Feedback secret custody is unavailable");
    }
    descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(descriptor);
    if (!secureFileStats(stats) || stats.dev !== original.dev || stats.ino !== original.ino) {
      throw new Error("Feedback secret custody is unavailable");
    }
    value = JSON.parse(readFileSync(descriptor, "utf8"));
  } catch {
    throw new Error("Feedback secret custody is unavailable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return { path: candidate, value };
}

function parseKey(root: string, name: string, kind: KeyKind): KeyFile {
  const { path, value } = readSecureKey(root, name);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Feedback secret custody is unavailable");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "activatedAt,id,key") {
    throw new Error("Feedback secret custody is unavailable");
  }
  const activatedAt = new Date(String(record.activatedAt));
  const id = String(record.id);
  const expectedId = `${kind === "dedupe" ? "dedupe-v1:" : ""}${activatedAt.toISOString().slice(0, 10)}`;
  if (
    !Number.isFinite(activatedAt.getTime()) ||
    activatedAt.toISOString().slice(11) !== "00:00:00.000Z" ||
    id !== expectedId
  ) {
    throw new Error("Feedback secret custody is unavailable");
  }
  return { id, activatedAt, key: keyBytes(record.key), path };
}

function keyBytes(value: unknown): Uint8Array {
  if (typeof value !== "string") throw new Error("Feedback secret custody is unavailable");
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    throw new Error("Feedback secret custody is unavailable");
  }
  return Uint8Array.from(decoded);
}

function snapshot(key: KeyFile): IntakeSecretKey {
  return { id: key.id, activatedAt: new Date(key.activatedAt), key: Uint8Array.from(key.key) };
}

export class FileSecretProvider implements IntakeSecretProvider {
  private readonly root: string;
  constructor(private readonly options: FileSecretProviderOptions) {
    this.root = secureDirectory(options.directory);
    this.assertReady(options.now());
  }

  private files(): readonly KeyFile[] {
    const names = readdirSync(this.root);
    const maximum = this.options.kind === "abuse" ? 2 : 3;
    if (names.length === 0 || names.length > maximum) {
      throw new Error("Feedback secret custody is unavailable");
    }
    const keys = names.map((name) => parseKey(this.root, name, this.options.kind));
    if (new Set(keys.map((key) => key.id)).size !== keys.length) {
      throw new Error("Feedback secret custody is unavailable");
    }
    return keys.sort((left, right) => left.activatedAt.getTime() - right.activatedAt.getTime());
  }

  private active(now: Date, keys: readonly KeyFile[]): KeyFile {
    const active = keys.filter((key) => key.activatedAt <= now).at(-1);
    const cadence = this.options.kind === "abuse" ? DAY_MS : 90 * DAY_MS;
    if (active === undefined || active.activatedAt.getTime() + cadence <= now.getTime()) {
      throw new Error("Feedback secret custody is unavailable");
    }
    return active;
  }

  private assertReadyKeys(now: Date, keys: readonly KeyFile[]): void {
    if (keys.some((key) => key.activatedAt > now)) {
      throw new Error("Feedback secret custody is unavailable");
    }
    const active = this.active(now, keys);
    const cadence = this.options.kind === "abuse" ? DAY_MS : 90 * DAY_MS;
    const predecessors = keys.filter((key) => key.activatedAt < active.activatedAt).reverse();
    const exactCadence = predecessors.every(
      (key, index) =>
        active.activatedAt.getTime() - key.activatedAt.getTime() === cadence * (index + 1),
    );
    if (!exactCadence || (this.options.kind === "abuse" && predecessors.length !== 1)) {
      throw new Error("Feedback secret custody is unavailable");
    }
  }

  assertReady(now: Date): void {
    this.assertReadyKeys(now, this.files());
  }

  snapshot(now: Date): IntakeSecretSnapshot {
    const keys = this.files();
    this.assertReadyKeys(now, keys);
    const active = this.active(now, keys);
    const maximum = this.options.kind === "abuse" ? 1 : 2;
    const predecessors = keys
      .filter((key) => key.activatedAt < active.activatedAt)
      .slice(-maximum)
      .reverse()
      .map(snapshot);
    return { active: snapshot(active), predecessors };
  }

  private destroy(keyId: string): Promise<void> {
    const key = this.files().find((candidate) => candidate.id === keyId);
    if (key !== undefined) unlinkSync(key.path);
    const descriptor = openSync(this.root, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (this.files().some((candidate) => candidate.id === keyId)) {
      throw new Error("Feedback secret custody is unavailable");
    }
    return Promise.resolve();
  }

  async purgeRetired(
    now: Date,
    keyInUse: (keyId: string) => Promise<boolean>,
    ledger: KeyDeletionLedger,
  ): Promise<void> {
    for (const evidence of await ledger.pendingDeletions(this.options.kind)) {
      await this.destroy(evidence.keyId);
      await ledger.completeDeletion({
        ...evidence,
        timestamp: this.options.now(),
        result: "destroyed",
      });
    }
    const keys = this.files();
    const active = keys.at(-1);
    if (active === undefined) throw new Error("Feedback secret custody is unavailable");
    const retained = this.options.kind === "abuse" ? 2 * DAY_MS : 270 * DAY_MS;
    const retired = keys.filter(
      (key) =>
        key.activatedAt < active.activatedAt &&
        key.activatedAt.getTime() + retained <= now.getTime(),
    );
    for (const key of retired) {
      if (await keyInUse(key.id)) continue;
      const evidence: PendingKeyDeletionEvidence = {
        keyClass: this.options.kind,
        keyId: key.id,
        timestamp: now,
        result: "pending",
      };
      await ledger.beginDeletion(evidence);
      await this.destroy(key.id);
      await ledger.completeDeletion({ ...evidence, result: "destroyed" });
    }
  }
}
