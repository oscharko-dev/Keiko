import { describe, expect, it } from "vitest";
import {
  BASELINE_AUTHOR_LOCALE,
  BIND_PATH,
  asAuthor,
  bindAfterSave,
  bindBaselineTemplates,
  bindSavedTemplate,
  templateContext,
} from "../testing/jira-chat-lab/requirements/template-binding.mjs";

const SKILL = { id: "skill-1", revision: 1 };
const GERMAN = {
  locale: "de_DE",
  issueTypes: [{ id: "10002", english: "Task", localized: "Aufgabe" }],
  statuses: [],
};
const ENGLISH = {
  locale: "en_US",
  issueTypes: [{ id: "10002", english: "Task", localized: "Task" }],
  statuses: [],
};

describe("bindSavedTemplate: the lab binds through the product's route and never writes an id", () => {
  const post = (status, value = {}) => {
    const sent = [];
    return {
      sent,
      post: async (path, body) => {
        sent.push({ path, body });
        return { status, value };
      },
    };
  };

  it("sends the Pod, the skill and the revision the save returned, and keeps the new revision", async () => {
    const fake = post(200, {
      changed: true,
      issueType: "10002",
      skill: { id: "skill-1", revision: 2 },
    });
    expect(await bindSavedTemplate(fake.post, "pod-1", SKILL)).toEqual({
      skill: { id: "skill-1", revision: 2 },
      outcome: "bound",
    });
    expect(fake.sent).toEqual([
      { path: BIND_PATH, body: { podId: "pod-1", skillId: "skill-1", revision: 1 } },
    ]);
    expect(BIND_PATH).toBe("/api/skills/jira-templates/bind");
  });

  it("leaves the skill as saved for an already bound template, a dead one, a build without the route and a refused binding", async () => {
    expect((await bindSavedTemplate(post(200, { changed: false }).post, "p", SKILL)).outcome).toBe(
      "unchanged",
    );
    expect((await bindSavedTemplate(post(200, { dead: true }).post, "p", SKILL)).outcome).toBe(
      "dead",
    );
    expect(await bindSavedTemplate(post(404).post, "p", SKILL)).toEqual({
      skill: SKILL,
      outcome: "absent",
    });
    expect(await bindSavedTemplate(post(422).post, "p", SKILL)).toEqual({
      skill: SKILL,
      outcome: "refused",
    });
  });

  it("stops the lab on any other status: a server fault is no binding outcome", async () => {
    await expect(bindSavedTemplate(post(500).post, "p", SKILL)).rejects.toThrow("HTTP 500");
    await expect(bindSavedTemplate(post(403).post, "p", SKILL)).rejects.toThrow("HTTP 403");
  });
});

describe("asAuthor: only a localized session needs the author's profile", () => {
  const ctxOf = (language) => {
    const locales = [];
    return {
      locales,
      language,
      session: {},
      withActorLocale: async (_session, actor, locale, run) => {
        locales.push([actor, locale]);
        return run();
      },
    };
  };

  it("switches the Pod account to the author's locale in a German session, and not otherwise", async () => {
    const german = ctxOf(GERMAN);
    expect(await asAuthor(german, "en_US", async () => "bound")).toBe("bound");
    expect(german.locales).toEqual([["api", "en_US"]]);
    for (const ctx of [ctxOf(ENGLISH), ctxOf(undefined), ctxOf(GERMAN)]) {
      await asAuthor(ctx, undefined, async () => "x");
      expect(ctx.locales).toEqual([]);
    }
    const english = ctxOf(ENGLISH);
    await asAuthor(english, "en_US", async () => "x");
    expect(english.locales).toEqual([]);
  });
});

