import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { updateCapsuleDetails } from "@oscharko-dev/keiko-local-knowledge";
import { sealedLocalPodModelUsePolicy } from "@oscharko-dev/keiko-contracts/runtime/local-knowledge-model-use-policy";
import { podFixture, specification, type PodFixture } from "./_requirementSupport.js";
import {
  createKnowledgeRequirementsProvider,
  type RequirementsToolContext,
} from "./requirementsTool.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { decodeKnowledgeCursor, knowledgeDigest } from "./knowledge-document-source.js";
import { GATEWAY_BUFFERED_BUDGET_FLOOR_MS } from "@oscharko-dev/keiko-model-gateway/internal/resilience";
import { REVIEW_WINDOW_CHARS, parseSemanticReview } from "./knowledge-semantic-review.js";
import { executeKnowledgeTool } from "./knowledge-tool-execution.js";

const fixtures: PodFixture[] = [];
let sink: BufferedServerLogSink;
beforeEach(() => {
  sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
});
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  resetServerLogger();
});

async function fixture(text = specification(5).text): Promise<PodFixture> {
  const created = await podFixture([{ capsuleId: "cap-documents", text }], {
    redactor: (value) => value,
  });
  fixtures.push(created);
  return created;
}
function context(
  f: PodFixture,
  override: Partial<RequirementsToolContext> = {},
): RequirementsToolContext {
  return {
    chatId: f.chatId,
    userMessageId: "documents-turn",
    invocationId: "documents-invocation",
    correlationId: "documents-correlation",
    signal: new AbortController().signal,
    beforeEffect: () => true,
    meterModel: (model) => model,
    ...override,
  };
}
async function call(
  f: PodFixture,
  name: string,
  args: CatalogJsonObject,
  override: Partial<RequirementsToolContext> = {},
): Promise<CatalogJsonObject> {
  const tool = createKnowledgeRequirementsProvider(f.deps)
    .tools()
    .find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error("Expected the shared Knowledge tool.");
  return (await tool.execute(args, context(f, override))).data;
}
function items(page: CatalogJsonObject): readonly CatalogJsonObject[] {
  return page.items as readonly CatalogJsonObject[];
}
async function documentArgs(f: PodFixture): Promise<CatalogJsonObject> {
  const page = await call(f, "knowledge.documents", { view: "inventory" });
  const document = items(page)[0];
  if (document === undefined) throw new Error("Expected one document.");
  return {
    documentScope: document.documentScope ?? "",
    revisionDigest: document.revisionDigest ?? "",
  };
}
function response(payload: unknown): NormalizedResponse {
  return {
    modelId: "chat-model",
    content: JSON.stringify(payload),
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "review-request",
      promptTokens: 100,
      completionTokens: 100,
      latencyMs: 1,
      costClass: "low",
    },
  };
}
function addDocuments(f: PodFixture, count: number): void {
  f.withStore((store) => {
    const query = store._internal.db.prepare(
      "INSERT INTO documents (id, capsule_id, source_id, document_path, size_bytes, media_type, content_hash, parser_id, parser_version, last_extracted_at, status, safe_display_name) SELECT ?, capsule_id, source_id, ?, size_bytes, ?, content_hash, parser_id, parser_version, last_extracted_at, status, ? FROM documents WHERE id = 'doc-cap-documents'",
    );
    for (let index = 1; index < count; index++) {
      const id = `extra-${String(index).padStart(4, "0")}`;
      query.run(
        id,
        id,
        index % 2 === 0
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        `${id}.docx`,
      );
    }
  });
}

