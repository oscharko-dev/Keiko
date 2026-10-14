import { describe, expect, it } from "vitest";
import {
  parseExpectedSkillSelectionRevision,
  markdownSkillSelectionRefusal,
} from "./markdown-skill-selection-admission.js";
import { createInMemoryUiStore } from "./store/index.js";
import { canonicalChatTurnIdentityContent } from "./chat-turn-identity.js";

describe("Composer skill selection preconditions", () => {
  it.each([-1, 0.5, "1", {}, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed revisions: %j",
    (value) => {
      expect(parseExpectedSkillSelectionRevision(value)).toMatchObject({ status: 400 });
    },
  );
  it.each([undefined, null, 0, 1, Number.MAX_SAFE_INTEGER])(
    "preserves a valid precondition: %j",
    (value) => {
      expect(parseExpectedSkillSelectionRevision(value)).toBe(value);
    },
  );
  it("allows legacy and current requests but refuses a stale Composer even after deselection", () => {
    const store = createInMemoryUiStore();
    try {
      const project = store.createProject(process.cwd());
      const chat = store.createChat(project.path, "Synthetic", "fixture");
      expect(markdownSkillSelectionRefusal({ store }, chat.id, undefined)).toBeUndefined();
      expect(markdownSkillSelectionRefusal({ store }, chat.id, 0)).toBeUndefined();
      store.markdownSkills.select(chat.id, null, 0);
      expect(markdownSkillSelectionRefusal({ store }, chat.id, 0, "skill-race")).toMatchObject({
        status: 409,
      });
      expect(markdownSkillSelectionRefusal({ store }, chat.id, 1)).toBeUndefined();
    } finally {
      store.close();
    }
  });
  it("binds idempotent turn semantics to the observed selection without changing legacy identities", () => {
    const input = {
      routeKind: "grounded",
      content: "Review",
      modelId: "fixture",
      groundingScopeIdentity: null,
      memory: null,
    } as const;
    const original = canonicalChatTurnIdentityContent(input);
    expect(
      canonicalChatTurnIdentityContent({ ...input, expectedSkillSelectionRevision: 0 }),
    ).not.toBe(original);
    expect(
      canonicalChatTurnIdentityContent({ ...input, expectedSkillSelectionRevision: 1 }),
    ).not.toBe(canonicalChatTurnIdentityContent({ ...input, expectedSkillSelectionRevision: 0 }));
  });

  it("permits an explicit no-skill request only while the server has no selected skill", () => {
    const store = createInMemoryUiStore();
    try {
      const project = store.createProject(process.cwd());
      const chat = store.createChat(project.path, "Synthetic", "fixture");
      expect(markdownSkillSelectionRefusal({ store }, chat.id, null)).toBeUndefined();
      const skill = store.markdownSkills.import({
        fileName: "synthetic.md",
        contentBase64: Buffer.from("# Synthetic\nCheck bounds.").toString("base64"),
      });
      store.markdownSkills.select(chat.id, skill, 0);
      expect(markdownSkillSelectionRefusal({ store }, chat.id, null)).toMatchObject({
        status: 409,
      });
      store.markdownSkills.select(chat.id, null, 1);
      expect(markdownSkillSelectionRefusal({ store }, chat.id, null)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
