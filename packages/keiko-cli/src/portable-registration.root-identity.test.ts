import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  portableInstallRootFoldedSha256,
  portableInstallRootIdentityForRemoval,
  portableInstallRootIdentitySha256,
} from "./portable-registration.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function base(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-root-identity-")));
  roots.push(root);
  return root;
}

it("gives a root that is gone the identity it had while it existed", () => {
  const parent = base();
  const root = join(parent, "Programs", "Keiko");
  mkdirSync(root, { recursive: true });
  const recorded = portableInstallRootIdentitySha256(root);
  rmSync(root, { recursive: true });
  expect(portableInstallRootIdentityForRemoval(root)).toBe(recorded);
  rmSync(join(parent, "Programs"), { recursive: true });
  expect(portableInstallRootIdentityForRemoval(root)).toBe(recorded);
});

// Windows paths differ only in letter case across the places a root is recorded: the folded identity
// is the same for every spelling, the exact one is not.
it("folds the letter case of the folded identity only", () => {
  const parent = base();
  const root = join(parent, "Programs", "Keiko");
  const other = join(parent, "programs", "KEIKO");
  expect(portableInstallRootFoldedSha256(root)).toBe(
    portableInstallRootFoldedSha256(root.toLowerCase()),
  );
  expect(portableInstallRootFoldedSha256(other)).toBe(
    portableInstallRootFoldedSha256(root.replace("Programs", "programs").replace("Keiko", "KEIKO")),
  );
  expect(portableInstallRootIdentityForRemoval(root)).not.toBe(
    portableInstallRootIdentityForRemoval(root.toLowerCase()),
  );
});