describe("managed scoped document access", () => {
  it("pages the whole metadata inventory beyond the requirement-reader limit and keeps failed formats visible", async () => {
    const f = await fixture();
    addDocuments(f, 65);
    f.withStore((store) => {
      store._internal.db
        .prepare("UPDATE documents SET status = 'unsupported' WHERE id = 'extra-0064'")
        .run();
    });
    const pages: CatalogJsonObject[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(f, "knowledge.documents", {
        view: "inventory",
        ...(cursor === undefined ? {} : { cursor }),
      });
      pages.push(page);
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    } while (cursor !== undefined && pages.length < 10);
    expect(pages.flatMap(items)).toHaveLength(65);
    expect(pages[0]?.totals).toMatchObject({
      documentCount: 65,
      documentsNotExtracted: 1,
      documentsOmitted: 0,
    });
    expect(pages.at(-1)?.coverage).toMatchObject({ atEnd: true, inventoryComplete: false });
    expect(pages.flatMap(items).some((item) => item.extractionStatus === "unsupported")).toBe(true);
  });

  it("reads successive immutable source ranges and refuses stale, foreign and revoked references", async () => {
    const source = "A requirement must remain anchored.\n".repeat(320);
    const f = await fixture(source);
    const args = await documentArgs(f);
    const first = await call(f, "knowledge.documents", { ...args, view: "read" });
    const second = await call(f, "knowledge.documents", {
      ...args,
      view: "read",
      cursor: first.nextCursor ?? "",
    });
    expect(first.outcome).toBe("succeeded");
    expect(items(first)[0]?.text).toBe(source.slice(0, 5000));
    expect(items(second)[0]).toMatchObject({
      characterStart: 5000,
      characterEnd: 10000,
      text: source.slice(5000, 10000),
    });
    expect(
      await call(f, "knowledge.documents", { ...args, view: "read", documentScope: "00000000" }),
    ).toMatchObject({ outcome: "failed" });
    f.withStore((store) => {
      updateCapsuleDetails(store, f.capsuleIds[0] as never, {
        modelUsePolicy: sealedLocalPodModelUsePolicy(),
      });
    });
    expect(await call(f, "knowledge.documents", { ...args, view: "read" })).toMatchObject({
      outcome: "failed",
      reason: "stale",
    });
  });

  it("pages literal search within a document and supports offsets beyond 250 documents without claiming skipped coverage", async () => {
    const f = await fixture("needle in the source.\n".repeat(30));
    const first = await call(f, "knowledge.documents", { view: "search", query: "needle" });
    const second = await call(f, "knowledge.documents", {
      view: "search",
      query: "needle",
      cursor: first.nextCursor ?? "",
    });
    expect(items(first)).toHaveLength(12);
    expect(items(second)).toHaveLength(12);
    expect(items(second)[0]?.characterStart).toBeGreaterThan(
      Number(items(first).at(-1)?.characterStart),
    );
    addDocuments(f, 252);
    const restart = await call(f, "knowledge.documents", { view: "search", query: "absent" });
    const parsed = decodeKnowledgeCursor(
      typeof restart.nextCursor === "string" ? restart.nextCursor : "",
    );
    expect(parsed).toBeDefined();
    const skipped = await call(f, "knowledge.documents", {
      view: "search",
      query: "absent",
      cursor: `${String(251 * 4_000_001)}.${parsed?.fingerprint ?? ""}`,
    });
    expect(skipped).toMatchObject({
      outcome: "succeeded",
      coverage: { documentsVisited: 1, atEnd: true, searchComplete: false },
    });
  });

  it("does not expose a credential cut across source-window boundaries", async () => {
    const secret = "Bearer sk-test-secret-value-should-never-leave";
    const source = `${"x".repeat(4994)} ${secret} end`;
    const f = await fixture(source);
    Object.assign(f.deps, {
      redactor: (value: unknown): unknown =>
        typeof value === "string" ? value.replaceAll(secret, "[REDACTED]") : value,
    });
    const page = await call(f, "knowledge.documents", { view: "read", ...(await documentArgs(f)) });
    expect(items(page)[0]).toMatchObject({ text: "", sourceUnavailable: true });
    expect(JSON.stringify(page)).not.toContain("Bearer");
  });

  it("records a real registered body-free read, refusal and analyzer timeline", async () => {
    const f = await fixture("Private source wording.");
    await call(f, "knowledge.documents", { view: "inventory" });
    await call(f, "knowledge.documents", {
      view: "read",
      documentScope: "00000000",
      revisionDigest: "0".repeat(64),
    });
    const lines = sink.events
      .filter((event) => event.op === "knowledge.documents.operation")
      .map(formatActivityLogProofLine);
    expect(
      lines.map((line) => expectActivityLogProof("knowledge.documents.operation.line", line)),
    ).toMatchObject([
      { operation: "inventory", disposition: "served", documentCount: 1, returnedCount: 1 },
      { operation: "read", disposition: "refused" },
    ]);
    expect(analyzeLogText(lines.join("\n")).timelines).toHaveLength(1);
    expect(lines.join()).not.toContain("Private source wording");
  });
});