describe("bindAfterSave and the baseline binding", () => {
  const harness = (language, status = 200) => {
    const posts = [];
    const locales = [];
    const ctx = {
      language,
      session: {},
      authorLocale: "en_US",
      templatePodId: async () => "pod-9",
      templateBindPost: async (path, body) => {
        posts.push({ path, body, locale: locales.at(-1) });
        return {
          status,
          value: { changed: true, skill: { id: body.skillId, revision: body.revision + 1 } },
        };
      },
      withActorLocale: async (_session, _actor, locale, run) => {
        locales.push(locale);
        try {
          return await run();
        } finally {
          locales.pop();
        }
      },
      // The profile the Pod account has right now: the author's while a bind runs, the session's otherwise.
      apiLocale: async () => locales.at(-1) ?? "de_DE",
    };
    return { ctx, posts };
  };

  it("binds a saved template as the author's profile and returns the revision to remove later", async () => {
    const { ctx, posts } = harness(GERMAN);
    expect(await bindAfterSave(ctx, SKILL)).toEqual({ id: "skill-1", revision: 2 });
    // The profile line of a result: the Pod account showed English while the bind ran, German afterwards.
    expect(ctx.lastBindProfile).toBe("en_US");
    expect(await ctx.apiLocale()).toBe("de_DE");
    expect(posts).toEqual([
      {
        path: BIND_PATH,
        body: { podId: "pod-9", skillId: "skill-1", revision: 1 },
        locale: "en_US",
      },
    ]);
  });

  it("returns the skill as saved when no Pod is available or the lab has no bind post", async () => {
    const { ctx } = harness(GERMAN);
    expect(await bindAfterSave({ ...ctx, templatePodId: async () => undefined }, SKILL)).toBe(
      SKILL,
    );
    expect(await bindAfterSave({ ...ctx, templateBindPost: undefined }, SKILL)).toBe(SKILL);
    expect(await bindAfterSave({ ...ctx, templatePodId: undefined }, SKILL)).toBe(SKILL);
  });

  it("binds only the baseline templates, as the English author, and only once per product start", async () => {
    const { ctx, posts } = harness(GERMAN);
    const list = async () => [
      { id: "b1", revision: 3, name: "REQ-baseline-Task" },
      { id: "own", revision: 1, name: "REQ-Composer-Task" },
      { id: "b2", revision: 1, fileName: "Vorlage-baseline-KEIKO-Bug.md" },
    ];
    expect(await bindBaselineTemplates(ctx, list)).toBe(2);
    expect(posts.map((post) => post.body.skillId)).toEqual(["b1", "b2"]);
    expect(posts.every((post) => post.locale === BASELINE_AUTHOR_LOCALE)).toBe(true);
    expect(ctx.baselineBound).toBe(true);
    expect(await bindBaselineTemplates(ctx, list)).toBe(0);
    expect(posts).toHaveLength(2);
  });

  it("does nothing without a Pod or a bind post (a build without the route, a session without a Chat yet)", async () => {
    const { ctx, posts } = harness(GERMAN);
    expect(
      await bindBaselineTemplates({ ...ctx, templatePodId: async () => undefined }, async () => []),
    ).toBe(0);
    expect(
      await bindBaselineTemplates({ ...ctx, templateBindPost: undefined }, async () => []),
    ).toBe(0);
    expect(posts).toEqual([]);
  });
});

describe("templateContext", () => {
  it("binds the skill a template-import returns and passes every other request through untouched", async () => {
    const seen = [];
    const ctx = {
      language: ENGLISH,
      session: {},
      templatePodId: undefined,
      templateBindPost: undefined,
    };
    const parts = templateContext(ctx, {
      plain: async (name, path, _body, method) => {
        seen.push([name, path, method]);
        return name === "template-import" ? { skill: { id: "s", revision: 1 } } : { ok: true };
      },
      post: async () => ({
        status: 200,
        value: { changed: true, skill: { id: "s", revision: 5 } },
      }),
      readPod: async () => "pod-1",
      readLocale: async () => "en_US",
    });
    Object.assign(ctx, parts);
    expect(await ctx.http("template-list", "/x", undefined, "GET")).toEqual({ ok: true });
    expect((await ctx.http("template-import", "/api/skills", {})).skill).toEqual({
      id: "s",
      revision: 5,
    });
    expect(seen).toEqual([
      ["template-list", "/x", "GET"],
      ["template-import", "/api/skills", "POST"],
    ]);
    expect(await ctx.templatePodId()).toBe("pod-1");
    expect(await ctx.apiLocale()).toBe("en_US");
  });
});
