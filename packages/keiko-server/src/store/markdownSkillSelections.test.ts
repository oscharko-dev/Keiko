import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryUiStore, createNodeUiStore } from "./index.js";
import type { NewChatMessage, UiStore } from "./types.js";
import {
  protectMarkdownSkillRequest,
  withMarkdownSkillAdmission,
} from "../markdown-skill-admission.js";
import type { GatewayCallRequest, GatewayStreamChunk } from "@oscharko-dev/keiko-model-gateway";
import type { ModelPort } from "@oscharko-dev/keiko-harness";

const stores: UiStore[] = [];
const directories: string[] = [];
function fixture(): { store: UiStore; chatId: string } {
  const store = createInMemoryUiStore();
  stores.push(store);
  const directory = mkdtempSync(join(tmpdir(), "keiko-skill-selection-"));
  directories.push(directory);
  const project = store.createProject(directory);
  return { store, chatId: store.createChat(project.path, "Skill check", "test-model").id };
}
function user(chatId: string): NewChatMessage {
  return {
    chatId,
    role: "user",
    content: "Review this example.",
    timestamp: 1,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
}
function upload(body: string): { fileName: string; contentBase64: string } {
  return { fileName: "method.md", contentBase64: Buffer.from(body).toString("base64") };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("protected skill selection and accepted-turn binding (#4024)", () => {
  it("restores exact selections and turn bindings after reopening without cross-chat activation", () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-skill-restore-"));
    directories.push(directory);
    const path = join(directory, "ui.sqlite");
    const first = createNodeUiStore(path);
    const project = first.createProject(directory);
    const chat = first.createChat(project.path, "Restore", "test-model");
    const sibling = first.createChat(project.path, "Sibling", "test-model");
    const skill = first.markdownSkills.import(upload("# Method\nPreserve this revision."));
    const selection = first.markdownSkills.select(chat.id, skill, 0);
    const message = first.createMessage(user(chat.id));
    first.close();
    const reopened = createNodeUiStore(path);
    stores.push(reopened);
    expect(reopened.markdownSkills.selection(chat.id)).toEqual(selection);
    expect(reopened.markdownSkills.forTurn(message.id)).toEqual(skill);
    expect(reopened.markdownSkills.selection(sibling.id)).toEqual({ revision: 0, skill: null });
    expect(() => reopened.markdownSkills.select(chat.id, null, Number.MAX_SAFE_INTEGER)).toThrow(
      /revision/u,
    );
  });
  it("rechecks revocation at every physical attempt without widening caller admission", () => {
    const { store, chatId } = fixture();
    const library = store.markdownSkills;
    const request: GatewayCallRequest = { modelId: "test-model", messages: [] };
    const emptyTurn = store.createMessage(user(chatId));
    expect(protectMarkdownSkillRequest(request, library, emptyTurn.id)).toBe(request);
    const skill = library.import(upload("# Method\nPreserve this rule."));
    library.select(chatId, skill, 0);
    const turn = store.createMessage(user(chatId));
    const grant = { promptTokens: 1, maxOutputTokens: 1 };
    const protectedRequest = protectMarkdownSkillRequest(request, library, turn.id);
    const admitted = protectedRequest.attemptAdmission?.(grant);
    expect(admitted).toBeDefined();
    admitted?.settle(undefined, false);
    const refused = protectMarkdownSkillRequest(
      { ...request, attemptAdmission: () => undefined },
      library,
      turn.id,
    );
    expect(refused.attemptAdmission?.(grant)).toBeUndefined();
    library.select(chatId, null, 1);
    expect(protectedRequest.attemptAdmission?.(grant)).toBeDefined();
    library.delete(skill.id, skill.revision);
    expect(() => protectedRequest.attemptAdmission?.(grant)).toThrow(/unavailable/u);
    expect(() => protectMarkdownSkillRequest(request, library, turn.id)).toThrow(/unavailable/u);
  });
  it("preserves a streaming model receiver and revalidates before lazy iteration", async () => {
    const { store, chatId } = fixture();
    const library = store.markdownSkills;
    const skill = library.import(upload("# Method\nUse a counterexample."));
    library.select(chatId, skill, 0);
    const turn = store.createMessage(user(chatId));
    const model: ModelPort & { readonly marker: string } = {
      marker: "receiver-preserved",
      call: () => Promise.reject(new Error("Expected streaming")),
      async *callStream(): AsyncGenerator<GatewayStreamChunk> {
        yield { type: "delta", token: await Promise.resolve(this.marker) };
      },
    };
    const guarded = withMarkdownSkillAdmission(model, library, turn.id);
    const request: GatewayCallRequest = { modelId: "test-model", messages: [] };
    const chunks: GatewayStreamChunk[] = [];
    for await (const chunk of guarded.callStream?.(request, new AbortController().signal) ?? [])
      chunks.push(chunk);
    expect(chunks).toEqual([{ type: "delta", token: model.marker }]);
    const pending = guarded
      .callStream?.(request, new AbortController().signal)
      [Symbol.asyncIterator]();
    library.delete(skill.id, 1);
    await expect(pending?.next()).rejects.toThrow(/unavailable/u);
  });
  it("starts empty and rejects stale or forged selections atomically", () => {
    const { store, chatId } = fixture();
    const library = store.markdownSkills;
    expect(library.selection(chatId)).toEqual({ revision: 0, skill: null });
    const skill = library.import(upload("# Method\nCheck boundaries."));
    const selected = library.select(chatId, skill, 0);
    expect(selected).toEqual({
      revision: 1,
      skill: { id: skill.id, revision: 1, digest: skill.digest },
    });
    expect(() => library.select(chatId, null, 0)).toThrow(/stale/u);
    expect(() => library.select(chatId, { ...skill, digest: "0".repeat(64) }, 1)).toThrow(
      /unavailable/u,
    );
    expect(library.selection(chatId)).toEqual(selected);
    expect(() => library.selection("missing-chat")).toThrow(/not found/iu);
  });

  it("pins each accepted user turn while later selection and replacement stay independent", () => {
    const { store, chatId } = fixture();
    const library = store.markdownSkills;
    const first = library.import(upload("# Method\nKeep this revision complete."));
    const noSkill = store.createMessage(user(chatId));
    library.select(chatId, first, 0);
    const accepted = store.admitChatTurn("turn-original", user(chatId));
    if (accepted.kind !== "admitted") throw new Error("Expected admitted turn");
    const next = library.replace(first.id, 1, upload("# Method\nA different revision."));
    expect(library.selection(chatId).skill?.revision).toBe(1);
    library.select(chatId, next, 1);
    expect(library.forTurn(noSkill.id)).toBeUndefined();
    expect(library.forTurn(accepted.userMessage.id)).toEqual(first);
    expect(
      store.listMessages(chatId).every((message) => !message.content.includes(first.body)),
    ).toBe(true);
    library.select(chatId, null, 2);
    expect(library.forTurn(accepted.userMessage.id)).toEqual(first);
  });

  it("refuses revoked selected revisions before admission and preserves their historical identity", () => {
    const { store, chatId } = fixture();
    const library = store.markdownSkills;
    const skill = library.import(upload("# Method\nRequire a counterexample."));
    library.select(chatId, skill, 0);
    const original = store.createMessage(user(chatId));
    library.delete(skill.id, 1);
    expect(library.selection(chatId).skill?.id).toBe(skill.id);
    expect(() => library.forTurn(original.id)).toThrow(/unavailable/u);
    const count = store.countMessages(chatId);
    expect(() => store.admitChatTurn("turn-revoked", user(chatId))).toThrow(/unavailable/u);
    expect(store.countMessages(chatId)).toBe(count);
    library.select(chatId, null, 1);
    expect(library.forTurn(store.createMessage(user(chatId)).id)).toBeUndefined();
  });
});
