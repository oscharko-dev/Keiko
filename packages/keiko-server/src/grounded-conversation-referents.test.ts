import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRedactor, type UiHandlerDeps } from "./deps.js";
import { createRunRegistry } from "./runs.js";
import { createInMemoryUiStore } from "./store/index.js";
import {
  type GroundedConversationContinuity,
  groundedConversationContinuity,
} from "./grounded-conversation-continuity.js";

function deps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    env: {},
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
  };
}

function resolve(
  current: string,
  history: readonly { readonly role: "user" | "assistant"; readonly content: string }[],
): GroundedConversationContinuity {
  const runtime = deps();
  const root = mkdtempSync(join(tmpdir(), "keiko-continuity-"));
  try {
    runtime.store.createProject(root, "Continuity");
    const chat = runtime.store.createChat(root, "Continuity", "fixture");
    let timestamp = 1;
    for (const message of [...history, { role: "user" as const, content: current }])
      runtime.store.createMessage({
        ...message,
        chatId: chat.id,
        timestamp: timestamp++,
        runId: undefined,
        workflowId: undefined,
        attachments: [],
      });
    const user = runtime.store.listMessages(chat.id).at(-1);
    if (user === undefined) throw new Error("Fixture user missing");
    return groundedConversationContinuity(runtime, user, "fixture");
  } finally {
    runtime.store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("assistant referents are a bounded independent retrieval channel", () => {
  it.each(["Siehst du sie jetzt?", "Can you see it now?"])(
    "carries a cited path for %s",
    (query) => {
      const result = resolve(query, [
        { role: "user", content: "Which validation routine fails?" },
        { role: "assistant", content: "The routine is here [src/Feature/validation.ts:301-305]." },
      ]);
      expect(result).toMatchObject({
        assistantReferents: [{ path: "src/Feature/validation.ts", line: 301, origin: "assistant" }],
        continuityReferentSource: "assistant-paths",
      });
      expect(result.retrievalContent).toContain(query);
    },
  );

  it("prioritizes declarations, then citations and other paths within the six-path cap", () => {
    const result = resolve("Try again", [
      { role: "user", content: "Explain the validation routine" },
      {
        role: "assistant",
        content: [
          "Missing evidence: [src/Feature/validation.ts]",
          "See [src/A.ts:3], [src/B.ts:4], `src/C.ts`, src/D.ts, src/E.ts and src/F.ts.",
        ].join("\n"),
      },
    ]);
    expect(result).toMatchObject({
      assistantReferents: [
        { path: "src/Feature/validation.ts", origin: "assistant" },
        { path: "src/A.ts", line: 3, origin: "assistant" },
        { path: "src/B.ts", line: 4, origin: "assistant" },
        { path: "src/C.ts", origin: "assistant" },
        { path: "src/D.ts", origin: "assistant" },
        { path: "src/E.ts", origin: "assistant" },
      ],
      continuityReferentSource: "assistant-paths-and-declaration",
    });
  });

  it("does not carry an assistant referent when the user names a different target", () => {
    const result = resolve("Explain src/Other/handler.ts now", [
      { role: "user", content: "Explain the validation routine" },
      { role: "assistant", content: "Read `src/Feature/validation.ts`." },
    ]);
    expect(result).toMatchObject({ assistantReferents: [], continuityReferentSource: "none" });
    expect(result.retrievalContent).toBe("Explain src/Other/handler.ts now");
  });

  it("uses only the latest assistant turn", () => {
    const result = resolve("What about now?", [
      { role: "user", content: "Explain the validation routine" },
      { role: "assistant", content: "Read `src/Old/validation.ts`." },
      { role: "user", content: "Explain the new state" },
      { role: "assistant", content: "The state is uncertain." },
    ]);
    expect(result).toMatchObject({ assistantReferents: [] });
  });

  it("keeps assistant paths when the current trace exceeds the previous-question prefix bound", () => {
    const query = `${"    at run (node:internal/tool:10:3)\n".repeat(200)}Can you see it now?`;
    const result = resolve(query, [
      { role: "user", content: "Explain the validation routine" },
      { role: "assistant", content: "Read `src/Feature/validation.ts`." },
    ]);
    expect(result.retrievalContent).toBe(query);
    expect(result).toMatchObject({
      assistantReferents: [{ path: "src/Feature/validation.ts", origin: "assistant" }],
    });
  });
});
