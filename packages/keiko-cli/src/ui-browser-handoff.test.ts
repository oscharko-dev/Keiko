import { mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CODING_APP_SESSION_LAUNCHER_SECRET_ENV } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { KEIKO_UI_LAUNCH_ID_ENV, writeBrowserOpenRequest } from "./state-paths.js";
import { createBrowserHandoffPoll } from "./ui-browser-handoff.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), readSync: vi.fn(actual.readSync) };
});

const directories: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function fixture(): {
  readonly stateDir: string;
  readonly events: readonly SecurityLogEvent[];
  readonly poll: () => void;
  readonly open: ReturnType<typeof vi.fn>;
  readonly write: () => void;
} {
  const stateDir = mkdtempSync(join(tmpdir(), "keiko-browser-request-failure-"));
  directories.push(stateDir);
  const events: SecurityLogEvent[] = [];
  const launchId = "ab".repeat(16);
  const open = vi.fn();
  return {
    stateDir,
    events,
    open,
    write: (): void => {
      writeBrowserOpenRequest(stateDir, 42, launchId);
    },
    poll: createBrowserHandoffPoll({
      stateDir,
      pid: 42,
      env: {
        [KEIKO_UI_LAUNCH_ID_ENV]: launchId,
        [CODING_APP_SESSION_LAUNCHER_SECRET_ENV]: "synthetic-launcher-secret",
      },
      baseUrl: "http://127.0.0.1:1983",
      io: { out: vi.fn(), err: vi.fn() },
      sink: { write: (event): void => void events.push(event) },
      openExternal: open,
    }),
  };
}

it.each(["open", "read"] as const)(
  "preserves the %s fault class on the single refused browser handoff without its body",
  (stage) => {
    const subject = fixture();
    subject.write();
    const error = Object.assign(new Error(`PRIVATE_FILE ${subject.stateDir} secret=value`), {
      code: stage === "open" ? "EACCES" : "EIO",
    });
    if (stage === "open")
      vi.mocked(openSync).mockImplementationOnce(() => {
        throw error;
      });
    else
      vi.mocked(readSync).mockImplementationOnce(() => {
        throw error;
      });
    subject.poll();
    expect(subject.open).not.toHaveBeenCalled();
    expect(subject.events).toHaveLength(1);
    const line = formatActivityLogProofLine(subject.events[0] ?? {});
    expectActivityLogProof("cli.lifecycle.browser-handoff.outcome", line);
    expect(JSON.parse(line)).toMatchObject({
      outcome: "refused",
      reason: "unsafe-request",
      failureKind: error.code,
    });
    expect(line).not.toContain("PRIVATE_FILE");
    expect(line).not.toContain(subject.stateDir);
    expect(line).not.toContain("secret=value");
  },
);

it("keeps an absent browser request silent and never opens the browser", () => {
  const subject = fixture();
  subject.poll();
  expect(subject.events).toEqual([]);
  expect(subject.open).not.toHaveBeenCalled();
});

it("records a changed technical cause while suppressing repeated identical refusals", () => {
  const subject = fixture();
  subject.write();
  vi.mocked(openSync).mockImplementationOnce(() => {
    throw Object.assign(new Error("PRIVATE_OPEN"), { code: "EACCES" });
  });
  subject.poll();
  for (let index = 0; index < 2; index += 1) {
    vi.mocked(readSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("PRIVATE_READ"), { code: "EIO" });
    });
    subject.poll();
  }
  expect(subject.events.map((event) => event.extra?.failureKind)).toEqual(["EACCES", "EIO"]);
  expect(subject.open).not.toHaveBeenCalled();
  expect(JSON.stringify(subject.events)).not.toContain("PRIVATE_");
});
