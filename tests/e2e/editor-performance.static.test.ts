import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./editor-performance.spec.ts", import.meta.url), "utf8");

describe("editor performance worker capture", () => {
  it("bounds response-body reads and inspects each JavaScript URL once", () => {
    expect(source).toContain("WORKER_RESPONSE_BODY_TIMEOUT_MS");
    expect(source).toContain("readWorkerResponseBody(response)");
    expect(source).toContain("const inspectedJavaScriptResponses = new Set<string>();");
    expect(source).toContain("!inspectedJavaScriptResponses.has(url)");
    expect(source).toContain("inspectedJavaScriptResponses.add(url)");
    expect(source).toContain("if (D12_COMPARISON) return;");
    expect(source).not.toContain("EDITOR_PERF_WORKER_CAPTURE_TIMEOUT");
  });
});
