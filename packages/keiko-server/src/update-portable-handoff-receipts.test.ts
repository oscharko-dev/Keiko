import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendPortableHandoffReceipt,
  portableHandoffVerifiedAckMatches,
  publishPortableHandoffVerifiedAck,
  readPortableHandoffReceipts,
} from "./update-portable-handoff-receipts.js";

const roots: string[] = [];

function receiptPath(stateDir: string, activationId: string, sequence = 1): string {
  return join(
    stateDir,
    "updates",
    "handoff",
    activationId,
    "receipts",
    `${String(sequence).padStart(6, "0")}.khr`,
  );
}

function replaceReceiptField(content: Buffer, fieldIndex: number, replacement: Buffer): Buffer {
  const fields: Buffer[] = [];
  let offset = 8;
  for (let index = 0; index < content.readUInt16LE(6); index += 1) {
    const length = content.readUInt32LE(offset);
    offset += 4;
    fields.push(index === fieldIndex ? replacement : content.subarray(offset, offset + length));
    offset += length;
  }
  return Buffer.concat([
    content.subarray(0, 8),
    ...fields.flatMap((field) => {
      const length = Buffer.alloc(4);
      length.writeUInt32LE(field.length);
      return [length, field];
    }),
  ]);
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("portable handoff receipts", () => {
  it("publishes one exact idempotent post-CAS verification acknowledgement", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-handoff-receipts-"));
    roots.push(stateDir);
    const activationId = "a".repeat(32);
    const planSha256 = "b".repeat(64);
    appendPortableHandoffReceipt({
      stateDir,
      activationId,
      planSha256,
      kind: "prepared",
      outcome: "completed",
      at: 1,
    });
    publishPortableHandoffVerifiedAck({ stateDir, activationId, planSha256 });
    publishPortableHandoffVerifiedAck({ stateDir, activationId, planSha256 });
    expect(portableHandoffVerifiedAckMatches({ stateDir, activationId, planSha256 })).toBe(true);
    expect(
      readFileSync(join(stateDir, "updates", "handoff", activationId, "verified.ack")),
    ).toStrictEqual(Buffer.from(`KHV1${planSha256}\n`, "ascii"));
  });

  it("refuses a mismatched existing verification acknowledgement", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-handoff-receipts-"));
    roots.push(stateDir);
    const activationId = "a".repeat(32);
    appendPortableHandoffReceipt({
      stateDir,
      activationId,
      planSha256: "b".repeat(64),
      kind: "prepared",
      outcome: "completed",
      at: 1,
    });
    writeFileSync(
      join(stateDir, "updates", "handoff", activationId, "verified.ack"),
      `KHV1${"c".repeat(64)}\n`,
    );
    expect(() => {
      publishPortableHandoffVerifiedAck({
        stateDir,
        activationId,
        planSha256: "b".repeat(64),
      });
    }).toThrow(/does not match/u);
  });

  it("reconciles an exact two-link acknowledgement left by a publication crash", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-handoff-receipts-"));
    roots.push(stateDir);
    const activationId = "a".repeat(32);
    const planSha256 = "b".repeat(64);
    appendPortableHandoffReceipt({
      stateDir,
      activationId,
      planSha256,
      kind: "prepared",
      outcome: "completed",
      at: 1,
    });
    const root = join(stateDir, "updates", "handoff", activationId);
    const temporary = join(root, ".verified-ack-42.tmp");
    const destination = join(root, "verified.ack");
    writeFileSync(temporary, `KHV1${planSha256}\n`);
    linkSync(temporary, destination);

    publishPortableHandoffVerifiedAck({ stateDir, activationId, planSha256 });

    expect(existsSync(temporary)).toBe(false);
    expect(lstatSync(destination).nlink).toBe(1);
    expect(portableHandoffVerifiedAckMatches({ stateDir, activationId, planSha256 })).toBe(true);
  });

  it.each([
    ["mismatched", ".verified-ack-42.tmp", "c"],
    ["foreign", ".foreign-ack.tmp", "b"],
  ])("refuses and preserves a %s two-link acknowledgement", (_label, name, digestByte) => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-handoff-receipts-"));
    roots.push(stateDir);
    const activationId = "a".repeat(32);
    const planSha256 = "b".repeat(64);
    appendPortableHandoffReceipt({
      stateDir,
      activationId,
      planSha256,
      kind: "prepared",
      outcome: "completed",
      at: 1,
    });
    const root = join(stateDir, "updates", "handoff", activationId);
    const temporary = join(root, name);
    const destination = join(root, "verified.ack");
    writeFileSync(temporary, `KHV1${digestByte.repeat(64)}\n`);
    linkSync(temporary, destination);

    expect(() => {
      publishPortableHandoffVerifiedAck({ stateDir, activationId, planSha256 });
    }).toThrow(/does not match/u);
    expect(existsSync(temporary)).toBe(true);
    expect(lstatSync(destination).nlink).toBe(2);
  });

  it("rejects a restore tail after any target verification evidence", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-handoff-receipts-"));
    roots.push(stateDir);
    const activationId = "a".repeat(32);
    const planSha256 = "b".repeat(64);
    const forward = [
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
    ] as const;
    let previousSha256: string | undefined;
    for (const [kind, outcome] of forward) {
      const appended = appendPortableHandoffReceipt({
        stateDir,
        activationId,
        planSha256,
        kind,
        outcome,
        at: 1,
        ...(previousSha256 === undefined ? {} : { previousSha256 }),
      });
      previousSha256 = appended.sha256;
    }
    expect(() =>
      appendPortableHandoffReceipt({
        stateDir,
        activationId,
        planSha256,
        kind: "restore",
        outcome: "intent",
        at: 2,
        previousSha256,
      }),
    ).toThrow(/order/u);
  });

  it("persists an ordered, hash-chained intent/completion journal", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-handoff-receipts-"));
    roots.push(stateDir);
    const activationId = "a".repeat(32);
    const planSha256 = "b".repeat(64);
    const first = appendPortableHandoffReceipt({
      stateDir,
      activationId,
      planSha256,
      kind: "prepared",
      outcome: "completed",
      at: 1,
    });
    const second = appendPortableHandoffReceipt({
      stateDir,
      activationId,
      planSha256,
      kind: "old-exit",
      outcome: "intent",
      at: 2,
      previousSha256: first.sha256,
    });

    expect(second.sequence).toBe(2);
    expect(readPortableHandoffReceipts(stateDir, activationId)).toStrictEqual([
      first.receipt,
      second.receipt,
    ]);
  });

  it("refuses gaps and an incorrect previous receipt digest", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-handoff-receipts-"));
    roots.push(stateDir);
    const base = {
      stateDir,
      activationId: "a".repeat(32),
      planSha256: "b".repeat(64),
      kind: "promote" as const,
      outcome: "intent" as const,
      at: 1,
    };
    expect(() => appendPortableHandoffReceipt({ ...base, previousSha256: "c".repeat(64) })).toThrow(
      /previous/u,
    );
  });

  it("rejects oversized, symlink-rebound, and over-count receipt journals", () => {
    const activationId = "a".repeat(32);
    const planSha256 = "b".repeat(64);
    const oversizedState = mkdtempSync(join(tmpdir(), "keiko-handoff-receipts-"));
    roots.push(oversizedState);
    appendPortableHandoffReceipt({
      stateDir: oversizedState,
      activationId,
      planSha256,
      kind: "prepared",
      outcome: "completed",
      at: 1,
    });
    writeFileSync(receiptPath(oversizedState, activationId), Buffer.alloc(4097));
    expect(() => readPortableHandoffReceipts(oversizedState, activationId)).toThrow(/unsafe/u);

    const symlinkState = mkdtempSync(join(tmpdir(), "keiko-handoff-receipts-"));
    roots.push(symlinkState);
    appendPortableHandoffReceipt({
      stateDir: symlinkState,
      activationId,
      planSha256,
      kind: "prepared",
      outcome: "completed",
      at: 1,
    });
    const symlinkReceipt = receiptPath(symlinkState, activationId);
    const foreign = join(symlinkState, "foreign.khr");
    writeFileSync(foreign, readFileSync(symlinkReceipt));
    rmSync(symlinkReceipt);
    symlinkSync(foreign, symlinkReceipt);
    expect(() => readPortableHandoffReceipts(symlinkState, activationId)).toThrow(/unsafe/u);

    const overCountState = mkdtempSync(join(tmpdir(), "keiko-handoff-receipts-"));
    roots.push(overCountState);
    appendPortableHandoffReceipt({
      stateDir: overCountState,
      activationId,
      planSha256,
      kind: "prepared",
      outcome: "completed",
      at: 1,
    });
    for (let sequence = 2; sequence <= 16; sequence += 1) {
      writeFileSync(receiptPath(overCountState, activationId, sequence), "");
    }
    expect(() => readPortableHandoffReceipts(overCountState, activationId)).toThrow(/too many/u);
  });

  it.each([
    [2, "01"],
    [2, "+1"],
    [2, "1e0"],
    [5, "01"],
  ])("rejects noncanonical numeric field %i value %s", (fieldIndex, value) => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-handoff-receipts-"));
    roots.push(stateDir);
    const activationId = "a".repeat(32);
    appendPortableHandoffReceipt({
      stateDir,
      activationId,
      planSha256: "b".repeat(64),
      kind: "prepared",
      outcome: "completed",
      at: 1,
    });
    const path = receiptPath(stateDir, activationId);
    writeFileSync(path, replaceReceiptField(readFileSync(path), fieldIndex, Buffer.from(value)));
    expect(() => readPortableHandoffReceipts(stateDir, activationId)).toThrow(/malformed/u);
  });
});
