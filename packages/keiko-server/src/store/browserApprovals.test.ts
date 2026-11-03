import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROWSER_APPROVAL_MAX_RECORDS,
  BROWSER_APPROVAL_REMEMBER_TTL_MS,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { createInMemoryUiStore, createNodeUiStore } from "./index.js";
import type { BrowserApprovalStore, StoredBrowserApproval } from "./browserApprovals.js";

function record(index = 0): StoredBrowserApproval {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
    format: "jwk",
  });
  if (key.x === undefined || key.y === undefined) throw new Error("Missing public point");
  return {
    approvalId: `bra_${index.toString(16).padStart(32, "0")}`,
    publicKey: { x: key.x, y: key.y },
    origin: "http://127.0.0.1:1983",
    approvedAtMs: 1_000,
    expiresAtMs: 2_000,
    lastUsedAtMs: 1_000,
  };
}

function approvals(store: ReturnType<typeof createInMemoryUiStore>): BrowserApprovalStore {
  if (store.browserApprovals === undefined) throw new Error("Missing approval store");
  return store.browserApprovals;
}

describe("private UI store browser approvals", () => {
  it("retains installation identity and only approved public data after reopen and directory relocation", () => {
    const parent = mkdtempSync(join(realpathSync(tmpdir()), "keiko-browser-store-"));
    const moved = `${parent}-moved`;
    const first = createNodeUiStore(join(parent, "ui.db"));
    const value = record();
    let identity: string;
    try {
      identity = approvals(first).installationId();
      expect(approvals(first).insert(value)).toBe(true);
    } finally {
      first.close();
    }
    try {
      renameSync(parent, moved);
      const reopened = createNodeUiStore(join(moved, "ui.db"));
      try {
        expect(approvals(reopened).installationId()).toBe(identity);
        expect(approvals(reopened).list()).toEqual([value]);
        expect(approvals(reopened).touch(value.approvalId, 1_100)).toBe(true);
        expect(approvals(reopened).touch(value.approvalId, 1_099)).toBe(false);
        expect(approvals(reopened).touch(value.approvalId, value.expiresAtMs)).toBe(false);
        expect(approvals(reopened).list().at(0)?.expiresAtMs).toBe(value.expiresAtMs);
        expect(approvals(reopened).remove(value.approvalId)).toBe(true);
      } finally {
        reopened.close();
      }
      const revoked = createNodeUiStore(join(moved, "ui.db"));
      try {
        expect(approvals(revoked).list()).toEqual([]);
      } finally {
        revoked.close();
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
    }
  });

  it("refuses a full grant inventory without evicting active approvals", () => {
    const uiStore = createInMemoryUiStore();
    try {
      const store = approvals(uiStore);
      for (let index = 0; index < BROWSER_APPROVAL_MAX_RECORDS; index += 1)
        expect(store.insert(record(index))).toBe(true);
      const original = store.list();
      expect(store.insert(record(BROWSER_APPROVAL_MAX_RECORDS))).toBe(false);
      expect(store.list()).toEqual(original);
      const replacement = {
        ...record(100),
        approvedAtMs: 2_000,
        lastUsedAtMs: 2_000,
        expiresAtMs: 3_000,
      };
      expect(store.insert(replacement)).toBe(true);
      expect(store.list()).toEqual([replacement]);
    } finally {
      uiStore.close();
    }
  });

  it.each([
    { approvalId: "forged" },
    { origin: "http://127.0.0.1:1983/private" },
    { expiresAtMs: Number.NaN },
    { expiresAtMs: 1_000 + BROWSER_APPROVAL_REMEMBER_TTL_MS + 1 },
    { lastUsedAtMs: 999 },
    { lastUsedAtMs: 2_000 },
  ])("refuses malformed persisted authority: %j", (patch) => {
    const uiStore = createInMemoryUiStore();
    try {
      const store = approvals(uiStore);
      expect(() => store.insert({ ...record(), ...patch })).toThrow(TypeError);
      expect(store.list()).toEqual([]);
    } finally {
      uiStore.close();
    }
  });
});
