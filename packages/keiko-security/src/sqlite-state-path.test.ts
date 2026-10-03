import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSqliteStatePath, SqliteStatePathError } from "./fs-hardening.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const roots: string[] = [];
afterEach((): void => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("SQLite state path refusal evidence", (): void => {
  it("persists a body-free typed refusal without touching a dangling target", (): void => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-sqlite-guard-"));
    roots.push(root);
    const path = join(root, "keiko-ui.db");
    symlinkSync(join(root, "missing.db"), path);
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
  });
});
