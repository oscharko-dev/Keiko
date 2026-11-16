// Vitest setup: the process-wide vault key cache (`resolveLocalVaultKeyOnce`) must not carry a key
// from one test to the next. Tests reuse fixed vault directories and delete or rewrite keyfiles, and a
// remembered key would answer for a directory the test has just emptied.
//
// The module is imported inside the hook, never at setup time: a setup-time import would load it
// before a test file's own `vi.mock("node:fs")` is installed and silently bypass that mock.
import { beforeEach } from "vitest";

beforeEach(async () => {
  const { resetResolvedLocalVaultKeysForTest } =
    await import("@oscharko-dev/keiko-security/secret-vault");
  resetResolvedLocalVaultKeysForTest();
});
