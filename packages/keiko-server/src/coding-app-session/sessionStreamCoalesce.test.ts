// The writer keeps only the newest pending snapshot while a frame drains. A snapshot's text deltas
// are consume-once (the producer advances its published offset as it takes them), so the dropped
// snapshot's deltas must travel in the newer one or the reader sees a gap in the streamed text.
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION,
  CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES,
  type CodingAppSessionChannelSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import {
  CODING_SAFE_ACTIVITY_MAX_TEXT_DELTA_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TEXT_DELTAS,
  type CodingSafeActivityFeed,
  type CodingSafeActivityTextDelta,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";
import { createSessionStreamWriter, type SessionStreamFlowCounts } from "./sessionStreamWriter.js";

class FakeResponse extends EventEmitter {
  public destroyed = false;
  public writableEnded = false;
  public readonly frames: string[] = [];
  public accept = false;
  public write(frame: string): boolean {
    this.frames.push(frame);
    return this.accept;
  }
}

const FEED = { kind: "feed-probe" } as unknown as CodingSafeActivityFeed;

function snapshot(
  textDeltas?: readonly CodingSafeActivityTextDelta[],
  feed: CodingSafeActivityFeed = FEED,
): CodingAppSessionChannelSnapshot {
  return {
    schemaVersion: CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION,
    content: {
      kind: "safe-activity",
      feed,
      ...(textDeltas === undefined ? {} : { textDeltas }),
    },
  };
}

function delta(
  part: "answer" | "reasoning",
  offset: number,
  text: string,
): CodingSafeActivityTextDelta {
  return { messageId: "m1", part, offset, text };
}

interface Harness {
  readonly res: FakeResponse;
  readonly publish: (s: CodingAppSessionChannelSnapshot) => void;
  readonly drain: () => void;
  readonly counts: () => SessionStreamFlowCounts;
}

// The first snapshot is written and leaves the buffer above its high-water mark: the writer drains.
function harness(): Harness {
  const res = new FakeResponse();
  const writer = createSessionStreamWriter({
    res: res as unknown as ServerResponse,
    correlationId: undefined,
    diagnostics: undefined,
    close: () => undefined,
    onStalled: () => undefined,
  });
  writer.publish(snapshot([delta("answer", 0, "ab")]));
  return {
    res,
    publish: (s) => void writer.publish(s),
    counts: () => writer.flowCounts(),
    drain: (): void => {
      res.accept = true;
      res.emit("drain");
    },
  };
}

function sentSnapshots(res: FakeResponse): CodingAppSessionChannelSnapshot[] {
  return res.frames
    .filter((f) => f.startsWith("event: snapshot"))
    .map((f) => JSON.parse(f.slice(f.indexOf("data: ") + 6)) as CodingAppSessionChannelSnapshot);
}

// What a reader that appends every delta at its offset holds per part; a gap is ignored.
function readerText(snapshots: readonly CodingAppSessionChannelSnapshot[]): Record<string, string> {
  const held: Record<string, string> = {};
  for (const s of snapshots) {
    if (s.content === null || !("feed" in s.content)) continue;
    for (const d of s.content.textDeltas ?? []) {
      const current = held[d.part] ?? "";
      if (d.offset > current.length) continue;
      held[d.part] = current + d.text.slice(current.length - d.offset);
    }
  }
  return held;
}

describe("coalesced text deltas", () => {
  it("keeps every text delta of snapshots replaced while a frame drains", () => {
    const { res, publish, drain, counts } = harness();
    publish(snapshot([delta("answer", 2, "cd"), delta("reasoning", 0, "r1")]));
    publish(snapshot([delta("answer", 4, "ef")]));
    publish(snapshot([delta("reasoning", 2, "r2")]));
    drain();
    const sent = sentSnapshots(res);
    expect(sent).toHaveLength(2);
    expect(readerText(sent)).toEqual({ answer: "abcdef", reasoning: "r1r2" });
    expect(counts()).toMatchObject({ carriedTextDeltaCount: 4, carryFallbackCount: 0 });
  });

  it("keeps the newest feed when only the older snapshot has deltas", () => {
    const { res, publish, drain } = harness();
    publish(snapshot([delta("answer", 2, "cd")]));
    const newestFeed = { kind: "newest" } as unknown as CodingSafeActivityFeed;
    publish(snapshot(undefined, newestFeed));
    drain();
    expect(sentSnapshots(res)[1]?.content).toMatchObject({ feed: newestFeed });
    expect(readerText(sentSnapshots(res))).toEqual({ answer: "abcd" });
  });

  it("falls back to the newest deltas when the merge would pass the frame budget", () => {
    const { res, publish, drain, counts } = harness();
    const big = "x".repeat(30_000);
    publish(snapshot([delta("answer", 2, big)]));
    publish(snapshot([delta("answer", 2 + big.length, big)]));
    publish(snapshot([delta("answer", 2 + 2 * big.length, big)]));
    drain();
    const last = sentSnapshots(res)[1];
    const frame = res.frames[1] ?? "";
    expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(
      CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES + 64,
    );
    expect(last?.content).toMatchObject({ textDeltas: [{ offset: 2 + 2 * big.length }] });
    expect(counts()).toMatchObject({ carriedTextDeltaCount: 1, carryFallbackCount: 1 });
  });

  it("never passes the delta count of the contract", () => {
    const { res, publish, drain } = harness();
    for (let index = 0; index < 3; index += 1) {
      publish(
        snapshot(
          Array.from({ length: CODING_SAFE_ACTIVITY_MAX_TEXT_DELTAS }, (_, i) => ({
            messageId: `m${String(index)}-${String(i)}`,
            part: "answer" as const,
            offset: 0,
            text: "t",
          })),
        ),
      );
    }
    drain();
    const content = sentSnapshots(res)[1]?.content;
    const count =
      content !== null && content !== undefined && "feed" in content
        ? (content.textDeltas?.length ?? 0)
        : 0;
    expect(count).toBeLessThanOrEqual(CODING_SAFE_ACTIVITY_MAX_TEXT_DELTAS);
  });

  it("still carries two deltas that fit just below the frame limit", () => {
    const { res, publish, drain, counts } = harness();
    const half = "x".repeat(32_000);
    publish(snapshot([delta("answer", 2, half)]));
    publish(snapshot([delta("answer", 2 + half.length, half)]));
    drain();
    const frame = res.frames[1] ?? "";
    expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(
      CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES + 64,
    );
    expect(readerText(sentSnapshots(res)).answer).toHaveLength(2 + 2 * half.length);
    expect(counts()).toMatchObject({ carriedTextDeltaCount: 1, carryFallbackCount: 0 });
  });

  it("falls back when UTF-8 bytes pass the limit although the characters do not", () => {
    const { res, publish, drain, counts } = harness();
    const twoBytes = "\u00e9".repeat(25_000);
    expect(twoBytes.length).toBeLessThan(CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES);
    publish(snapshot([delta("answer", 2, twoBytes)]));
    publish(snapshot([delta("answer", 2 + twoBytes.length, twoBytes)]));
    drain();
    expect(sentSnapshots(res)[1]?.content).toMatchObject({
      textDeltas: [{ offset: 2 + twoBytes.length }],
    });
    expect(counts()).toMatchObject({ carriedTextDeltaCount: 0, carryFallbackCount: 1 });
  });

  it("keeps non-contiguous and repeated-offset deltas separate and in order", () => {
    const { res, publish, drain } = harness();
    publish(snapshot([delta("answer", 2, "cd"), delta("answer", 10, "zz")]));
    publish(snapshot([delta("answer", 10, "zz"), delta("answer", 4, "ef")]));
    drain();
    const content = sentSnapshots(res)[1]?.content;
    expect(content !== null && content !== undefined && "feed" in content).toBe(true);
    const deltas =
      content !== null && content !== undefined && "feed" in content ? content.textDeltas : [];
    expect(deltas).toEqual([
      delta("answer", 2, "cd"),
      delta("answer", 10, "zz"),
      delta("answer", 10, "zz"),
      delta("answer", 4, "ef"),
    ]);
  });

  it("joins contiguous deltas up to the delta length limit and no further", () => {
    const limit = CODING_SAFE_ACTIVITY_MAX_TEXT_DELTA_CHARS;
    const deltasAfter = (firstLength: number): readonly CodingSafeActivityTextDelta[] => {
      const { res, publish, drain } = harness();
      publish(snapshot([delta("answer", 2, "x".repeat(firstLength))]));
      publish(snapshot([delta("answer", 2 + firstLength, "y")]));
      drain();
      const content = sentSnapshots(res)[1]?.content;
      return content !== null && content !== undefined && "feed" in content
        ? (content.textDeltas ?? [])
        : [];
    };
    expect(deltasAfter(limit - 1).map((d) => d.text.length)).toEqual([limit]);
    expect(deltasAfter(limit).map((d) => d.text.length)).toEqual([limit, 1]);
  });
});
