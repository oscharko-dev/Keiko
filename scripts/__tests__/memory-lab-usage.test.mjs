import { describe, expect, it } from "vitest";
import { renderUsage, summarizeUsage, usageOfEvents } from "../testing/memory-lab/usage.mjs";

const EVENTS = [
  { op: "chat.turn.started", correlationId: "turn-1" },
  { op: "gateway.chat.started", correlationId: "turn-1" },
  {
    op: "gateway.chat.completed",
    correlationId: "turn-1",
    modelId: "m",
    promptTokens: 100,
    completionTokens: 20,
    durationMs: 1000,
  },
  { op: "gateway.chat.started", correlationId: "learn-1" },
  {
    op: "gateway.stream.completed",
    correlationId: "learn-1",
    modelId: "m",
    promptTokens: 400,
    completionTokens: 40,
    durationMs: 3000,
  },
  { op: "gateway.chat.started", correlationId: "learn-2" },
];

describe("memory lab usage", () => {
  it("splits calls into answering (chat turns) and learning (the rest) and counts unfinished ones", () => {
    const usage = usageOfEvents(EVENTS);
    expect(usage.answering).toEqual({
      calls: 1,
      promptTokens: 100,
      completionTokens: 20,
      durationMs: 1000,
    });
    expect(usage.learning).toEqual({
      calls: 1,
      promptTokens: 400,
      completionTokens: 40,
      durationMs: 3000,
    });
    expect(usage.unfinished).toBe(1);
    expect(usage.models).toEqual(["m"]);
  });

  it("summarizes per arm with tokens per live memory and renders a table", () => {
    const unit = { scenario: "s", arm: "product", ...usageOfEvents(EVENTS) };
    const rows = summarizeUsage(
      [unit, { ...unit, scenario: "t" }],
      new Map([
        ["s:product", 2],
        ["t:product", 0],
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].instances).toBe(2);
    expect(rows[0].liveMemories).toBe(2);
    expect(rows[0].learningTokensPerLiveMemory).toBe(440);
    expect(rows[0].meanCallMs).toBe(2000);
    expect(rows[0].unfinished).toBe(2);
    expect(renderUsage(rows)).toContain(
      "| product | 2 | m | 2 | 800+80 | 2 | 200+40 | 2000 | 2 | 2 | 440 |",
    );
  });

  it("reports no cost per memory when nothing was learned", () => {
    const rows = summarizeUsage([{ scenario: "s", arm: "off", ...usageOfEvents([]) }], new Map());
    expect(rows[0].learningTokensPerLiveMemory).toBeNull();
    expect(rows[0].meanCallMs).toBeNull();
  });
});
