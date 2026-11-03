import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activityLogOperationSchema } from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import { afterEach, describe, expect, it } from "vitest";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { CodingRuntimeLaunchRejectedError } from "./launchFailure.js";
import { nativeLinkedFilesField } from "./opencodeNativeLinkedFiles.js";

describe("nativeLinkedFilesField", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function workspaceWithLink(): { readonly workspace: string; readonly linked: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-linked-field-")));
    created.push(root);
    const workspace = join(root, "PRIVATE_WORKSPACE");
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "ordinary.ts"), "export const ordinary = 1;\n");
    writeFileSync(join(root, "outside.txt"), "OUTSIDE\n");
    const linked = join(workspace, "src", "linked.ts");
    linkSync(join(root, "outside.txt"), linked);
    return { workspace, linked };
  }

  function sink(): { readonly events: ServerLogEvent[]; write(event: ServerLogEvent): void } {
    const events: ServerLogEvent[] = [];
    return { events, write: (event) => events.push(event) };
  }

  it("names the linked files for the kernel profile and records counts only", () => {
    const { workspace, linked } = workspaceWithLink();
    const log = sink();
    expect(nativeLinkedFilesField(log, "run-linked-0001", [workspace])).toEqual({
      linkedFiles: [linked],
    });
    expect(log.events).toHaveLength(1);
    expect(log.events[0]).toMatchObject({ level: "info", correlationId: "run-linked-0001" });
    expect(JSON.stringify(log.events)).not.toContain("PRIVATE_WORKSPACE");
  });

  it("adds no field for a workspace without a linked file", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-linked-field-")));
    created.push(root);
    expect(nativeLinkedFilesField(sink(), "run-linked-0002", [root])).toEqual({});
  });

  it("refuses the launch when the scan is not complete, and warns with its closed outcome", () => {
    for (const outcome of ["excessive", "incomplete"] as const) {
      const log = sink();
      let refused: unknown;
      try {
        nativeLinkedFilesField(log, "run-linked-0003", ["/workspace"], () => ({
          outcome,
          scannedFileCount: 7,
          gitObjectLinkCount: 0,
        }));
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(CodingRuntimeLaunchRejectedError);
      expect(refused).toMatchObject({
        failureCode: "workspace-unqualified",
        reason: outcome === "excessive" ? "linked-files-excessive" : "linked-files-unscanned",
      });
      expect(log.events[0]).toMatchObject({ level: "warn", errorKind: "conflict" });
    }
  });

  it("records an unclassified scan failure with its frames and refuses the launch", () => {
    const log = sink();
    expect(() =>
      nativeLinkedFilesField(log, "run-linked-0005", ["/workspace"], () => {
        throw new Error("EIO-like failure");
      }),
    ).toThrow(CodingRuntimeLaunchRejectedError);
    expect(log.events[0]).toMatchObject({
      level: "warn",
      errorKind: "conflict",
      extra: { outcome: "incomplete" },
    });
    expect(log.events[0]?.extra?.frames).toEqual(expect.any(Array));
  });

  it.skipIf(activityLogOperationSchema("coding-runtime.linked-files.resolved") === undefined)(
    "persists the scan through the registered production sink with closed fields",
    () => {
      const { workspace } = workspaceWithLink();
      const log = sink();
      nativeLinkedFilesField(log, "run-linked-0004", [workspace]);
      const line = expectActivityLogProof(
        "coding-runtime.linked-files.resolved.emitted-line",
        formatActivityLogProofLine(log.events[0] ?? {}),
      );
      expect(line).toMatchObject({
        op: "coding-runtime.linked-files.resolved",
        correlationId: "run-linked-0004",
        outcome: "complete",
        rootCount: 1,
        scannedFileCount: 2,
        linkedFileCount: 1,
        gitObjectLinkCount: 0,
      });
      expect(JSON.stringify(line)).not.toContain("PRIVATE_WORKSPACE");
    },
  );
});
