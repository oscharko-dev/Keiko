import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { expect, it } from "vitest";
import { assertManagedRootAllowed } from "../../packages/keiko-cli/src/portable-root-policy.js";

// The private home answers `homedir()` inside a test process. The portable install suites place
// their managed roots under it, so it must satisfy the product's own root policy: outside every
// temporary directory and every repository (#4271, CI red on portable.test.ts and the launch smoke).
it("answers a private home that the managed install root policy admits", () => {
  const home = homedir();
  expect(home).not.toBe(process.env.HOME);
  expect(home.startsWith(realpathSync(tmpdir()))).toBe(false);
  const root = join(home, ".keiko-test-roots", "portable-root");
  expect(() => {
    assertManagedRootAllowed(root, join(home, ".keiko"), "linux-x64");
  }).not.toThrow();
});
