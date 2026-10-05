import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import * as incidentStore from "../../packages/keiko-activity-log/src/support-incident-store.js";
import { occupySupportIncidentRetentionForTests } from "./activity-log-test-support.js";

const roots: string[] = [];
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-retention-fixture-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("rejects an unbounded fixture policy before making incident files", () => {
  vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", undefined);
  const claim = vi.spyOn(incidentStore, "claimSupportIncidentSlot").mockReturnValue(true);
  const root = fixtureRoot();
  expect(() => occupySupportIncidentRetentionForTests(root)).toThrow(RangeError);
  expect(claim).not.toHaveBeenCalled();
  expect(readdirSync(root)).toEqual([]);
});
it("reserves the real small fixture policy capacity", () => {
  vi.stubEnv("KEIKO_LOG_RETENTION_BYTES", "65536");
  const root = fixtureRoot();
  const capacity = occupySupportIncidentRetentionForTests(root);
  expect(capacity).toBeGreaterThan(0);
  expect(incidentStore.listSupportIncidentClaims(root)).toHaveLength(capacity);
  expect(existsSync(root)).toBe(true);
});
