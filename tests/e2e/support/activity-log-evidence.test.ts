import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_LOG_STORE_POLICY_FILE_NAME,
  activityLogSegmentFileName,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { copyActivityLogEvidence } from "./activity-log-evidence.js";

// #4355: the Activity Log of a failed end-to-end run is copied beside the Playwright evidence. The copy
// is an allowlist, so the uploaded directory holds nothing but Activity Log segments.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function sandbox(): {
  readonly source: string;
  readonly destination: string;
  readonly root: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-log-evidence-")));
  roots.push(root);
  const source = join(root, "state", "logs");
  mkdirSync(source, { recursive: true });
  return { source, destination: join(root, "out", "activity-log"), root };
}
const segment = (index: number, state: "active" | "sealed"): string =>
  activityLogSegmentFileName(
    { startMs: 1_700_000_000_000, pid: 4242, instanceId: "eb9c9fb3", index },
    state,
  );

describe("copyActivityLogEvidence", () => {
  it("copies Activity Log segments, sealed and active, and nothing else of the directory", () => {
    const { source, destination } = sandbox();
    writeFileSync(join(source, segment(1, "sealed")), '{"op":"a"}\n');
    writeFileSync(join(source, segment(2, "active")), '{"op":"b"}\n');
    writeFileSync(join(source, ACTIVITY_LOG_STORE_POLICY_FILE_NAME), '{"policy":true}');
    writeFileSync(join(source, "ui.db"), "chat store");
    writeFileSync(join(source, "keiko.config.json"), '{"apiKey":"synthetic"}');
    writeFileSync(join(source, "notes.txt"), "not a segment");
    expect(copyActivityLogEvidence(source, destination)).toMatchObject({ copied: 2, skipped: 4 });
    expect(readdirSync(destination).sort()).toEqual(
      [segment(1, "sealed"), segment(2, "active")].sort(),
    );
  });

  it("skips a segment name that is a link, and a directory", () => {
    const { source, destination, root } = sandbox();
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "outside");
    symlinkSync(secret, join(source, segment(3, "sealed")));
    mkdirSync(join(source, segment(4, "sealed")));
    expect(copyActivityLogEvidence(source, destination)).toMatchObject({ copied: 0, skipped: 2 });
    expect(() => readdirSync(destination)).toThrow();
  });

  it("copies nothing from a directory that is itself a link", () => {
    const { source, destination, root } = sandbox();
    writeFileSync(join(source, segment(1, "sealed")), "x");
    const link = join(root, "linked");
    symlinkSync(source, link);
    expect(copyActivityLogEvidence(link, destination)).toMatchObject({ copied: 0 });
  });

  it("keeps the byte bound: a segment that would exceed it is not copied", () => {
    const { source, destination } = sandbox();
    writeFileSync(join(source, segment(1, "sealed")), "0123456789");
    writeFileSync(join(source, segment(2, "sealed")), "0123456789");
    expect(copyActivityLogEvidence(source, destination, 15)).toMatchObject({
      copied: 1,
      skipped: 1,
      bytes: 10,
    });
  });

  it("is a no-op when the run wrote no log", () => {
    const { source, destination } = sandbox();
    rmSync(source, { recursive: true });
    expect(copyActivityLogEvidence(source, destination)).toEqual({
      copied: 0,
      skipped: 0,
      bytes: 0,
    });
  });
});

describe("the governed Jira Chat browser run keeps its failure evidence (#4355)", () => {
  const config = readFileSync(
    new URL("../config/playwright.jira-chat-4081.config.ts", import.meta.url),
    "utf8",
  );
  it("records a trace for a failed test and copies the Activity Log after the run", () => {
    expect(config).toContain('trace: "retain-on-failure"');
    expect(config).toContain("globalTeardown");
    expect(config).toContain("jira-chat-4081-teardown.ts");
    expect(config).toContain(
      'process.env.KEIKO_QUALIFICATION_ACTIVITY_LOG_DIR = join(directory, "logs")',
    );
  });
});
