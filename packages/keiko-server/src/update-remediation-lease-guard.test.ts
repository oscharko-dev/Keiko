import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import { isDenied, resolveExistingAllowedWorkspaceRealRoot } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { createUpdateLocalStateManager } from "./update-local-state.js";

const roots: string[] = [];
const ACTION = "local-state-repair:memory-vault";

function setup(): {
  stateDir: string;
  guards: string;
  subject: ReturnType<typeof createUpdateLocalStateManager>;
  events: SecurityLogEvent[];
} {
  const stateDir = mkdtempSync(join(tmpdir(), "keiko-custom-update-state-"));
  roots.push(stateDir);
  const events: SecurityLogEvent[] = [];
  const subject = createUpdateLocalStateManager({
    stateDir,
    activityLog: {
      write: (event): void => {
        events.push(event);
      },
    },
  });
  return {
    stateDir,
    guards: join(stateDir, "updates", "remediation-leases", ".keiko", "guards"),
    subject,
    events,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function guardName(guards: string): string {
  const name = readdirSync(guards).find((entry) => entry.endsWith(".json"));
  expect(name).toBeTypeOf("string");
  if (name === undefined) throw new Error("Guard was not created");
  return name;
}

function legacyRecord(
  subject: ReturnType<typeof createUpdateLocalStateManager>,
  stateDir: string,
  guards: string,
): { path: string; bytes: Buffer } {
  const release = subject.acquireRemediationLease(ACTION);
  if (release === undefined) throw new Error("Producer control failed");
  const path = join(stateDir, "updates", "remediation-leases", guardName(guards));
  const bytes = readFileSync(path);
  release();
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path, bytes };
}

describe("remediation lease OS guard", () => {
  it.skipIf(process.platform === "win32" || process.geteuid?.() === 0)(
    "retains an unreadable legacy record from a genuinely live current instance",
    () => {
      const { stateDir, guards, subject } = setup();
      const { path, bytes } = legacyRecord(subject, stateDir, guards);
      const now = Date.parse("2026-10-19T12:00:00.000Z");
      utimesSync(path, new Date(now - 5_000), new Date(now - 5_000));
      const observer = createUpdateLocalStateManager({
        stateDir,
        now: () => now,
        remediationLeaseStaleMs: 1_000,
      });
      try {
        chmodSync(path, 0);
        expect(() => observer.acquireRemediationLease(ACTION)).toThrow();
      } finally {
        chmodSync(path, 0o600);
      }
      expect(readFileSync(path)).toEqual(bytes);
      expect(readdirSync(join(stateDir, "updates", "remediation-leases"))).not.toEqual(
        expect.arrayContaining([expect.stringContaining(".corrupt.")]),
      );
      expect(observer.acquireRemediationLease(ACTION)).toBeUndefined();
    },
  );

  it.each([
    { size: 4_096, refused: false },
    { size: 4_097, refused: true },
  ])(
    "bounds canonical lease reads at $size bytes without reclaiming an unknown owner",
    ({ size, refused }) => {
      const { stateDir, guards, subject } = setup();
      const { path, bytes } = legacyRecord(subject, stateDir, guards);
      const padded = Buffer.alloc(size, 0x20);
      bytes.copy(padded);
      writeFileSync(path, padded);
      if (refused) expect(() => subject.acquireRemediationLease(ACTION)).toThrow();
      else expect(subject.acquireRemediationLease(ACTION)).toBeUndefined();
      expect(readFileSync(path)).toEqual(padded);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a real FIFO without blocking and retains a real child positive control",
    () => {
      const { stateDir, guards, subject } = setup();
      const { path } = legacyRecord(subject, stateDir, guards);
      rmSync(path);
      expect(spawnSync("mkfifo", [path], { timeout: 5_000, killSignal: "SIGKILL" }).status).toBe(0);
      const probe = `
        const { createUpdateLocalStateManager } = await import(process.argv[1]);
        let state;
        try {
          const release = createUpdateLocalStateManager({stateDir:process.argv[2]})
            .acquireRemediationLease("local-state-repair:memory-vault");
          state = release ? "granted" : "held";
          release?.();
        } catch { state = "refused"; }
        process.stdout.write(state + "\\n");`;
      const args = [
        "--input-type=module",
        "--eval",
        probe,
        new URL("../dist/update-local-state.js", import.meta.url).href,
        stateDir,
      ];
      const options = { timeout: 5_000, killSignal: "SIGKILL" as const, encoding: "utf8" as const };
      const fifo = spawnSync(process.execPath, args, options);
      expect(fifo.status).toBe(0);
      expect(fifo.stdout).toBe("refused\n");
      rmSync(path);
      const positive = spawnSync(process.execPath, args, options);
      expect(positive.status).toBe(0);
      expect(positive.stdout).toBe("granted\n");
    },
  );

  it
    .skipIf(process.platform === "win32" || process.geteuid?.() === 0)
    .each(["read", "rename"] as const)(
    "retains a failed %s release and retries only that own release",
    (kind) => {
      const { stateDir, guards, subject, events } = setup();
      const release = subject.acquireRemediationLease(ACTION);
      const leases = join(stateDir, "updates", "remediation-leases");
      const canonical = join(leases, guardName(guards));
      const before = readFileSync(canonical, "utf8");
      let next: (() => void) | undefined;
      try {
        chmodSync(kind === "read" ? canonical : leases, kind === "read" ? 0 : 0o500);
        expect(() => release?.()).toThrow();
        expect(events.at(-1)?.extra?.state).toBe("failed");
        expect(
          createUpdateLocalStateManager({ stateDir }).acquireRemediationLease(ACTION),
        ).toBeUndefined();
        chmodSync(leases, 0o700);
        chmodSync(canonical, 0o600);
        expect(readFileSync(canonical, "utf8")).toBe(before);
        next = subject.acquireRemediationLease(ACTION);
        expect(next).toEqual(expect.any(Function));
        release?.();
        expect(
          createUpdateLocalStateManager({ stateDir }).acquireRemediationLease(ACTION),
        ).toBeUndefined();
      } finally {
        chmodSync(leases, 0o700);
        if (existsSync(canonical)) chmodSync(canonical, 0o600);
        release?.();
        next?.();
      }
    },
  );

  it("keeps guards below the existing denied boundary even with a custom state root", () => {
    const { stateDir, guards, subject } = setup();
    const release = subject.acquireRemediationLease(ACTION);
    try {
      expect(isDenied(stateDir)).toBe(false);
      expect(isDenied(join(guards, guardName(guards)))).toBe(true);
      expect(() => resolveExistingAllowedWorkspaceRealRoot(nodeWorkspaceFs, guards)).toThrow();
      const alias = join(stateDir, "ordinary-folder");
      symlinkSync(guards, alias, "junction");
      expect(() => resolveExistingAllowedWorkspaceRealRoot(nodeWorkspaceFs, alias)).toThrow();
    } finally {
      release?.();
    }
  });

  it("holds a stable private zero-data guard until release and preserves a later owner", () => {
    const { stateDir, guards, subject, events } = setup();
    const release = subject.acquireRemediationLease(ACTION, "guard-first");
    expect(release).toEqual(expect.any(Function));
    const names = readdirSync(guards);
    const path = join(guards, guardName(guards));
    expect(names.sort()).toEqual([guardName(guards), `${guardName(guards)}-journal`]);
    expect(statSync(`${path}-journal`).isFile()).toBe(true);
    expect(statSync(`${path}-journal`).size).toBeGreaterThan(0);
    const before = statSync(path);
    expect(before.size).toBe(0);
    const peer = createUpdateLocalStateManager({ stateDir });
    expect(peer.acquireRemediationLease(ACTION)).toBeUndefined();
    using contention = new DatabaseSync(path);
    expect(() => {
      contention.exec("BEGIN IMMEDIATE");
    }).toThrow(expect.objectContaining({ errcode: 5 }));
    release?.();
    const next = peer.acquireRemediationLease(ACTION);
    expect(next).toEqual(expect.any(Function));
    release?.();
    expect(subject.acquireRemediationLease(ACTION)).toBeUndefined();
    next?.();
    expect(readdirSync(guards)).toEqual([guardName(guards)]);
    expect(statSync(path).ino).toBe(before.ino);
    expect(statSync(path).size).toBe(0);
    expect(events.map((event) => event.extra?.state)).toEqual(["acquired", "released", "busy"]);
    expect(events[0]).toMatchObject({ correlationId: "guard-first" });
    expect(JSON.stringify(events)).not.toContain(ACTION);
    expect(JSON.stringify(events)).not.toContain(stateDir);
  });

  it("allows unrelated remediation actions concurrently", () => {
    const { subject } = setup();
    const first = subject.acquireRemediationLease(ACTION);
    const second = subject.acquireRemediationLease("local-state-repair:local-knowledge");
    try {
      expect(first).toEqual(expect.any(Function));
      expect(second).toEqual(expect.any(Function));
    } finally {
      first?.();
      second?.();
    }
  });

  it("closes its failed-admission guard without changing a fresh malformed record", () => {
    const { stateDir, guards, subject, events } = setup();
    const release = subject.acquireRemediationLease(ACTION);
    release?.();
    const name = guardName(guards);
    const canonical = join(stateDir, "updates", "remediation-leases", name);
    writeFileSync(canonical, "{");
    expect(subject.acquireRemediationLease(ACTION)).toBeUndefined();
    expect(readFileSync(canonical, "utf8")).toBe("{");
    using peer = new DatabaseSync(join(guards, name));
    expect(() => {
      peer.exec("BEGIN IMMEDIATE; ROLLBACK");
    }).not.toThrow();
    expect(events.at(-1)?.extra?.state).toBe("owner-held");
  });

  it.each(["symlink", "hardlink", "corrupt"] as const)(
    "refuses a %s guard without recreating or quarantining it",
    (kind) => {
      const { stateDir, guards, subject, events } = setup();
      const release = subject.acquireRemediationLease(ACTION);
      release?.();
      const name = guardName(guards);
      const path = join(guards, name);
      rmSync(path);
      const target = join(stateDir, "target");
      writeFileSync(target, "not-a-database");
      if (kind === "symlink") symlinkSync(target, path);
      else if (kind === "hardlink") linkSync(target, path);
      else writeFileSync(path, "not-a-database");
      expect(() => subject.acquireRemediationLease(ACTION)).toThrow();
      expect(readFileSync(target, "utf8")).toBe("not-a-database");
      expect(existsSync(path)).toBe(true);
      expect(readdirSync(guards)).toEqual([name]);
      expect(events.at(-1)?.extra?.state).toBe("failed");
    },
  );

  it("keeps authority when the Activity Log sink fails", () => {
    const { stateDir } = setup();
    const record = vi.fn();
    const subject = createUpdateLocalStateManager({
      stateDir,
      activityLog: {
        write: (): never => {
          throw new Error("private content");
        },
      },
      diagnostics: { record },
    });
    const release = subject.acquireRemediationLease(ACTION, "guard-log-failure");
    try {
      expect(release).toEqual(expect.any(Function));
      expect(
        createUpdateLocalStateManager({ stateDir }).acquireRemediationLease(ACTION),
      ).toBeUndefined();
      expect(record).toHaveBeenCalled();
      expect(JSON.stringify(record.mock.calls)).not.toContain("private content");
    } finally {
      release?.();
    }
  });
});
