import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { looksLikeSecretShape } from "@oscharko-dev/keiko-contracts/runtime/memory";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

// The failing WebKit smoke run's chat id: its digits across the last hyphen are Luhn-valid.
const FLAGGED_ID = "1404206d-9ab6-4bca-8853-813867352087";
const CLEAN_ID = "0f7c2e9a-3b1d-4c5e-9a8b-7d6c5b4a3f2e";

const randomUUIDMock = vi.hoisted(() => vi.fn<() => string>());

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  randomUUIDMock.mockImplementation(() => actual.randomUUID());
  return { ...actual, randomUUID: randomUUIDMock };
});

const { MAX_REFERENCE_ID_DRAWS, ReferenceIdExhaustedError, newReferenceId } =
  await import("./reference-id.js");
const { createInMemoryUiStore } = await import("./store/index.js");
const { createBufferedServerLogSink, createServerLogger, resetServerLogger, setServerLogger } =
  await import("./observability/index.js");

function draws(...ids: string[]): () => string {
  const queue = [...ids];
  return (): string => queue.shift() ?? CLEAN_ID;
}

function captureServerLog(): ReturnType<typeof createBufferedServerLogSink> {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "debug" }));
  return sink;
}

afterEach(() => {
  resetServerLogger();
});

describe("newReferenceId (#3557 review)", () => {
  it("pins the fixture: the flagged id trips the shared heuristic and the clean one does not", () => {
    expect(looksLikeSecretShape(FLAGGED_ID)).toBe(true);
    expect(looksLikeSecretShape(CLEAN_ID)).toBe(false);
  });

  it("returns a clean first draw and records nothing", () => {
    const sink = captureServerLog();

    expect(newReferenceId({ kind: "chat", draw: draws(CLEAN_ID) })).toBe(CLEAN_ID);
    expect(sink.events.filter((event) => event.op.startsWith("reference-id."))).toEqual([]);
  });

  // #3557 review: the re-draw must leave typed, correlated evidence with its attempt count.
  it("draws again when the heuristic flags an id, and records the re-draw", () => {
    const sink = captureServerLog();

    const id = newReferenceId({
      kind: "chat",
      correlationId: "corr-create-chat-0001",
      draw: draws(FLAGGED_ID, FLAGGED_ID, CLEAN_ID),
    });

    expect(id).toBe(CLEAN_ID);
    const [event] = sink.events.filter((line) => line.op === "reference-id.redrawn");
    expect(
      expectActivityLogProof("reference-id.redrawn.line", formatActivityLogProofLine(event ?? {})),
    ).toMatchObject({
      level: "info",
      correlationId: "corr-create-chat-0001",
      kind: "chat",
      flaggedDraws: 2,
      completeness: "complete",
      loss: "none",
    });
    expect(JSON.stringify(sink.events)).not.toContain(FLAGGED_ID);
  });

  it("checks the id with its prefix", () => {
    expect(
      newReferenceId({ kind: "qi-run", prefix: "qi-run-", draw: draws(FLAGGED_ID, CLEAN_ID) }),
    ).toBe(`qi-run-${CLEAN_ID}`);
    expect(
      newReferenceId({
        kind: "figma-snapshot-run",
        prefix: "fs-",
        draw: draws(FLAGGED_ID, CLEAN_ID),
      }),
    ).toBe(`fs-${CLEAN_ID}`);
  });

  // #3557 review: exhaustion is a typed failure with a closed error kind, never a bare Error.
  it("fails loudly with typed evidence when the random source keeps producing flagged ids", () => {
    const sink = captureServerLog();

    expect(() =>
      newReferenceId({
        kind: "agent-run",
        correlationId: "corr-start-run-0001",
        draw: () => FLAGGED_ID,
      }),
    ).toThrow(ReferenceIdExhaustedError);

    const [event] = sink.events.filter((line) => line.op === "reference-id.exhausted");
    expect(
      expectActivityLogProof(
        "reference-id.exhausted.line",
        formatActivityLogProofLine(event ?? {}),
      ),
    ).toMatchObject({
      level: "error",
      correlationId: "corr-start-run-0001",
      errorKind: "internal",
      kind: "agent-run",
      flaggedDraws: MAX_REFERENCE_ID_DRAWS,
    });
  });

  it("never returns an id the heuristic flags from the real random source", () => {
    for (let index = 0; index < 2_000; index += 1) {
      const id = newReferenceId({ kind: "chat" });
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      expect(looksLikeSecretShape(id)).toBe(false);
    }
  });
});

// The browser persists a chat id as its window's reference, so the store must never issue one the
// persistence heuristic redacts, and the re-draw joins the creating request's timeline.
describe("UI store chat ids", () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("issues a chat id the heuristic never flags, under the creating request's correlation", () => {
    tmp = mkdtempSync(join(tmpdir(), "keiko-reference-id-"));
    const project = join(tmp, "p");
    mkdirSync(project);
    const sink = captureServerLog();
    const store = createInMemoryUiStore({ now: () => 1 });
    try {
      store.createProject(project);
      randomUUIDMock.mockReturnValueOnce(FLAGGED_ID).mockReturnValueOnce(CLEAN_ID);

      const chat = store.createChat(project, "Deploy status", "example-chat-model", {
        correlationId: "corr-create-chat-0002",
      });

      expect(chat.id).toBe(CLEAN_ID);
      expect(sink.events.filter((line) => line.op === "reference-id.redrawn")).toEqual([
        expect.objectContaining({
          correlationId: "corr-create-chat-0002",
          extra: expect.objectContaining({ kind: "chat", flaggedDraws: 1 }) as unknown,
        }),
      ]);
    } finally {
      store.close();
    }
  });
});