describe("bounded semantic review through the model gateway port", () => {
  it("keeps model-proposed criteria separate from original source and caches each document revision", async () => {
    const f = await fixture();
    const generated = vi.fn(() =>
      Promise.resolve(
        response({
          complete: true,
          findings: [
            {
              kind: "acceptance-criterion",
              anchors: [0],
              proposal: "Verify the stated condition with an observed result.",
              question: "",
            },
          ],
        }),
      ),
    );
    const meter = vi.fn((model: ReturnType<PodFixture["deps"]["modelPortFactory"]>) => model);
    Object.assign(f.deps, { modelPortFactory: () => ({ call: generated }) });
    const args = await documentArgs(f);
    const first = await call(f, "knowledge.review", args, {
      meterModel: (model) => {
        meter(model);
        return model;
      },
    });
    const second = await call(f, "knowledge.review", args);
    expect(first.outcome).toBe("succeeded");
    expect(items(first)[0]).toMatchObject({
      origin: "model-proposal",
      status: "proposed",
      kind: "acceptance-criterion",
      sources: [{ characterStart: 0 }],
    });
    expect(first.coverage).toMatchObject({
      documentReviewComplete: true,
      originalModified: false,
      semanticExhaustivenessProven: false,
      cached: false,
    });
    expect(second.coverage).toMatchObject({ cached: true });
    expect(generated).toHaveBeenCalledOnce();
    expect(meter).toHaveBeenCalledOnce();
    expect(JSON.stringify(first)).not.toContain("deterministicBaseline");
    f.withStore((store) => {
      store._internal.db
        .prepare("UPDATE document_texts SET normalized_text = ?")
        .run(store._internal.contentCipher.sealText("The source revision requires an audit."));
    });
    expect((await call(f, "knowledge.review", args)).outcome).toBe("succeeded");
    expect(generated).toHaveBeenCalledTimes(2);
  });

  it("pages review windows and retains completed coverage after finding-cache eviction", async () => {
    const f = await fixture("Initial source.");
    const source = "Ordinary source text. "
      .repeat(Math.ceil((129 * REVIEW_WINDOW_CHARS) / 22))
      .slice(0, 129 * REVIEW_WINDOW_CHARS);
    f.withStore((store) => {
      store._internal.db
        .prepare("UPDATE document_texts SET normalized_text = ?")
        .run(store._internal.contentCipher.sealText(source));
    });
    const generated = vi.fn(() => Promise.resolve(response({ complete: true, findings: [] })));
    Object.assign(f.deps, { modelPortFactory: () => ({ call: generated }) });
    const args = await documentArgs(f);
    let cursor: string | undefined;
    let page: CatalogJsonObject;
    let pages = 0;
    do {
      page = await call(f, "knowledge.review", {
        ...args,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.outcome).toBe("succeeded");
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      pages++;
    } while (cursor !== undefined && pages < 140);
    expect(pages).toBe(129);
    expect(page.coverage).toMatchObject({
      reviewedWindows: 129,
      totalWindows: 129,
      documentReviewComplete: true,
    });
    expect(generated).toHaveBeenCalledTimes(129);
  }, 30_000);

  it("rejects invented anchors, unavailable budget ports and cancelled calls without caching them", async () => {
    const f = await fixture();
    const generated = vi.fn(() =>
      Promise.resolve(
        response({
          complete: true,
          findings: [{ kind: "obligation", anchors: [999], proposal: "Invented", question: "" }],
        }),
      ),
    );
    Object.assign(f.deps, { modelPortFactory: () => ({ call: generated }) });
    const args = await documentArgs(f);
    expect(await call(f, "knowledge.review", args)).toMatchObject({
      outcome: "failed",
      reason: "review-unavailable-or-invalid",
    });
    expect(await call(f, "knowledge.review", args)).toMatchObject({ outcome: "failed" });
    expect(generated).toHaveBeenCalledTimes(2);
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await call(f, "knowledge.review", args, { signal: cancelled.signal })).toMatchObject({
      outcome: "failed",
      reason: "denied",
    });
    expect(generated).toHaveBeenCalledTimes(2);
    expect(
      decodeKnowledgeCursor(`99999999999999999999.${knowledgeDigest("source")}`),
    ).toBeUndefined();
  });
});

