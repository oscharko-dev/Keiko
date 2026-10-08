import {
  chmodSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    rmSync: vi.fn(actual.rmSync),
  };
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
  readonly write: (correlationId?: string, pid?: number, host?: "127.0.0.1" | "localhost") => void;
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
    write: (correlationId, pid = 42, host): void => {
      writeBrowserOpenRequest(stateDir, pid, launchId, correlationId, host);
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

it("keeps the empty exclusive publication window silent until the actual request arrives", async () => {
  const subject = fixture();
  writeFileSync(join(subject.stateDir, "ui.browser-open"), "", { mode: 0o600 });
  subject.poll();
  expect(subject.events).toEqual([]);
  subject.write();
  subject.poll();
  await vi.waitFor(
    () => {
      expect(subject.open).toHaveBeenCalledTimes(1);
    },
    { timeout: 10_000 },
  );
});

it("joins each distinct mismatched request to its own validated requester", () => {
  const subject = fixture();
  const parents = ["00000000-0000-4000-8000-000000000081", "00000000-0000-4000-8000-000000000082"];
  for (const parent of parents) {
    subject.write(parent, 41);
    subject.poll();
    expect(existsSync(join(subject.stateDir, "ui.browser-open"))).toBe(false);
    subject.poll();
  }
  expect(subject.events).toHaveLength(2);
  subject.events.forEach((event, index) => {
    const line = formatActivityLogProofLine(event);
    expectActivityLogProof("cli.lifecycle.browser-handoff.outcome", line);
    expect(JSON.parse(line)).toMatchObject({
      outcome: "refused",
      reason: "identity-mismatch",
      parentCorrelationId: parents[index],
      level: "info",
    });
  });
  expect(subject.open).not.toHaveBeenCalled();
});

it("logs a removal fault once per actual request without opening or leaking its body", () => {
  const subject = fixture();
  const parent = "00000000-0000-4000-8000-000000000083";
  subject.write(parent);
  const fail = (): never => {
    throw Object.assign(new Error(`PRIVATE_REMOVE ${subject.stateDir}`), { code: "EACCES" });
  };
  for (let index = 0; index < 3; index += 1) {
    vi.mocked(rmSync).mockImplementationOnce(fail);
    subject.poll();
  }
  expect(subject.events).toHaveLength(1);
  const line = formatActivityLogProofLine(subject.events[0] ?? {});
  expectActivityLogProof("cli.lifecycle.browser-handoff.outcome", line);
  expect(JSON.parse(line)).toMatchObject({
    outcome: "failed",
    parentCorrelationId: parent,
    failureKind: "EACCES",
  });
  expect(line).not.toContain("PRIVATE_REMOVE");
  expect(line).not.toContain(subject.stateDir);
  expect(subject.open).not.toHaveBeenCalled();
  subject.write("00000000-0000-4000-8000-000000000084");
  vi.mocked(rmSync).mockImplementationOnce(fail);
  subject.poll();
  expect(subject.events).toHaveLength(2);
});

it.each(["invalid-request", "unsafe-request"] as const)(
  "proves %s fields through the actual formatter",
  (reason) => {
    const subject = fixture();
    subject.write();
    if (reason === "invalid-request")
      writeFileSync(join(subject.stateDir, "ui.browser-open"), "invalid\n");
    else chmodSync(join(subject.stateDir, "ui.browser-open"), 0o644);
    subject.poll();
    const line = formatActivityLogProofLine(subject.events[0] ?? {});
    expectActivityLogProof("cli.lifecycle.browser-handoff.outcome", line);
    expect(JSON.parse(line)).toMatchObject({ outcome: "refused", reason, level: "info" });
    expect(subject.open).not.toHaveBeenCalled();
  },
);

it("preserves localhost and records an opener failure under the real request parent", async () => {
  const subject = fixture();
  const parent = "00000000-0000-4000-8000-000000000085";
  subject.open.mockImplementationOnce(() => {
    throw new Error("PRIVATE_OPEN");
  });
  subject.write(parent, 42, "localhost");
  subject.poll();
  await vi.waitFor(
    () => {
      expect(subject.events).toHaveLength(1);
    },
    { timeout: 5_000 },
  );
  const line = formatActivityLogProofLine(subject.events[0] ?? {});
  expectActivityLogProof("cli.lifecycle.browser-handoff.outcome", line);
  expect(JSON.parse(line)).toMatchObject({
    outcome: "failed",
    parentCorrelationId: parent,
    attestationProvided: true,
  });
  expect(new URL(String(subject.open.mock.calls[0]?.[0])).hostname).toBe("localhost");
  expect(line).not.toContain("PRIVATE_OPEN");
  expect(line).not.toContain("keiko-app-session");
});
