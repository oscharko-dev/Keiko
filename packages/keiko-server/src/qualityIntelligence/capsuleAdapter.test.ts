// #3532: the Quality Intelligence capsule resolver used to swallow a knowledge-store open or read
// failure and degrade to an empty result with nothing in the log. It still degrades — the caller
// maps the empty result to QI_CAPSULE_UNAVAILABLE — but the failure now reaches the operator
// diagnostic path, under the caller's correlation id and with no content.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UiHandlerDeps } from "../deps.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import { makeCapsuleResolver } from "./capsuleAdapter.js";

const CORRELATION_ID = "qi-capsule-correlation-01";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-qi-capsule-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function resolverDeps(records: ServerDiagnosticRecord[]): UiHandlerDeps {
  const deps: Pick<UiHandlerDeps, "uiDbPath" | "diagnostics"> = {
    uiDbPath: join(root, "ui.db"),
    diagnostics: {
      record: (record): void => {
        records.push(record);
      },
    },
  };
  return deps as UiHandlerDeps;
}

describe("makeCapsuleResolver", () => {
  it("builds no resolver without a UI database path", () => {
    const deps: Pick<UiHandlerDeps, "uiDbPath"> = { uiDbPath: "" };
    expect(makeCapsuleResolver(deps as UiHandlerDeps)).toBeUndefined();
  });

  it("reports a knowledge store that cannot be opened once, then degrades to an empty result", () => {
    // A regular file where the knowledge-store directory belongs makes every open fail.
    writeFileSync(join(root, "local-knowledge"), "occupied");
    const records: ServerDiagnosticRecord[] = [];
    const resolver = makeCapsuleResolver(resolverDeps(records), CORRELATION_ID);

    expect(resolver?.capsule("capsule-1")).toEqual([]);
    expect(resolver?.capsuleSet("capsule-set-1")).toEqual([]);
    resolver?.close();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      correlationId: CORRELATION_ID,
      operation: "quality-intelligence.capsule-source",
      source: "qi.capsule-adapter",
      message: "Quality Intelligence could not open the knowledge store for a capsule source.",
    });
    expect(JSON.stringify(records)).not.toContain(root);
  });

  it("reports a failed read and returns an empty result", () => {
    const records: ServerDiagnosticRecord[] = [];
    const resolver = makeCapsuleResolver(resolverDeps(records), CORRELATION_ID);

    // An unknown capsule reads cleanly as empty: nothing to report.
    expect(resolver?.capsule("capsule-1")).toEqual([]);
    expect(records).toEqual([]);

    // A read against the closed store fails; the failure is reported, never thrown.
    resolver?.close();
    expect(resolver?.capsule("capsule-1")).toEqual([]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      correlationId: CORRELATION_ID,
      message: "Quality Intelligence could not read a capsule source from the knowledge store.",
    });
  });
});