it.each(["complete", "partial", "invalid", "stale", "cancelled"])(
  "confirms only a parsed semantic result admitted against the final scope (%s)",
  async (kind) => {
    const f = await fixture();
    const args = await documentArgs(f);
    const controller = new AbortController();
    const confirm = vi.fn();
    const value = response({ complete: kind !== "partial", findings: [] });
    const generated = vi.fn(() => {
      if (kind === "stale")
        f.withStore((store) =>
          store._internal.db
            .prepare("UPDATE document_texts SET normalized_text = ?")
            .run(store._internal.contentCipher.sealText("A changed current source.")),
        );
      if (kind === "cancelled") controller.abort();
      return Promise.resolve(
        kind === "invalid" ? { ...value, finishReason: "length" as const } : value,
      );
    });
    Object.assign(f.deps, { modelPortFactory: () => ({ call: generated }) });
    const result = await call(f, "knowledge.review", args, {
      signal: controller.signal,
      confirmModelOperation: confirm,
    });
    if (kind === "complete" || kind === "partial") {
      expect(result.outcome).toBe("succeeded");
      expect(confirm).toHaveBeenCalledExactlyOnceWith(value);
    } else {
      expect(result.outcome).toBe("failed");
      expect(confirm).not.toHaveBeenCalled();
    }
  },
);

it("records an unexpected Knowledge read failure without retaining its body", async () => {
  const f = await fixture();
  const diagnostic = vi.fn();
  const read = vi.fn(() => {
    throw new TypeError("Private Knowledge read canary");
  });
  const result = await executeKnowledgeTool(
    { ...f.deps, diagnostics: { record: diagnostic } },
    context(f),
    "inventory",
    read,
  );
  expect(result).toEqual({
    data: { outcome: "failed", reason: "unavailable" },
    isError: true,
  });
  expect(read).toHaveBeenCalledOnce();
  expect(diagnostic).toHaveBeenCalledOnce();
  expect(diagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      correlationId: "documents-correlation",
      operation: "knowledge.documents",
      source: "knowledge-tool-execution",
      errorClass: "TypeError",
      message: "server-operation-failed",
    }),
  );
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("Private");
});

it("propagates malformed semantic JSON to the existing managed-tool diagnostic boundary", async () => {
  const f = await fixture();
  const args = await documentArgs(f);
  const record = vi.fn();
  const confirm = vi.fn();
  const malformed = { ...response(null), content: "PRIVATE_TEST_BODY_not_json" };
  const generated = vi.fn(() => Promise.resolve(malformed));
  Object.assign(f.deps, { diagnostics: { record }, modelPortFactory: () => ({ call: generated }) });
  const result = await call(f, "knowledge.review", args, { confirmModelOperation: confirm });
  expect(result).toMatchObject({ outcome: "failed", reason: "unavailable" });
  expect(record).toHaveBeenCalledOnce();
  expect(JSON.stringify(record.mock.calls)).not.toContain(malformed.content);
  expect(confirm).not.toHaveBeenCalled();
  expect(generated).toHaveBeenCalledOnce();
});

