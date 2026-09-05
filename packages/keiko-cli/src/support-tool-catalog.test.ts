import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileServerLogSink } from "@oscharko-dev/keiko-server";
import {
  validateToolLifecycleEvent,
  redactLogFields,
} from "@oscharko-dev/keiko-server/runtime/tool-catalog-lifecycle";
import * as lazyModules from "./lazy-modules.js";
import { runSupportCli } from "./support.js";
import type { ToolCatalogLogEvidence } from "./support-tool-catalog.js";
import { defaultServerDiagnosticSink } from "../../keiko-server/src/diagnostics-log.js";
import { formatServerLogLine } from "../../keiko-server/src/observability/server-log.js";
import { catalogToolFixture } from "../../keiko-server/src/tool-catalog/__fixtures__/catalogToolFixture.js";
import { createCatalogToolBinder } from "../../keiko-server/src/tool-catalog/catalogToolDispatch.js";
import type { CatalogToolBinderInput } from "../../keiko-server/src/tool-catalog/catalogToolPorts.js";
import {
  analyzeLogText,
  buildReproductionSeed,
  findTimeline,
  renderHumanReproductionSeed,
  renderHumanTimeline,
} from "./support-analyze.js";

const ANALYZE_OPTIONS = {
  toolLifecycleValidator: validateToolLifecycleEvent,
  toolDiagnosticRedactor: redactLogFields,
};
const GENERATED = new Date("2026-09-05T01:00:00.000Z");
type Fixture = ReturnType<typeof catalogToolFixture>;

