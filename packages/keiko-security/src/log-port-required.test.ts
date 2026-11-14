import { describe, expect, it } from "vitest";
import { atomicPublishRename, atomicPublishTreeSwap } from "./fs-atomic-rename.js";
import { readMacosKeychainSecret, writeMacosKeychainSecret } from "./macos-keychain.js";
import {
  attestPortableSidecarTreeSync,
  attestPortableTreeKht1Sync,
  hashPortableTreeKht1,
} from "./portable-tree-attestation.js";
import {
  createKeychainVaultKeyAccess,
  createLocalSecretVault,
  createShardedLocalSecretVault,
  resolveLocalVaultKey,
  resolveLocalVaultKeyOnce,
} from "./secret-vault.js";
import {
  inheritWindowsParentDacl,
  inspectWindowsOwnerPrivateFiles,
  protectWindowsOwnerPrivateFile,
} from "./windows-owner-private.js";
import { readWindowsProcessCommandLine } from "./windows-process-identity.js";

// #4351: a caller that named no sink lost its Activity Log line as an unwired port and made every
// support export read "degraded". The sink is a required field at these entry points, so a caller
// without one no longer compiles. Each directive below stops being valid, and the typecheck fails,
// the day a sink becomes optional here again. The function is never run.
describe("the log sink is required at the entry points the server and the CLI call (#4351)", () => {
  it("rejects a call that names no sink at compile time", () => {
    const callsWithoutASink = (): void => {
      // @ts-expect-error a keychain read without a sink loses its withheld and fallback lines
      readMacosKeychainSecret("svc", "acct", { platform: "darwin" });
      // @ts-expect-error a keychain write without a sink loses its withheld and fallback lines
      writeMacosKeychainSecret("svc", "acct", "value", { platform: "darwin" });
      // @ts-expect-error the DACL tool needs its options and with them a sink
      protectWindowsOwnerPrivateFile("path");
      // @ts-expect-error options without a sink are refused
      protectWindowsOwnerPrivateFile("path", {});
      // @ts-expect-error options without a sink are refused
      inheritWindowsParentDacl("path", {});
      // @ts-expect-error options without a sink are refused
      inspectWindowsOwnerPrivateFiles(["path"], {});
      // @ts-expect-error options without a sink are refused
      readWindowsProcessCommandLine(1, {});
      // @ts-expect-error a publish that names no sink loses its retry and failure lines
      atomicPublishRename("from", "to", {});
      // @ts-expect-error a tree swap that names no sink loses its retry and failure lines
      atomicPublishTreeSwap("from", "to", {});
      // @ts-expect-error a vault without a sink loses its merge and shard lines
      createLocalSecretVault({ key: Buffer.alloc(32), storePath: "store" });
      // @ts-expect-error a sharded vault without a sink loses its shard lines
      createShardedLocalSecretVault({ key: Buffer.alloc(32), storeDir: "dir" });
      // @ts-expect-error a key resolution without a sink loses its resolved and fallback lines
      resolveLocalVaultKey({
        env: {},
        vaultDir: "dir",
        envVarName: "E",
        keychainService: "s",
        keyfileName: "k",
      });
      // @ts-expect-error a key resolution without a sink loses its resolved and fallback lines
      resolveLocalVaultKeyOnce({
        env: {},
        vaultDir: "dir",
        envVarName: "E",
        keychainService: "s",
        keyfileName: "k",
      });
      // @ts-expect-error the keychain key access needs the sink it reports to
      createKeychainVaultKeyAccess("service");
      // @ts-expect-error an attestation without a sink loses its failure line
      attestPortableSidecarTreeSync("root", "path", 1);
      // @ts-expect-error an attestation without a sink loses its failure line
      attestPortableTreeKht1Sync("root", "a".repeat(64), 1);
      // @ts-expect-error an operation without a sink loses the failure line of the hash
      void hashPortableTreeKht1("root", {
        deadline: 1,
        now: Date.now,
        yieldControl: () => Promise.resolve(),
        signal: undefined,
      });
    };
    expect(typeof callsWithoutASink).toBe("function");
  });
});
