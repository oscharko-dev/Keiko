import { activityLogOperationSchema } from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  KNOWLEDGE_REVIEW_FAILURE_STAGES,
  KNOWLEDGE_REVIEW_VALIDATION_REASONS,
} from "@oscharko-dev/keiko-contracts/runtime/knowledge-turn-coverage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  createDefaultChatCapability,
  parseGatewayConfig,
  type GatewayCallRequest,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import {
  compileExternalCatalogSchema,
  describeCatalogSchemaMismatch,
} from "@oscharko-dev/keiko-tool-catalog";
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
import { encodeCursor } from "./requirement-inventory.js";
import { GATEWAY_BUFFERED_BUDGET_FLOOR_MS } from "@oscharko-dev/keiko-model-gateway/internal/resilience";
import { REVIEW_WINDOW_CHARS, parseSemanticReview } from "./knowledge-semantic-review.js";
import { executeKnowledgeTool } from "./knowledge-tool-execution.js";
import { buildRedactor } from "./deps.js";

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
  const result = await tool.execute(args, context(f, override));
  expect(describeCatalogSchemaMismatch(tool.descriptor.resultSchema, result.data)).toBeUndefined();
  return result.data;
}
function items(page: CatalogJsonObject): readonly CatalogJsonObject[] {
  return page.items as readonly CatalogJsonObject[];
}
function itemText(page: CatalogJsonObject): string {
  const text = items(page)[0]?.text;
  if (typeof text !== "string") throw new Error("Expected source text.");
  return text;
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
function reviewAnchorTexts(request: GatewayCallRequest): readonly string[] {
  const prompt = request.messages.find((message) => message.role === "user")?.content;
  if (typeof prompt !== "string") throw new Error("Expected the review prompt.");
  const parsed: unknown = JSON.parse(prompt);
  if (parsed === null || typeof parsed !== "object" || !("anchors" in parsed))
    throw new Error("Expected source anchors.");
  if (!Array.isArray(parsed.anchors)) throw new Error("Expected source anchors.");
  return parsed.anchors.map((anchor: unknown) => {
    if (anchor === null || typeof anchor !== "object" || !("text" in anchor))
      throw new Error("Expected source text.");
    if (typeof anchor.text !== "string") throw new Error("Expected source text.");
    return anchor.text;
  });
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
    const altered = await call(f, "knowledge.documents", {
      view: "search",
      query: "needle",
      cursor: (typeof first.nextCursor === "string" ? first.nextCursor : "").replace(/^\d+/u, "0"),
    });
    expect(altered).toMatchObject({ outcome: "failed", reason: "cursor-stale" });
    addDocuments(f, 252);
    const restart = await call(f, "knowledge.documents", { view: "search", query: "absent" });
    const parsed = decodeKnowledgeCursor(
      typeof restart.nextCursor === "string" ? restart.nextCursor : "",
    );
    expect(parsed).toBeDefined();
    const skipped = await call(f, "knowledge.documents", {
      view: "search",
      query: "absent",
      cursor: encodeCursor({ offset: 251 * 4_000_001, fingerprint: parsed?.fingerprint ?? "" }),
    });
    expect(skipped).toMatchObject({
      outcome: "succeeded",
      coverage: { documentsVisited: 1, atEnd: true, searchComplete: false },
    });
  });

  it("searches only the credential-safe projection and reports its own coordinates", async () => {
    const secret = "configured-private-credential-value";
    const source = `Before ${secret} after-marker.`;
    const f = await fixture(source);
    const redact = vi.fn(buildRedactor({ FIGMA_ACCESS_TOKEN: secret }));
    Object.assign(f.deps, { redactor: redact });
    const projected = redact(source);
    if (typeof projected !== "string") throw new Error("Expected a string projection.");
    expect(projected).not.toContain(secret);
    for (const query of [secret, "configured-private", "credential-value"]) {
      redact.mockClear();
      const page = await call(f, "knowledge.documents", { view: "search", query });
      expect(page).toMatchObject({ outcome: "succeeded", items: [] });
      expect(redact.mock.calls.filter(([value]) => value === source)).toHaveLength(1);
      expect(JSON.stringify(page)).not.toContain("characterStart");
      expect(JSON.stringify(page)).not.toContain("characterEnd");
    }
    const page = await call(f, "knowledge.documents", { view: "search", query: "after-marker" });
    expect(items(page)).toHaveLength(1);
    expect(items(page)[0]).toMatchObject({
      positionSpace: "redacted-document-text",
      characterStart: projected.indexOf("after-marker"),
      characterEnd: projected.indexOf("after-marker") + "after-marker".length,
      text: projected,
    });
    expect(projected.indexOf("after-marker")).not.toBe(source.indexOf("after-marker"));
    expect(JSON.stringify(page)).not.toContain(secret);
    const read = await call(f, "knowledge.documents", { view: "read", ...(await documentArgs(f)) });
    expect(items(read)[0]).toMatchObject({ positionSpace: "original-document-text" });
  });

  it.each(["knowledge.documents", "knowledge.review"] as const)(
    "rejects unexpected fields in actual %s result payloads",
    async (name) => {
      const f = await fixture();
      Object.assign(f.deps, {
        modelPortFactory: () => ({
          call: (): Promise<NormalizedResponse> =>
            Promise.resolve(
              response({
                complete: true,
                findings: [
                  {
                    kind: "obligation",
                    anchors: [0],
                    proposal: "Preserve the obligation.",
                    question: "",
                  },
                ],
              }),
            ),
        }),
      });
      const args = await documentArgs(f);
      const page = await call(f, name, {
        ...args,
        ...(name === "knowledge.documents" ? { view: "read" } : {}),
      });
      const tool = createKnowledgeRequirementsProvider(f.deps)
        .tools()
        .find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error("Expected the Knowledge tool.");
      const first = items(page)[0];
      if (first === undefined) throw new Error("Expected a real result item.");
      const schema = tool.descriptor.resultSchema;
      expect(
        describeCatalogSchemaMismatch(schema, {
          ...page,
          items: [{ ...first, rawPath: "unexpected" }],
        }),
      ).toBeDefined();
      expect(
        describeCatalogSchemaMismatch(schema, { ...page, coverage: { rawText: "unexpected" } }),
      ).toBeDefined();
      expect(
        describeCatalogSchemaMismatch(schema, { ...page, totals: { rawText: "unexpected" } }),
      ).toBeDefined();
    },
  );

  it("does not certify unreadable source as a complete search", async () => {
    const f = await fixture("A source that cannot be read.");
    f.withStore((store) => {
      store._internal.db
        .prepare("UPDATE documents SET status = 'unsupported' WHERE id = 'doc-cap-documents'")
        .run();
    });
    expect(await call(f, "knowledge.documents", { view: "search", query: "source" })).toMatchObject(
      {
        outcome: "succeeded",
        items: [],
        coverage: { documentReadable: false, searchComplete: false, atEnd: true },
      },
    );
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

  it("shrinks escaped source windows to the actual serialized bound without losing text", async () => {
    const f = await fixture("Initial source.");
    const source = "\u0001".repeat(7000);
    f.withStore((store) => {
      store._internal.db
        .prepare("UPDATE document_texts SET normalized_text = ?")
        .run(store._internal.contentCipher.sealText(source));
    });
    const args = await documentArgs(f);
    const pieces: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(f, "knowledge.documents", {
        ...args,
        view: "read",
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.outcome).toBe("succeeded");
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(29_952);
      expect(page.contentTrust).toBe("untrusted-document-text");
      pieces.push(itemText(page));
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    } while (cursor !== undefined && pieces.length < 10);
    expect(cursor).toBeUndefined();
    expect(pieces.join("")).toBe(source);
    expect(pieces.length).toBeGreaterThan(1);
  });

  it("keeps Unicode source characters intact across read windows", async () => {
    const source = `${"x".repeat(4999)}😀tail`;
    const f = await fixture(source);
    const args = await documentArgs(f);
    const first = await call(f, "knowledge.documents", { ...args, view: "read" });
    const last = await call(f, "knowledge.documents", {
      ...args,
      view: "read",
      cursor: first.nextCursor ?? "",
    });
    expect(items(first)[0]).toMatchObject({ characterEnd: 4999 });
    expect(items(last)[0]).toMatchObject({ characterStart: 4999, text: "😀tail" });
    expect(itemText(first) + itemText(last)).toBe(source);
  });

  it("refuses real references from a Pod selected only by another Chat", async () => {
    const f = await podFixture(
      [
        { capsuleId: "cap-a", text: specification(1, { prefix: "AA" }).text, name: "selected.md" },
        { capsuleId: "cap-b", text: specification(1, { prefix: "BB" }).text, name: "foreign.md" },
      ],
      { redactor: (value) => value },
    );
    fixtures.push(f);
    const [podA, podB] = f.capsuleIds;
    if (podA === undefined || podB === undefined) throw new Error("Expected both Pods.");
    const other = f.deps.store.createChat(f.runtimeDir, "Other selection", "chat-model");
    f.deps.store.updateChat(f.chatId, {
      localKnowledgeScopes: [{ kind: "capsule", capsuleId: podA, connectedAtMs: 1 }],
    });
    f.deps.store.updateChat(other.id, {
      localKnowledgeScopes: [{ kind: "capsule", capsuleId: podB, connectedAtMs: 1 }],
    });
    const foreignInventory = await call(
      f,
      "knowledge.documents",
      { view: "inventory" },
      { chatId: other.id },
    );
    const foreign = items(foreignInventory)[0];
    if (foreign === undefined) throw new Error("Expected the other Chat's real document.");
    const foreignScope = foreign.documentScope;
    const foreignRevision = foreign.revisionDigest;
    if (typeof foreignScope !== "string" || typeof foreignRevision !== "string")
      throw new Error("Expected the foreign document reference.");
    const foreignArgs = { documentScope: foreignScope, revisionDigest: foreignRevision };
    const generated = vi.fn(() => Promise.resolve(response({ complete: true, findings: [] })));
    Object.assign(f.deps, { modelPortFactory: () => ({ call: generated }) });
    expect((await call(f, "knowledge.review", foreignArgs, { chatId: other.id })).outcome).toBe(
      "succeeded",
    );
    expect(generated).toHaveBeenCalledOnce();
    expect(await call(f, "knowledge.documents", { ...foreignArgs, view: "read" })).toMatchObject({
      outcome: "failed",
    });
    expect(await call(f, "knowledge.review", foreignArgs)).toMatchObject({ outcome: "failed" });
    expect(generated).toHaveBeenCalledOnce();
    const inventory = await call(f, "knowledge.documents", { view: "inventory" });
    expect(items(inventory)).toHaveLength(1);
    expect(JSON.stringify(inventory)).not.toContain(foreignScope);
    expect(JSON.stringify(inventory)).not.toContain("foreign.md");
    const search = await call(f, "knowledge.documents", {
      ...foreignArgs,
      view: "search",
      query: "BB-001",
    });
    expect(items(search)).toEqual([]);
    const units = await call(f, "knowledge.requirements", { documents: [foreignScope] });
    expect(items(units)).toEqual([]);
    expect(JSON.stringify([search, units])).not.toContain("BB-001");
  });

  it("applies the production credential floor to names, search, anchors, proposals and logs", async () => {
    const secret = "configured-floor-private-credential";
    const f = await podFixture(
      [
        {
          capsuleId: "floor-pod",
          text: `A visible obligation contains ${secret}.`,
          name: `${secret}.md`,
        },
      ],
      { redactor: buildRedactor({ FIGMA_ACCESS_TOKEN: secret }) },
    );
    fixtures.push(f);
    const requests: GatewayCallRequest[] = [];
    Object.assign(f.deps, {
      modelPortFactory: () => ({
        call: (request: GatewayCallRequest): Promise<NormalizedResponse> => {
          requests.push(request);
          return Promise.resolve(
            response({
              complete: true,
              findings: [
                {
                  kind: "clarification",
                  anchors: [0],
                  proposal: `Verify ${secret}.`,
                  question: `Is ${secret} available?`,
                },
              ],
            }),
          );
        },
      }),
    });
    const inventory = await call(f, "knowledge.documents", { view: "inventory" });
    const args = await documentArgs(f);
    const read = await call(f, "knowledge.documents", { ...args, view: "read" });
    const search = await call(f, "knowledge.documents", { view: "search", query: "visible" });
    const review = await call(f, "knowledge.review", args);
    expect(items(search)).toHaveLength(1);
    expect(items(review)).toHaveLength(1);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (request === undefined) throw new Error("Expected the model request.");
    expect(reviewAnchorTexts(request).join("")).toContain("visible");
    const events = sink.events.filter((event) => event.op === "knowledge.documents.operation");
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify([inventory, read, search, review, requests, events])).not.toContain(
      secret,
    );
  });

  it("explains stale-cursor recovery without continuing a refused cursor", async () => {
    const f = await fixture("Read this immutable text. ".repeat(300));
    const args = await documentArgs(f);
    const first = await call(f, "knowledge.documents", { ...args, view: "read" });
    f.withStore((store) => {
      store._internal.db
        .prepare("UPDATE document_texts SET normalized_text = ?")
        .run(store._internal.contentCipher.sealText("The source has changed."));
    });
    const stale = await call(f, "knowledge.documents", {
      ...args,
      view: "read",
      cursor: first.nextCursor ?? "",
    });
    expect(stale).toMatchObject({ outcome: "failed", reason: "cursor-stale" });
    expect(stale.nextStep).toContain("inventory");
    expect(stale.nextCursor).toBeUndefined();
    const denied = await call(f, "knowledge.review", args, { beforeEffect: () => false });
    expect(denied).toMatchObject({ outcome: "failed", reason: "denied" });
    expect(denied.nextCursor).toBeUndefined();
  });

  it("records a real registered body-free read, refusal and analyzer timeline", async () => {
    const registration = activityLogOperationSchema("knowledge.documents.operation");
    expect(registration?.fields.reviewFailureStage?.values).toEqual(
      KNOWLEDGE_REVIEW_FAILURE_STAGES,
    );
    expect(registration?.fields.reviewValidationReason?.values).toEqual(
      KNOWLEDGE_REVIEW_VALIDATION_REASONS,
    );
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

  it("pages review windows without importing completion from the shared finding cache", async () => {
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
      reviewedWindows: 1,
      totalWindows: 129,
      documentReviewComplete: false,
    });
    expect(generated).toHaveBeenCalledTimes(129);
  }, 30_000);

  it("does not import another turn's review windows when returning a cached last window", async () => {
    const f = await fixture("A source window. ".repeat(500));
    const generated = vi.fn(() => Promise.resolve(response({ complete: true, findings: [] })));
    Object.assign(f.deps, { modelPortFactory: () => ({ call: generated }) });
    const args = await documentArgs(f);
    const first = await call(f, "knowledge.review", args, { userMessageId: "older-turn" });
    const lastArgs = { ...args, cursor: first.nextCursor ?? "" };
    const olderLast = await call(f, "knowledge.review", lastArgs, {
      userMessageId: "older-turn",
    });
    expect(olderLast.outcome).toBe("succeeded");
    const currentLast = await call(f, "knowledge.review", lastArgs, {
      userMessageId: "current-turn",
    });
    expect(currentLast.coverage).toMatchObject({
      cached: true,
      reviewedWindows: 1,
      totalWindows: 2,
      windowReviewComplete: true,
      documentReviewComplete: false,
    });
    expect(generated).toHaveBeenCalledTimes(2);
  });

  it("keeps Unicode review anchors and returned cursors on character boundaries", async () => {
    const source = `${"x".repeat(5999)}😀${"y".repeat(5999)}`;
    const f = await fixture(source);
    const requests: GatewayCallRequest[] = [];
    const generated = vi.fn((request: GatewayCallRequest) => {
      requests.push(request);
      return Promise.resolve(response({ complete: true, findings: [] }));
    });
    Object.assign(f.deps, { modelPortFactory: () => ({ call: generated }) });
    const args = await documentArgs(f);
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await call(f, "knowledge.review", {
        ...args,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.outcome).toBe("succeeded");
      expect(page.coverage).toMatchObject({ totalWindows: 3 });
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      pages++;
    } while (cursor !== undefined && pages < 5);
    expect(pages).toBe(3);
    const anchors = requests.flatMap(reviewAnchorTexts);
    expect(anchors.join("")).toBe(source);
    expect(anchors.some((anchor) => /[\ud800-\udbff]$/u.test(anchor))).toBe(false);
    expect(anchors.some((anchor) => /^[\udc00-\udfff]/u.test(anchor))).toBe(false);
  });

  it("rechecks the current authority before spending a model call", async () => {
    const f = await fixture();
    const args = await documentArgs(f);
    const generated = vi.fn(() => Promise.resolve(response({ complete: true, findings: [] })));
    const factory = vi.fn(() => ({ call: generated }));
    Object.assign(f.deps, { modelPortFactory: factory });
    const beforeEffect = vi.fn(() => false).mockReturnValueOnce(true);
    const page = await call(f, "knowledge.review", args, { beforeEffect });
    expect(page).toMatchObject({ outcome: "failed", reason: "denied" });
    expect(factory).not.toHaveBeenCalled();
    expect(generated).not.toHaveBeenCalled();
  });

  it("continues after an invalid middle window without certifying it as reviewed", async () => {
    const f = await fixture("Initial source.");
    f.withStore((store) => {
      store._internal.db
        .prepare("UPDATE document_texts SET normalized_text = ?")
        .run(store._internal.contentCipher.sealText("x".repeat(3 * REVIEW_WINDOW_CHARS)));
    });
    const generated = vi.fn(() => Promise.resolve(response({ complete: true, findings: [] })));
    generated.mockResolvedValueOnce(response({ complete: true, findings: [] }));
    generated.mockResolvedValueOnce(
      response({
        complete: true,
        findings: [
          { kind: "obligation", anchors: [999], proposal: "Invalid source.", question: "" },
        ],
      }),
    );
    Object.assign(f.deps, { modelPortFactory: () => ({ call: generated }) });
    const args = await documentArgs(f);
    const first = await call(f, "knowledge.review", args);
    const middle = await call(f, "knowledge.review", { ...args, cursor: first.nextCursor ?? "" });
    expect(middle).toMatchObject({
      outcome: "failed",
      reason: "model-output-invalid",
      coverage: {
        windowSkipped: true,
        failedWindows: 1,
        windowReviewComplete: false,
        documentReviewComplete: false,
      },
    });
    expect(middle.nextCursor).toBeTypeOf("string");
    const last = await call(f, "knowledge.review", { ...args, cursor: middle.nextCursor ?? "" });
    expect(last).toMatchObject({
      outcome: "succeeded",
      coverage: { characterStart: 2 * REVIEW_WINDOW_CHARS, documentReviewComplete: false },
    });
    expect(last.nextCursor).toBeUndefined();
    expect(generated).toHaveBeenCalledTimes(3);
  });

  it.each(["model-port-unavailable", "budget-port-unavailable"] as const)(
    "distinguishes %s from invalid model output while retaining an available source",
    async (stage) => {
      const f = await fixture();
      const args = await documentArgs(f);
      const generated = vi.fn(() => Promise.resolve(response({ complete: true, findings: [] })));
      Object.assign(f.deps, {
        modelPortFactory: () =>
          stage === "model-port-unavailable" ? undefined : { call: generated },
      });
      const reviewContext = { ...context(f) };
      if (stage === "budget-port-unavailable") delete reviewContext.meterModel;
      const tool = createKnowledgeRequirementsProvider(f.deps)
        .tools()
        .find((candidate) => candidate.name === "knowledge.review");
      if (tool === undefined) throw new TypeError("Missing synthetic review tool");
      const result = (await tool.execute(args, reviewContext)).data;
      expect(result).toMatchObject({
        outcome: "failed",
        reason: stage,
        failureStage: stage,
        sourceAvailable: true,
      });
      expect(result).not.toHaveProperty("validationReason");
      expect(result).not.toHaveProperty("items");
      expect(generated).not.toHaveBeenCalled();
      const event = sink.events.find(
        (event) =>
          event.op === "knowledge.documents.operation" && event.extra?.reviewFailureStage === stage,
      );
      expect(event?.extra).toMatchObject({
        operation: "review",
        disposition: "refused",
        returnedCount: 0,
        cached: false,
      });
      expect(event?.extra?.reviewFinishReason).toBeUndefined();
      expect(Number(event?.extra?.sourceChars)).toBeGreaterThan(0);
      expectActivityLogProof(
        "knowledge.documents.operation.line",
        formatActivityLogProofLine(event ?? {}),
      );
    },
  );

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
      reason: "model-output-invalid",
      failureStage: "model-output-invalid",
      validationReason: "anchor-range",
      sourceAvailable: true,
    });
    expect(await call(f, "knowledge.review", args)).toMatchObject({ outcome: "failed" });
    expect(generated).toHaveBeenCalledTimes(2);
    const refused = sink.events.filter(
      (event) =>
        event.op === "knowledge.documents.operation" &&
        event.extra?.reviewValidationReason === "anchor-range",
    );
    expect(refused).toHaveLength(2);
    expect(refused[0]?.extra).toMatchObject({
      operation: "review",
      disposition: "refused",
      returnedCount: 0,
      cached: false,
      reviewFailureStage: "model-output-invalid",
      reviewFinishReason: "stop",
      reviewFindingCount: 1,
      reviewFindingIndex: 0,
      reviewAnchorIndex: 0,
    });
    expectActivityLogProof(
      "knowledge.documents.operation.line",
      formatActivityLogProofLine(refused[0] ?? {}),
    );
    expect(JSON.stringify(refused)).not.toMatch(/Invented|doc-cap-documents/);
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

