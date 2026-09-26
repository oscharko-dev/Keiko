// Activity Log proofs for `emitPreflightActivity` (#3532).
//
// `emitPreflightActivity` is the exact function every `embedding.preflight.*` operation registers
// as its `emitter` in `preflight-activity-log.ts`. It is a pure reducer: given a caller-supplied
// `PreflightActivity` domain event and a job `IndexingLogContext`, it derives the registered
// fields (capsule digest from context, correlation id from the job id, classified error kinds)
// and writes the ONE resulting registered event through `emitKnowledgeLogEvent`. Driving it
// directly — rather than restating its output by hand — is driving the production emitter
// itself, per AGENTS.md §7.
//
// Each case below supplies a realistic domain event, captures the ONE line the reducer wrote
// through a recording `KnowledgeLogSink`, and proves that line is a valid production-persisted
// Activity Log record for the operation the proof id names.

import { describe, expect, it } from "vitest";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import type { KnowledgeLogEvent, KnowledgeLogSink } from "../knowledge-log.js";
import type { IndexingLogContext } from "./types.js";
import { emitPreflightActivity, type PreflightActivity } from "./preflight-activity-log.js";

// 16 lowercase hex characters: satisfies every `*Digest` field's `ACTIVITY_LOG_DIGEST_VALUE`
// pattern (`/^[a-f0-9]{8,128}$/`) and every declared `maxLength` (16 or 64) on these operations.
const DIGEST = "0123456789abcdef";

const CONTEXT: IndexingLogContext = {
  jobId: "preflight-activity-log-proof-job",
  capsuleIdDigest: DIGEST,
};

function capturingSink(): {
  readonly sink: KnowledgeLogSink;
  readonly events: KnowledgeLogEvent[];
} {
  const events: KnowledgeLogEvent[] = [];
  return { sink: { write: (event): void => void events.push(event) }, events };
}

function emitAndCapture(event: PreflightActivity): readonly KnowledgeLogEvent[] {
  const { sink, events } = capturingSink();
  emitPreflightActivity(sink, CONTEXT, event);
  return events;
}

function persistedLineFor(op: string, events: readonly KnowledgeLogEvent[]): string {
  const line = events.find((event) => event.op === op);
  expect(line, `expected ${op} to have been emitted`).toBeDefined();
  return formatActivityLogProofLine(line ?? {});
}

describe("emitPreflightActivity — Activity Log proofs", () => {
  it("resolves embedding.preflight.started.profile", () => {
    const events = emitAndCapture({
      op: "embedding.preflight.started",
      cached: false,
      providerDigest: DIGEST,
      modelIdDigest: DIGEST,
      expectedDimensions: 1536,
      fingerprinted: true,
      endpointDigest: DIGEST,
    });
    const persisted = expectActivityLogProof(
      "embedding.preflight.started.profile",
      persistedLineFor("embedding.preflight.started", events),
    );
    expect(persisted).toMatchObject({ cached: false, fingerprinted: true });
  });

  it("resolves embedding.preflight.failed.kind", () => {
    const events = emitAndCapture({
      op: "embedding.preflight.failed",
      failureKind: "timeout",
      failureSource: "throw",
      providerDigest: DIGEST,
      modelIdDigest: DIGEST,
      fingerprinted: false,
      durationMs: 50,
    });
    const persisted = expectActivityLogProof(
      "embedding.preflight.failed.kind",
      persistedLineFor("embedding.preflight.failed", events),
    );
    expect(persisted).toMatchObject({ failureSource: "throw", failureKind: "timeout" });
  });

  it("resolves embedding.preflight.completed.dimensions", () => {
    const events = emitAndCapture({
      op: "embedding.preflight.completed",
      observedDimensions: 1536,
      durationMs: 80,
      providerDigest: DIGEST,
      modelIdDigest: DIGEST,
      expectedDimensions: 1536,
      fingerprinted: true,
      endpointDigest: DIGEST,
    });
    const persisted = expectActivityLogProof(
      "embedding.preflight.completed.dimensions",
      persistedLineFor("embedding.preflight.completed", events),
    );
    expect(persisted).toMatchObject({ observedDimensions: 1536, fingerprinted: true });
  });

  it("resolves embedding.preflight.cache-hit.profile", () => {
    const events = emitAndCapture({
      op: "embedding.preflight.cache-hit",
      cached: true,
      providerDigest: DIGEST,
      modelIdDigest: DIGEST,
      fingerprinted: true,
    });
    const persisted = expectActivityLogProof(
      "embedding.preflight.cache-hit.profile",
      persistedLineFor("embedding.preflight.cache-hit", events),
    );
    expect(persisted).toMatchObject({ cached: true });
  });

  it("resolves embedding.preflight.identity-rejected.dimensions", () => {
    const events = emitAndCapture({
      op: "embedding.preflight.identity-rejected",
      pinnedDimensions: 1536,
      observedDimensions: 768,
      failureKind: "dimension-mismatch",
    });
    const persisted = expectActivityLogProof(
      "embedding.preflight.identity-rejected.dimensions",
      persistedLineFor("embedding.preflight.identity-rejected", events),
    );
    expect(persisted).toMatchObject({ pinnedDimensions: 1536, observedDimensions: 768 });
  });

  it("resolves embedding.preflight.identity-adopted.dimensions", () => {
    const events = emitAndCapture({
      op: "embedding.preflight.identity-adopted",
      observedDimensions: 1536,
      providerDigest: DIGEST,
    });
    const persisted = expectActivityLogProof(
      "embedding.preflight.identity-adopted.dimensions",
      persistedLineFor("embedding.preflight.identity-adopted", events),
    );
    expect(persisted).toMatchObject({ observedDimensions: 1536 });
  });

  it("resolves embedding.preflight.identity-refreshed.dimensions", () => {
    const events = emitAndCapture({
      op: "embedding.preflight.identity-refreshed",
      observedDimensions: 768,
      providerDigest: DIGEST,
    });
    const persisted = expectActivityLogProof(
      "embedding.preflight.identity-refreshed.dimensions",
      persistedLineFor("embedding.preflight.identity-refreshed", events),
    );
    expect(persisted).toMatchObject({ observedDimensions: 768 });
  });
});
