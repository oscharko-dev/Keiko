// Test support for #3531: persisted Activity Log lines and segment files built through the
// production formatter, so every fixture line passes the same identity and registry validation the
// file sink applies. Nothing here restates a rule the code under test owns: lines come from
// `formatRegisteredServerLogLine`, names from `activityLogSegmentFileName`.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVITY_LOG_DIRECTORY_NAME,
  activityLogOperationSchema,
  activityLogSegmentFileName,
  attachActivityLogEventRegistration,
  type ActivityLogErrorKind,
  type ActivityLogSegmentIdentity,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  formatRegisteredServerLogLine,
  serverLogProcessIdentity,
  type ServerLogEvent,
} from "@oscharko-dev/keiko-server/observability/server-log";

export interface FixtureProcess {
  readonly pid: number;
  readonly instanceId: string;
  seq: number;
}

export function fixtureProcess(pid: number, instanceId: string): FixtureProcess {
  return { pid, instanceId, seq: 0 };
}

export interface FixtureEventInput {
  readonly op: string;
  readonly correlationId?: string | undefined;
  readonly parentCorrelationId?: string | undefined;
  readonly errorKind?: ActivityLogErrorKind | undefined;
  readonly level?: "debug" | "info" | "warn" | "error" | undefined;
  readonly fields?: Readonly<Record<string, unknown>> | undefined;
}

const DIGEST = "a".repeat(64);

// Required fields of the operations the fixtures use, filled with valid closed values.
const DEFAULT_FIELDS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "client.diagnostic": { clientNoteDigest: DIGEST },
  "cli.lifecycle.stop-requested": { channel: "sigterm" },
  "indexing.detached-run.launched": { capsuleIdDigest: DIGEST, jobIdMinted: true },
};

/** One persisted line (no newline), exactly as the production file sink formats it. */
export function fixtureLine(
  process: FixtureProcess,
  atMs: number,
  input: FixtureEventInput,
): string {
  const registration = activityLogOperationSchema(input.op);
  if (registration === undefined) throw new Error(`unregistered fixture operation ${input.op}`);
  const event = attachActivityLogEventRegistration(
    {
      level: input.level ?? "info",
      category: registration.category,
      op: input.op,
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      ...(input.parentCorrelationId === undefined
        ? {}
        : { parentCorrelationId: input.parentCorrelationId }),
      ...(input.errorKind === undefined ? {} : { errorKind: input.errorKind }),
      extra: {
        completeness: "complete",
        loss: "none",
        ...DEFAULT_FIELDS[input.op],
        ...input.fields,
      },
    },
    registration,
  );
  process.seq += 1;
  const line = formatRegisteredServerLogLine(event as ServerLogEvent, new Date(atMs), {
    ...serverLogProcessIdentity(),
    pid: process.pid,
    instanceId: process.instanceId,
    seq: process.seq,
  });
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

export interface FixtureSegmentOptions {
  readonly state?: "sealed" | "active" | undefined;
  // Bytes appended after the last terminated line: a crashed writer's torn tail.
  readonly tail?: string | undefined;
}

/** Writes one owner-private segment under `<stateDir>/logs/`; sealed segments end up 0400. */
export function writeFixtureSegment(
  stateDir: string,
  identity: ActivityLogSegmentIdentity,
  lines: readonly string[],
  options: FixtureSegmentOptions = {},
): string {
  const state = options.state ?? "sealed";
  const directory = join(stateDir, ACTIVITY_LOG_DIRECTORY_NAME);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, activityLogSegmentFileName(identity, state));
  const text = lines.map((line) => `${line}\n`).join("") + (options.tail ?? "");
  writeFileSync(path, text, { mode: 0o600 });
  if (state === "sealed") chmodSync(path, 0o400);
  return path;
}

export function segmentIdentity(
  process: FixtureProcess,
  startMs: number,
  index: number,
): ActivityLogSegmentIdentity {
  return { startMs, pid: process.pid, instanceId: process.instanceId, index };
}
