import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSqliteStatePath, SqliteStatePathError } from "./fs-hardening.js";
import { plantDirectoryRedirect, plantSymlinkOrSkip } from "../../../tests/support/symlink-fixture.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const roots: string[] = [];
afterEach((): void => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function guardRoot(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-sqlite-guard-"));
  roots.push(root);
  return root;
}

function expectBodyFreeRefusal(root: string, path: string, danglingTarget: string): void {
  const events: object[] = [];
  expect((): void => {
    assertSqliteStatePath(path, {
      store: "ui",
      sink: {
        write: (event): void => {
          events.push(event);
        },
      },
    });
  }).toThrow(SqliteStatePathError);
  const persisted = expectActivityLogProof(
    "sqlite.state-path.refused.authority",
    formatActivityLogProofLine(events[0] ?? {}),
  );
  expect(persisted).toMatchObject({
    store: "ui",
    failureKind: "unsafe-target",
    errorKind: "permission-denied",
  });
  expect(JSON.stringify(persisted)).not.toContain(root);
  expect(existsSync(danglingTarget)).toBe(false);
}

describe("SQLite state path refusal evidence", (): void => {
  it("persists a body-free typed refusal without touching a dangling target", (context): void => {
    const root = guardRoot();
    const path = join(root, "keiko-ui.db");
    const target = join(root, "missing.db");
    plantSymlinkOrSkip(context, target, path);
    expectBodyFreeRefusal(root, path, target);
  });

  // The same refusal for a dangling directory redirection, which a Windows host can plant as a
  // junction without symlink privilege (a directory symlink elsewhere).
  it("persists a body-free typed refusal for a dangling directory redirection", (): void => {
    const root = guardRoot();
    const path = join(root, "keiko-ui.db");
    const target = join(root, "missing-directory");
    plantDirectoryRedirect(target, path);
    expectBodyFreeRefusal(root, path, target);
  });
});
