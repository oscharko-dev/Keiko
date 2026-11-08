import { expect, it, vi } from "vitest";
import { codingJiraCatalogFits } from "./codingJiraCatalogBudget.js";
import { createCodingRuntimeContextUsageRegistry } from "./codingRuntimeContextUsage.js";

const geometry = { contextWindowTokens: 8192, maxInputTokens: 7168, maxOutputTokens: 1024 };
const tools = [{ name: "jira.issue", description: "Read the selected issue.",
  inputSchema: { type: "object", properties: { issueKey: { type: "string", maxLength: 128 } } } }];
const result = { outcome: "succeeded", items: [{ tool: "jira.issue" }], selectedFor: "next-round" };
function fixture() {
  const usage = createCodingRuntimeContextUsageRegistry();
  const promptFits = vi.fn<(promptTokens: number) => boolean>(() => true);
  let sequence = 0;
  const observe = (inputTokens: number): void => {
    usage.recordProviderSample("run", { sampleId: String(++sequence),
      capacityTokens: geometry.contextWindowTokens, reservedOutputTokens: geometry.maxOutputTokens,
      inputTokens, updatedAt: "2026-11-08T05:00:00.000Z" });
  };
  const fits = () => codingJiraCatalogFits({ tools, result, geometry, promptFits, usage: usage.read("run") });
  return { usage, promptFits, observe, fits };
}

it("distinguishes absent provider context from an exhausted observed allowance", () => {
  const f = fixture();
  expect(f.fits()).toBeUndefined();
  expect(f.promptFits).not.toHaveBeenCalled();
  f.observe(1024);
  expect(f.fits()).toBe(true);
  expect(f.promptFits).toHaveBeenLastCalledWith(expect.any(Number));
  expect(f.promptFits.mock.calls.at(-1)?.[0]).toBeGreaterThan(2048);
  f.promptFits.mockReturnValue(false);
  expect(f.fits()).toBe(false);
});

it("uses the current provider context and model input cap, not the much larger byte ceiling", () => {
  const f = fixture(); f.observe(1024);
  expect(f.fits()).toBe(true);
  f.observe(6500);
  f.promptFits.mockClear();
  expect(f.fits()).toBe(false);
  expect(f.promptFits).not.toHaveBeenCalled();
});

it("does not substitute a foreign run, estimated usage, or changed model geometry", () => {
  const f = fixture(); f.observe(1024);
  const usage = f.usage.read("run");
  if (usage?.state !== "available") throw new TypeError("Missing provider sample");
  const input = { tools, result, geometry, promptFits: f.promptFits, usage };
  expect(codingJiraCatalogFits({ ...input, usage: f.usage.read("foreign") })).toBeUndefined();
  expect(codingJiraCatalogFits({ ...input, usage: { ...usage, source: "estimated" } })).toBeUndefined();
  expect(codingJiraCatalogFits({ ...input, geometry: { ...geometry, contextWindowTokens: 16384 } })).toBeUndefined();
  expect(codingJiraCatalogFits({ ...input, promptFits: undefined })).toBeUndefined();
});

it("reads accounting repeatedly without reserving or changing provider usage", () => {
  const f = fixture(); f.observe(1024);
  const before = f.usage.read("run");
  expect(f.fits()).toBe(true);
  expect(f.fits()).toBe(true);
  expect(f.usage.read("run")).toBe(before);
  expect(f.promptFits).toHaveBeenCalledTimes(2);
});