async function emittedLog(
  configure?: (fixture: Fixture) => CatalogToolBinderInput,
  qualified = true,
  sinkFailure?: "primary" | "auxiliary",
): Promise<{ text: string; fixture: Fixture }> {
  const directory = mkdtempSync(join(tmpdir(), "keiko-tool-support-"));
  const sink = createFileServerLogSink(directory, { level: "debug" });
  vi.stubEnv("KEIKO_STATE_DIR", directory);
  try {
    const fixture = catalogToolFixture();
    const input = configure?.(fixture) ?? fixture.input;
    const failedSink = {
      write: (): void => {
        throw new TypeError("private-sink-body", { cause: new RangeError("private-cause-body") });
      },
    };
    const binder = createCatalogToolBinder(
      {
        ...input,
        logPort: {
          primary: sinkFailure === "primary" ? failedSink : sink,
          auxiliary: sinkFailure === "auxiliary" ? failedSink : fixture.primary,
          diagnostics: defaultServerDiagnosticSink,
        },
      },
      {
        ...fixture.options,
        context: () => ({ ...fixture.context, parentCorrelationId: "parent-1" }),
      },
    );
    const offer = binder.offer();
    sink.write({ category: "http", op: "request", correlationId: "other-request", status: 204 });
    await binder.dispatch(
      qualified
        ? {
            kind: "bound",
            toolRef: fixture.handler.toolRef,
            projectionDigest: offer.binding.projectionDigest,
            offerId: offer.offerId,
            arguments: { path: "fixture.ts" },
          }
        : { privateInput: "secret-body" },
      { actionId: "action-1", idempotencyKey: "key-1" },
    );
    sink.close?.();
    return { text: readFileSync(join(directory, "logs", "server.log"), "utf8"), fixture };
  } finally {
    sink.close?.();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
}

function seedFor(text: string): NonNullable<ReturnType<typeof buildReproductionSeed>> {
  const seed = buildReproductionSeed(text, "correlation-1", GENERATED, ANALYZE_OPTIONS);
  if (seed === undefined) throw new Error("Expected emitted correlation timeline");
  return seed;
}

function settlement(
  seed: ReturnType<typeof seedFor>,
): Extract<ToolCatalogLogEvidence, { kind: "lifecycle" }> {
  const terminal = seed.toolCatalog?.find(
    (entry) => entry.kind === "lifecycle" && entry.event.op === "tool-catalog.invocation-settled",
  );
  if (terminal?.kind !== "lifecycle") throw new Error("Expected actual terminal evidence");
  return terminal;
}

describe("tool catalog reconstruction from actual emitted activity log", () => {
  it("retains qualified tool identity, committed receipt and correlation joins", async () => {
    const { text, fixture } = await emittedLog();
    const seed = seedFor(text);
    const terminal = settlement(seed);
    expect(terminal.event).toMatchObject({
      op: "tool-catalog.invocation-settled",
      status: "completed",
      reason: "none",
      toolRef: fixture.handler.toolRef,
      projectionDigest: fixture.pure.projection.projectionDigest,
      correlationId: "correlation-1",
      parentCorrelationId: "parent-1",
    });
    expect(terminal.receipt).toMatchObject({ budgetDisposition: "committed", effectStarted: true });
    expect(seed.timeline.every((line) => line.pid !== undefined && line.seq !== undefined)).toBe(
      true,
    );
    expect(JSON.stringify(seed)).not.toMatch(/fixture-result|private-capability|secret-body/u);
    expect(renderHumanReproductionSeed(seed)).toContain("toolCatalog:");
    const all = analyzeLogText(text, ANALYZE_OPTIONS);
    const timeline = findTimeline(all, "correlation-1");
    expect(timeline).toBeDefined();
    if (timeline === undefined) throw new Error("Expected catalog timeline");
    expect(renderHumanTimeline(timeline)).toContain("budgetDisposition");
    expect(findTimeline(all, "other-request")?.lines[0]?.status).toBe(204);
  });

  it("restores only permitted redactor omissions for unqualified rejection", async () => {
    const { text } = await emittedLog(undefined, false);
    const terminal = settlement(seedFor(text));
    expect(terminal.event).toMatchObject({ toolRef: null, status: "invalid" });
    expect(terminal.receipt).toMatchObject({
      reservationId: null,
      budgetDisposition: "not-reserved",
    });
    expect(terminal.restoredFields).toEqual(expect.arrayContaining(["toolRef", "reservationId"]));
  });

  it.each(["commit", "release"] as const)(
    "keeps %s acknowledgement uncertainty explicit",
    async (operation) => {
      const { text } = await emittedLog((fixture) => ({
        ...fixture.input,
        budgetPort: {
          ...fixture.input.budgetPort,
          [operation]: (): never => {
            throw new Error("secret-ack");
          },
        },
        handlerBindings:
          operation === "commit"
            ? [fixture.handler]
            : [
                {
                  ...fixture.handler,
                  execute: (): Promise<never> => Promise.reject(new Error("private-body")),
                },
              ],
      }));
      const terminal = settlement(seedFor(text));
      expect(terminal.event).toMatchObject({ status: "failed", reason: "budget-port-failed" });
      expect(terminal.receipt).toMatchObject({
        budgetDisposition: `${operation}-uncertain`,
        effectStarted: operation === "commit",
      });
      expect(JSON.stringify(seedFor(text))).not.toMatch(/secret-ack|private-body/u);
    },
  );
});

describe("tool lifecycle sink and corrupted artifact reconstruction", () => {
  it.each(["primary", "auxiliary"] as const)(
    "distinguishes the actual %s sink failure",
    async (sink) => {
      const { text } = await emittedLog(undefined, true, sink);
      const seed = seedFor(text);
      expect(seed.toolCatalog?.find((entry) => entry.kind === "sink-failure")).toMatchObject({
        kind: "sink-failure",
        sink,
        errorKind: "TypeError",
        diagnostics: "validated",
        causeChain: ["RangeError"],
      });
      expect(seed.warnings.join(" ")).toContain(
        "absent records do not prove successful persistence",
      );
      expect(JSON.stringify(seed)).not.toMatch(/private-sink-body|private-cause-body/u);
      expect(seed.causeChain).toContain("RangeError");
      expect(seed.stackFrames?.some((frame) => frame.includes("catalogToolLifecycle.ts:"))).toBe(
        true,
      );
      const terminals = seed.toolCatalog?.filter(
        (entry) => entry.kind === "lifecycle" && entry.receipt !== undefined,
      );
      expect(terminals).toHaveLength(sink === "primary" ? 0 : 1);
    },
  );

  it.each([
    { toolRef: null },
    { toolRef: undefined },
    { reservationId: undefined },
    { budgetDisposition: "commit-uncertain" },
    { status: "committed" },
    { inputBytes: -1 },
    { arguments: { secret: "private-body" } },
    { profile: { id: "private/body", version: 1 } },
  ])("fails closed on corrupted emitted terminal fields %j", async (patch) => {
    const { text } = await emittedLog();
    const changed = text
      .trim()
      .split("\n")
      .map((line) => {
        const value = JSON.parse(line) as Record<string, unknown>;
        return JSON.stringify(
          value.op === "tool-catalog.invocation-settled" ? { ...value, ...patch } : value,
        );
      })
      .join("\n");
    const seed = seedFor(changed);
    expect(seed.toolCatalog).toContainEqual({
      kind: "invalid",
      operation: "tool-catalog.invocation-settled",
      reason: "invalid-lifecycle-evidence",
    });
    expect(seed.warnings.join(" ")).toContain("invalid tool lifecycle evidence");
    expect(JSON.stringify(seed)).not.toContain("private-body");
    expect(JSON.stringify(seed)).not.toContain("private/body");
  });

  it("retains observed uncertainty without treating its acknowledgement as committed", async () => {
    const { text } = await emittedLog();
    const damaged = text
      .trim()
      .split("\n")
      .map((line) => {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (value.op !== "tool-catalog.invocation-settled") return line;
        return JSON.stringify({
          ...value,
          status: "failed",
          reason: "budget-port-failed",
          errorKind: "Error",
          budgetDisposition: "commit-uncertain",
        });
      })
      .join("\n");
    const seed = seedFor(damaged);
    expect(seed.warnings.join(" ")).toContain("do not infer a committed or released reservation");
  });

  it("uses actual process ordering and permits unrelated interleaved request sequences", async () => {
    const { text, fixture } = await emittedLog();
    const reversed = text.trim().split("\n").reverse().join("\n");
    const timeline = findTimeline(analyzeLogText(reversed, ANALYZE_OPTIONS), "correlation-1");
    const sequences = timeline?.lines.map((line) => line.seq) ?? [];
    expect(sequences).toEqual([...sequences].sort((a, b) => Number(a) - Number(b)));
    expect(seedFor(reversed).warnings.join(" ")).not.toMatch(/sequence gap/iu);
    const events = fixture.primary.events;
    const first = events[0];
    const second = events[1];
    if (first === undefined || second === undefined)
      throw new Error("Expected actual lifecycle events");
    const record = (event: typeof first, instanceId: string, seq: number): string =>
      formatServerLogLine(event, GENERATED, { schemaVersion: 2, pid: 123, instanceId, seq });
    const lifetimes =
      record(second, "aaaaaaaa", 2) + record(first, "bbbbbbbb", 1) + record(first, "aaaaaaaa", 1);
    const grouped = findTimeline(analyzeLogText(lifetimes, ANALYZE_OPTIONS), "correlation-1");
    expect(grouped?.lines.map((line) => [line.instanceId, line.seq])).toEqual([
      ["aaaaaaaa", 1],
      ["aaaaaaaa", 2],
      ["bbbbbbbb", 1],
    ]);
  });
});

async function analyzeThroughCli(
  text: string,
  args: readonly string[],
): Promise<{ code: number; output: string; errors: string }> {
  const directory = mkdtempSync(join(tmpdir(), "keiko-tool-cli-"));
  const file = join(directory, "server.log");
  const output: string[] = [];
  const errors: string[] = [];
  try {
    writeFileSync(file, text, "utf8");
    const code = await runSupportCli(["analyze", file, ...args], {
      out: (line): void => {
        output.push(line);
      },
      err: (line): void => {
        errors.push(line);
      },
    });
    return { code, output: output.join(""), errors: errors.join("") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("existing CLI lazy lifecycle analysis dispatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([{ args: [] }, { args: ["--seed"] }])(
    "loads the actual validator for emitted tool evidence %j",
    async ({ args }) => {
      const { text } = await emittedLog();
      const load = vi.spyOn(lazyModules, "loadToolLifecycle");
      const result = await analyzeThroughCli(text, [
        "--json",
        "--correlation-id",
        "correlation-1",
        ...args,
      ]);
      expect(load).toHaveBeenCalledOnce();
      expect(result.code).toBe(0);
      expect(result.errors).toBe("");
      expect(result.output).toMatch(/"budgetDisposition":\s*"committed"/u);
      expect(result.output).not.toMatch(/private-capability|fixture-result|unavailable/u);
    },
  );

  it("does not load the lifecycle graph for ordinary HTTP logs or clusters", async () => {
    const load = vi.spyOn(lazyModules, "loadToolLifecycle");
    const http = formatServerLogLine(
      { category: "http", op: "request", correlationId: "request-1", status: 204 },
      GENERATED,
    );
    const ordinary = await analyzeThroughCli(http, ["--json"]);
    expect(ordinary.code).toBe(0);
    expect(ordinary.output).toMatch(/"status":\s*204/u);
    const { text } = await emittedLog();
    const clusters = await analyzeThroughCli(text, ["--clusters", "--json"]);
    expect(clusters.code).toBe(0);
    expect(clusters.output).toContain("tool-catalog.invocation-settled");
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps unavailable lifecycle validation explicit and body-free", async () => {
    const { text } = await emittedLog();
    vi.spyOn(lazyModules, "loadToolLifecycle").mockRejectedValue(
      new TypeError("private-import-token"),
    );
    const result = await analyzeThroughCli(text, [
      "--json",
      "--seed",
      "--correlation-id",
      "correlation-1",
    ]);
    expect(result.code).toBe(0);
    expect(result.errors).toContain("lifecycle validator unavailable — TypeError");
    expect(result.output).toContain("lifecycle-validator-unavailable");
    expect(result.output).not.toContain("budgetDisposition");
    expect(result.output + result.errors).not.toContain("private-import-token");
  });

  it("keeps the pure analyzer compatible without silently assuming a validator", async () => {
    const { text } = await emittedLog();
    const seed = buildReproductionSeed(text, "correlation-1", GENERATED);
    expect(seed?.toolCatalog).toContainEqual({
      kind: "unavailable",
      operation: "tool-catalog.invocation-settled",
      reason: "lifecycle-validator-unavailable",
    });
    expect(seed?.warnings.join(" ")).toContain("settlement remain unknown");
    expect(JSON.stringify(seed)).not.toContain("budgetDisposition");
  });

  it("retains genuine sink diagnostics and strips hostile stack or cause bodies", async () => {
    const { text } = await emittedLog(undefined, true, "auxiliary");
    const hostile = text
      .trim()
      .split("\n")
      .map((line) => {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (value.op !== "tool-catalog.lifecycle-sink-failed") return line;
        return JSON.stringify({
          ...value,
          frames: ["/private/customer/secret.ts:1:2"],
          causeChain: ["secret-token-body"],
        });
      })
      .join("\n");
    const seed = seedFor(hostile);
    expect(JSON.stringify(seed)).not.toMatch(/customer|secret-token-body/u);
    const pure = buildReproductionSeed(text, "correlation-1", GENERATED);
    expect(pure?.warnings.join(" ")).toContain("structured failure details remain unknown");
    expect(pure?.stackFrames).toBeUndefined();
  });

  it("does not infer which sink failed from an older unqualified diagnostic source", async () => {
    const { text } = await emittedLog(undefined, true, "auxiliary");
    const unknown = text.replaceAll("tool-catalog-lifecycle-auxiliary", "tool-catalog-lifecycle");
    expect(
      seedFor(unknown).toolCatalog?.find((entry) => entry.kind === "sink-failure"),
    ).toMatchObject({
      kind: "sink-failure",
      sink: "unknown",
      diagnostics: "validated",
      causeChain: ["RangeError"],
      errorKind: "TypeError",
    });
  });
});