it.each(["complete", "partial", "invalid", "stale", "invalid-stale", "cancelled"])(
  "confirms only a parsed semantic result admitted against the final scope (%s)",
  async (kind) => {
    const f = await fixture();
    const args = await documentArgs(f);
    const controller = new AbortController();
    const confirm = vi.fn();
    const value = response({ complete: kind !== "partial", findings: [] });
    const generated = vi.fn(() => {
      if (kind === "stale" || kind === "invalid-stale")
        f.withStore((store) =>
          store._internal.db
            .prepare("UPDATE document_texts SET normalized_text = ?")
            .run(store._internal.contentCipher.sealText("A changed current source.")),
        );
      if (kind === "cancelled") controller.abort();
      return Promise.resolve(
        kind === "invalid" || kind === "invalid-stale"
          ? { ...value, finishReason: "length" as const }
          : value,
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
      if (kind === "partial") {
        expect(items(result)).toHaveLength(0);
        expect(result.nextStep).toBe(
          "This window review is incomplete. Read its source and resolve the remaining questions.",
        );
        const partial = {
          windowReviewComplete: false,
          documentReviewComplete: false,
          cached: false,
        };
        expect(result.coverage).toMatchObject({ ...partial, originalModified: false });
        const repeated = await call(f, "knowledge.review", args);
        expect(repeated.coverage).toMatchObject(partial);
        expect(generated).toHaveBeenCalledTimes(2);
      }
    } else {
      expect(result.outcome).toBe("failed");
      expect(confirm).not.toHaveBeenCalled();
      if (kind === "invalid-stale") {
        expect(result.reason).toBe("source-changed");
        expect(result).not.toHaveProperty("sourceAvailable");
        expect(result).not.toHaveProperty("failureStage");
      }
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
  expect(result).toMatchObject({
    outcome: "failed",
    reason: "model-output-invalid",
    failureStage: "model-output-invalid",
    validationReason: "json-syntax",
    sourceAvailable: true,
  });
  const refusal = sink.events.find(
    (event) =>
      event.op === "knowledge.documents.operation" &&
      event.extra?.reviewValidationReason === "json-syntax",
  );
  expect(refusal?.extra).toMatchObject({
    returnedCount: 0,
    reviewFinishReason: "stop",
    reviewOutputChars: malformed.content.length,
  });
  expectActivityLogProof(
    "knowledge.documents.operation.line",
    formatActivityLogProofLine(refusal ?? {}),
  );
  expect(JSON.stringify(sink.events)).not.toContain(malformed.content);
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
          }, GATEWAY_BUFFERED_BUDGET_FLOOR_MS + 1);
        }),
    );
    Object.assign(f.deps, { modelPortFactory: () => ({ call: generated }) });
    const work = call(f, "knowledge.review", args);
    await vi.advanceTimersByTimeAsync(GATEWAY_BUFFERED_BUDGET_FLOOR_MS + 1);
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

