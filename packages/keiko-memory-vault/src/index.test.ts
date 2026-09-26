// Public-surface regression pins for the package barrel (Epic #204 child #206; ADR-0019 trust
// rule 7 — this file is the SOLE entry point).

import { describe, expect, it } from "vitest";
import * as memoryVault from "./index.js";

describe("public surface (Finding: Thread 6 — no write-capable vault entry points)", () => {
  it("re-exports the read-only diagnostic seam used by keiko-server's fingerprint collector", () => {
    expect(typeof memoryVault.resolveVaultKeyReadOnly).toBe("function");
    expect(typeof memoryVault.openMemoryDatabaseReadOnly).toBe("function");
    expect(typeof memoryVault.computeStoreFingerprint).toBe("function");
    expect(typeof memoryVault.createMemoryVault).toBe("function");
  });

  // `resolveVaultKey` can mint and persist `vault.key`; `openMemoryDatabase` can migrate,
  // re-encrypt, or quarantine-and-reopen a store. Neither is imported by any package outside this
  // one (verified against the full repo before this fix), so neither belongs on the public barrel
  // external callers reach through. RED (before fix): both properties were present on the
  // namespace object, so both assertions below failed with `true`, not `false`.
  it("does not export the mutating resolveVaultKey/openMemoryDatabase primitives", () => {
    expect("resolveVaultKey" in memoryVault).toBe(false);
    expect("openMemoryDatabase" in memoryVault).toBe(false);
  });
});
