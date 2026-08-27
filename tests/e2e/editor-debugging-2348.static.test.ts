import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ADAPTER_PATH = join(
  ROOT,
  "tests",
  "e2e",
  "fixtures",
  "editor-debugging-2348",
  "dap-socket-adapter.fixture",
);
const SPEC_PATH = join(ROOT, "tests", "e2e", "editor-debugging-2348.spec.ts");

describe("#2348 D12 cap evidence harness", () => {
  it("selects both cap modes from the closed launch target while preserving standard mode", () => {
    const adapter = readFileSync(ADAPTER_PATH, "utf8");

    expect(adapter).toContain('"cap-stopped"');
    expect(adapter).toContain('"cap-output"');
    expect(adapter).toContain('"standard"');
    expect(adapter).toContain("1_048_576");
    expect(adapter).toContain("CAP_STACK_FRAME_COUNT = 128");
    expect(adapter).toContain("CAP_SCOPE_COUNT = 32");
    expect(adapter).toContain("CAP_VARIABLE_COUNT = 200");
    expect(adapter).toContain("CAP_GRAPH_NODE_COUNT = 1_000");
  });

  // KEIKO-1017: the Content-Length header regex must be hoisted to a module constant so the
  // drain() loop does not re-evaluate the literal on every message.
  it("hoists the Content-Length header regex out of the drain loop (KEIKO-1017)", () => {
    const adapter = readFileSync(ADAPTER_PATH, "utf8");
    expect(adapter).toContain("CONTENT_LENGTH_HEADER");
    // Two occurrences: the module-level `const` declaration + the drain() consumer.
    const references = adapter.match(/CONTENT_LENGTH_HEADER/g) ?? [];
    expect(references).toHaveLength(2);
  });

  // KEIKO-0990/0991/0992: the fixture must write diagnostics to stderr on protocol errors and
  // must register `error` handlers on both the accepted connection and the listening server so
  // an I/O or listen() failure does not crash the fixture with no diagnostic.
  it("writes a stderr diagnostic on malformed Content-Length before exiting (KEIKO-0990)", () => {
    const adapter = readFileSync(ADAPTER_PATH, "utf8");
    expect(adapter).toMatch(/process\.stderr\.write[\s\S]*malformed Content-Length header/u);
  });

  it("writes a stderr diagnostic on JSON parse error before exiting (KEIKO-0990)", () => {
    const adapter = readFileSync(ADAPTER_PATH, "utf8");
    expect(adapter).toMatch(/process\.stderr\.write[\s\S]*JSON parse error/u);
  });

  it("registers an error handler on the accepted DAP connection (KEIKO-0991)", () => {
    const adapter = readFileSync(ADAPTER_PATH, "utf8");
    expect(adapter).toContain('connection.on("error"');
  });

  it("registers an error handler on the listening server (KEIKO-0992)", () => {
    const adapter = readFileSync(ADAPTER_PATH, "utf8");
    expect(adapter).toContain('server.on("error"');
  });

  it("keeps cap artifacts opt-in, closed, and bound to both mandatory scenarios", () => {
    const spec = readFileSync(SPEC_PATH, "utf8");

    expect(spec).toContain("KEIKO_D12_CAP_EVIDENCE_PATH");
    expect(spec).toContain("stoppedProjection");
    expect(spec).toContain("outputFlood");
    expect(spec).toContain("inlineDecorations: 200");
    expect(spec).toContain("renderedRowsCeiling: 200");
    expect(spec).not.toMatch(/artifact[^\n]*(endpoint|sourceContent)/iu);
  });

  it("measures complete SSE-to-paint and pointer-to-terminal projections", () => {
    const spec = readFileSync(SPEC_PATH, "utf8");

    expect(spec).not.toContain("EventDispatch");
    expect(spec).toContain('event.kind !== "stopped"');
    expect(spec).toContain('"pointerdown"');
    expect(spec).toContain("probe.controlCompleted = true");
    expect(spec).toContain("probe.terminalSseObserved = true");
    expect(spec).toContain('panel?.textContent.includes("No active debug session.")');
    expect(spec).toContain("__keikoD12AfterNextPaint");
    expect(spec).toContain("collectStoppedProjectionSamples");
    expect(spec).toContain("CAP_SAMPLE_COUNT");
  });
});