describe("actual semantic review request source-bound schema", () => {
  it.each([true, false])(
    "binds the actual one-anchor instruction and optional wire format (%s)",
    async (supportsResponseFormat) => {
      const f = await fixture("A short original source window with exactly one anchor.");
      const modelId = f.deps.store.findChatById(f.chatId)?.selectedModel;
      if (modelId === undefined) throw new TypeError("Missing review model fixture");
      const requests: GatewayCallRequest[] = [];
      Object.assign(f.deps, {
        config: parseGatewayConfig({
          providers: [
            {
              modelId,
              baseUrl: "https://semantic-schema.example.invalid/v1",
              apiKey: "synthetic-schema-key",
            },
          ],
          capabilities: [
            {
              ...createDefaultChatCapability(modelId),
              supportsResponseFormat,
              maxOutputTokens: 4096,
              contextWindow: 32768,
            },
          ],
        }),
        modelPortFactory: () => ({
          call: (request: GatewayCallRequest): Promise<NormalizedResponse> => {
            requests.push(request);
            return Promise.resolve(response({ complete: true, findings: [] }));
          },
        }),
      });
      const args = await documentArgs(f);
      expect(await call(f, "knowledge.review", args)).toMatchObject({ outcome: "succeeded" });
      expect(requests).toHaveLength(1);
      const request = requests[0];
      if (request === undefined) throw new TypeError("Review request was not captured");
      const system = request.messages[0]?.content;
      if (typeof system !== "string") throw new TypeError("Missing review instruction");
      const schemaStart = system.indexOf(
        "Return only JSON matching this schema, in the source's language: ",
      );
      const schemaEnd = system.indexOf(" Set complete false", schemaStart);
      const prefix = "Return only JSON matching this schema, in the source's language: ";
      expect(schemaStart).toBeGreaterThanOrEqual(0);
      expect(schemaEnd).toBeGreaterThan(schemaStart);
      const schema = JSON.parse(
        system.slice(schemaStart + prefix.length, schemaEnd),
      ) as CatalogJsonObject;
      if (supportsResponseFormat)
        expect(request.responseFormat).toMatchObject({ type: "json_schema", schema });
      else expect(request.responseFormat).toBeUndefined();
      const compiled = compileExternalCatalogSchema(schema);
      const finding = {
        kind: "obligation",
        anchors: [0],
        proposal: "A source-grounded proposal.",
        question: "",
      };
      expect(
        describeCatalogSchemaMismatch(compiled, { complete: true, findings: [finding] }),
      ).toBeUndefined();
      // Both shapes were accepted by the former static outbound schema and rejected by the parser.
      expect(
        describeCatalogSchemaMismatch(compiled, {
          complete: true,
          findings: [{ ...finding, kind: "conflict" }],
        }),
      ).toBeDefined();
      expect(
        describeCatalogSchemaMismatch(compiled, {
          complete: true,
          findings: [{ ...finding, anchors: [1] }],
        }),
      ).toBeDefined();
    },
  );
});