it("keeps malformed review syntax observable while rejecting truncated or unsupported review shapes", () => {
  expect(() => parseSemanticReview({ ...response(null), content: "not-json" }, 1)).toThrow(
    SyntaxError,
  );
  expect(
    parseSemanticReview({ ...response(null), content: "not-json", finishReason: "length" }, 1),
  ).toBeUndefined();
  expect(
    parseSemanticReview(response({ complete: true, findings: [], extra: true }), 1),
  ).toBeUndefined();
});

it.each(["json", "JSON", ""])(
  "accepts one complete %s JSON fence without changing the reviewed schema",
  (tag) => {
    const value = {
      complete: true,
      findings: [
        {
          kind: "obligation",
          anchors: [0],
          proposal: "Verify this source obligation.",
          question: "",
        },
      ],
    };
    const answer = {
      ...response(null),
      content: ` \n\`\`\`${tag}\n${JSON.stringify(value)}\n\`\`\` \n`,
    };
    expect(parseSemanticReview(answer, 1)).toEqual(value);
  },
);

it.each([
  'An explanation before the result.\n```json\n{"complete":true,"findings":[]}\n```',
  '```json\n{"complete":true,"findings":[]}\n```\nAn explanation after the result.',
  '```json\n{"complete":true,"findings":[]}\n```\n```json\n{"complete":true,"findings":[]}\n```',
])(
  "refuses prose or multiple JSON blocks instead of selecting a convenient fragment (%s)",
  (content) => {
    expect(() => parseSemanticReview({ ...response(null), content }, 1)).toThrow(SyntaxError);
  },
);

it("keeps the observed truncated JSON-fence response unavailable", () => {
  expect(
    parseSemanticReview({ ...response(null), content: "```json\n", finishReason: "length" }, 1),
  ).toBeUndefined();
});

it("uses the gateway's normal tool bound and permits an admitted model call beyond the old inner deadline", async () => {
  const f = await fixture();
  const args = await documentArgs(f);
  const tool = createKnowledgeRequirementsProvider(f.deps)
    .tools()
    .find((candidate) => candidate.name === "knowledge.review");
  expect(tool?.descriptor.bounds.maxDurationMs).toBe(GATEWAY_BUFFERED_BUDGET_FLOOR_MS);
  vi.useFakeTimers();
  try {
    const generated = vi.fn(
      () =>
        new Promise<NormalizedResponse>((resolve) => {
          setTimeout(() => {
            resolve(response({ complete: true, findings: [] }));
          }, 181_000);
        }),
    );
    Object.assign(f.deps, { modelPortFactory: () => ({ call: generated }) });
    const work = call(f, "knowledge.review", args);
    await vi.advanceTimersByTimeAsync(181_000);
    expect(await work).toMatchObject({ outcome: "succeeded" });
    expect(generated).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("retains an earlier caller cancellation while the review model has not settled", async () => {
  const f = await fixture();
  const args = await documentArgs(f);
  const controller = new AbortController();
  const confirm = vi.fn();
  let resolveModel: (value: NormalizedResponse) => void = () => undefined;
  const pending = new Promise<NormalizedResponse>((resolve) => {
    resolveModel = resolve;
  });
  const generated = vi.fn(() => pending);
  Object.assign(f.deps, { modelPortFactory: () => ({ call: generated }) });
  const work = call(f, "knowledge.review", args, {
    signal: controller.signal,
    confirmModelOperation: confirm,
  });
  await vi.waitFor(() => {
    expect(generated).toHaveBeenCalledOnce();
  });
  controller.abort();
  expect(await work).toMatchObject({ outcome: "failed" });
  expect(confirm).not.toHaveBeenCalled();
  resolveModel(response({ complete: true, findings: [] }));
});
