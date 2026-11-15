import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkJiraIssueTemplates,
  matchingJiraIssueTemplates,
} from "../../packages/keiko-connectors/dist/index.js";
import { parseJiraIssueTemplate } from "../../packages/keiko-contracts/dist/jira-issue-template.js";
import {
  BASELINE_NAME_PREFIX,
  BASELINE_OFF_ENV,
  BaselineTemplateError,
  assertLabInstance,
  baselineEnabled,
  baselineTemplateMarkdown,
  readLabProjects,
  seedBaselineTemplates,
  seedLabBaseline,
  seedProductBaseline,
  withBaselineSuspended,
} from "../testing/jira-chat-lab/requirements/baseline-templates.mjs";

const PAIRS = [
  { key: "REQ", issueTypes: ["Epic", "Story", "Task", "Bug", "Sub-task"] },
  { key: "ZR", issueTypes: ["Epic", "Technical task"] },
];

/** The product's skill library as the routes expose it, with the product's own template parser. */
function skillLibrary() {
  const skills = new Map();
  let next = 1;
  const calls = [];
  const heading = (body) => /^# (.+)$/mu.exec(body)?.[1];
  const entryOf = (skill) => {
    const parsed = parseJiraIssueTemplate(skill.body);
    return {
      id: skill.id,
      revision: skill.revision,
      name: skill.name,
      valid: parsed.ok,
      ...(parsed.ok
        ? {
            project: parsed.template.project,
            issueType: parsed.template.issueType,
            activations: parsed.template.activations.map((item) => item.kind),
          }
        : {}),
    };
  };
  const request = async (name, path, body, method = "POST") => {
    calls.push({ name, path, method });
    if (method === "GET") return { templates: [...skills.values()].map(entryOf) };
    if (method === "DELETE") {
      skills.delete(decodeURIComponent(path.split("/").pop()));
      return null;
    }
    const text = Buffer.from(body.contentBase64, "base64").toString("utf8");
    const skill = {
      id: `skill-${String(next++)}`,
      revision: 1,
      name: heading(text) ?? body.fileName.slice(0, -3),
      body: text,
    };
    skills.set(skill.id, skill);
    return { skill: { id: skill.id, revision: skill.revision } };
  };
  return { request, skills, calls, entries: () => [...skills.values()].map(entryOf) };
}

const subject = (
  operation,
  issueType,
  fields = { summary: "Ein Vorgang" },
  projectKey = "REQ",
) => ({
  operation,
  projectKey,
  issueType: { name: issueType },
  fields,
});

const parsedTemplates = (library) =>
  [...library.skills.values()].map((skill) => {
    const parsed = parseJiraIssueTemplate(skill.body);
    expect(parsed.ok).toBe(true);
    return parsed.template;
  });

describe("the baseline template", () => {
  it("is accepted by the product's parser with a plain create and edit activation", () => {
    for (const [project, issueType] of [
      ["REQ", "Epic"],
      ["ZR", "Sub-task"],
      ["KEIKO", "Technical task"],
    ]) {
      const parsed = parseJiraIssueTemplate(baselineTemplateMarkdown(project, issueType));
      expect(parsed.ok).toBe(true);
      expect(parsed.template).toMatchObject({
        project,
        issueType,
        activations: [{ kind: "create" }, { kind: "edit" }],
        summary: { maxLength: 255 },
        requiredFields: [],
        requiredSections: [],
        labels: { required: [] },
      });
    }
  });

  it("is recognisable as a laboratory fixture by its heading and carries no secret or content", () => {
    const markdown = baselineTemplateMarkdown("REQ", "Story");
    expect(markdown).toContain(`# ${BASELINE_NAME_PREFIX} REQ Story`);
    expect(markdown).not.toMatch(/http|token|secret|password/iu);
  });

  it("refuses a project key or issue type that is not a plain value", () => {
    for (const key of ["req", "R", "RE Q", "REQ\n", "", undefined])
      expect(() => baselineTemplateMarkdown(key, "Epic")).toThrow(BaselineTemplateError);
    for (const type of ["", " Epic", "Epic ", "x".repeat(121), undefined])
      expect(() => baselineTemplateMarkdown("REQ", type)).toThrow(BaselineTemplateError);
  });

  it("never narrows another template: only the journey's own rules apply", () => {
    const library = skillLibrary();
    return seedBaselineTemplates(library.request, PAIRS).then(() => {
      const journey = parseJiraIssueTemplate(
        [
          "---",
          "keiko: jira-issue-template",
          "version: 1",
          "project: REQ",
          'issueType: "Epic"',
          "activateOn: [create]",
          'summaryPattern: "^\\\\[LH-\\\\d{3}\\\\] \\\\S"',
          "---",
          "# Vorlage Epic",
        ].join("\n"),
      );
      expect(journey.ok).toBe(true);
      const all = [...parsedTemplates(library), journey.template];
      const only = [journey.template];
      for (const summary of ["[LH-001] Titel", "Ohne Kennung", ""]) {
        const withBaseline = checkJiraIssueTemplates(
          all,
          subject("create", "Epic", { summary }),
          [],
        );
        const alone = checkJiraIssueTemplates(only, subject("create", "Epic", { summary }), []);
        expect(withBaseline.map((item) => item.ruleId)).toEqual(alone.map((item) => item.ruleId));
      }
    });
  });

  it("is harmless on today's checker: no write of any shape violates it", async () => {
    const library = skillLibrary();
    await seedBaselineTemplates(library.request, PAIRS);
    const templates = parsedTemplates(library);
    for (const pair of PAIRS)
      for (const type of pair.issueTypes)
        for (const operation of ["create", "edit"])
          for (const fields of [
            {},
            { summary: "" },
            { summary: "x" },
            { summary: "y".repeat(255) },
          ])
            expect(
              checkJiraIssueTemplates(templates, subject(operation, type, fields, pair.key), []),
            ).toEqual([]);
  });

  it("governs every create and edit of every seeded project and type, and nothing without it", async () => {
    const library = skillLibrary();
    // A gate double of the rule "no governing template, no write".
    const admitted = (templates, write) => matchingJiraIssueTemplates(templates, write).length > 0;
    await seedBaselineTemplates(library.request, PAIRS);
    const templates = parsedTemplates(library);
    for (const pair of PAIRS)
      for (const type of pair.issueTypes)
        for (const operation of ["create", "edit"]) {
          const write = subject(operation, type, { summary: "x" }, pair.key);
          expect(admitted(templates, write)).toBe(true);
          expect(admitted([], write)).toBe(false);
        }
    expect(admitted(templates, subject("create", "Epic", { summary: "x" }, "OTHER"))).toBe(false);
    expect(admitted(templates, subject("create", "Initiative", { summary: "x" }, "REQ"))).toBe(
      false,
    );
  });
});

describe("seeding through the product's skill library routes", () => {
  it("imports one template per project and issue type and verifies them by the listing", async () => {
    const library = skillLibrary();
    await expect(seedBaselineTemplates(library.request, PAIRS)).resolves.toEqual({
      templates: 7,
      imported: 7,
    });
    expect(library.skills.size).toBe(7);
    for (const entry of library.entries()) {
      expect(entry.valid).toBe(true);
      expect(entry.name.startsWith(BASELINE_NAME_PREFIX)).toBe(true);
    }
    expect(library.calls.at(-1)).toMatchObject({ name: "baseline-template-list", method: "GET" });
  });

  it("is idempotent: a second start of a retained state imports nothing", async () => {
    const library = skillLibrary();
    await seedBaselineTemplates(library.request, PAIRS);
    const again = await seedBaselineTemplates(library.request, PAIRS);
    expect(again).toEqual({ templates: 7, imported: 0 });
    expect(library.skills.size).toBe(7);
  });

  it("seeds only what is missing when the lab gained a project", async () => {
    const library = skillLibrary();
    await seedBaselineTemplates(library.request, PAIRS);
    const grown = [...PAIRS, { key: "NEWP", issueTypes: ["Task"] }];
    await expect(seedBaselineTemplates(library.request, grown)).resolves.toEqual({
      templates: 8,
      imported: 1,
    });
  });

  it("fails closed when the library does not list a template as valid and governing", async () => {
    const library = skillLibrary();
    const dropping = async (name, path, body, method) => {
      const result = await library.request(name, path, body, method);
      if (method === "GET") return { templates: [] };
      return result;
    };
    await expect(seedBaselineTemplates(dropping, PAIRS)).rejects.toMatchObject({
      code: "verification",
    });
  });

  it("does not trust a same-named template that is not a governing baseline", async () => {
    const library = skillLibrary();
    const listing = async (name, path, body, method) => {
      const result = await library.request(name, path, body, method);
      if (method !== "GET") return result;
      return {
        templates: result.templates.map((entry) => ({
          ...entry,
          activations: ["transition:Done"],
        })),
      };
    };
    await expect(seedBaselineTemplates(listing, PAIRS)).rejects.toMatchObject({
      code: "verification",
    });
  });

  it("fails as a lab error when the pairs would crowd the 128-skill library", async () => {
    const library = skillLibrary();
    const many = Array.from({ length: 20 }, (_, index) => ({
      key: `PRJ${String(index)}`,
      issueTypes: ["Epic", "Story", "Task", "Bug", "Sub-task"],
    }));
    await expect(seedBaselineTemplates(library.request, many)).rejects.toMatchObject({
      code: "library-capacity",
    });
    expect(library.calls).toEqual([]);
  });
});

describe("reading the lab's projects and issue types", () => {
  const nativeDouble = (map) => async (_session, path) => {
    if (!map.has(path)) throw new BaselineTemplateError("jira-read");
    return structuredClone(map.get(path));
  };

  it("lists every project with its distinct issue type names", async () => {
    const read = nativeDouble(
      new Map([
        ["/rest/api/2/project", [{ key: "REQ" }, { key: "ZR" }]],
        [
          "/rest/api/2/project/REQ/statuses",
          [{ name: "Epic" }, { name: "Task" }, { name: "Task" }],
        ],
        ["/rest/api/2/project/ZR/statuses", [{ name: "Sub-task" }]],
      ]),
    );
    await expect(readLabProjects({}, read)).resolves.toEqual([
      { key: "REQ", issueTypes: ["Epic", "Task"] },
      { key: "ZR", issueTypes: ["Sub-task"] },
    ]);
  });

  it("fails as a lab error, never with a partial list, when Jira cannot be read", async () => {
    const missing = nativeDouble(
      new Map([
        ["/rest/api/2/project", [{ key: "REQ" }, { key: "ZR" }]],
        ["/rest/api/2/project/REQ/statuses", [{ name: "Epic" }]],
      ]),
    );
    await expect(readLabProjects({}, missing)).rejects.toMatchObject({ code: "jira-read" });
  });

  it("refuses an unbounded or malformed listing", async () => {
    const projects = (value) => nativeDouble(new Map([["/rest/api/2/project", value]]));
    await expect(readLabProjects({}, projects({ not: "an array" }))).rejects.toMatchObject({
      code: "project-listing",
    });
    await expect(
      readLabProjects({}, projects(Array.from({ length: 101 }, () => ({ key: "REQ" })))),
    ).rejects.toMatchObject({ code: "project-listing" });
    await expect(readLabProjects({}, projects([{ key: "bad key" }]))).rejects.toMatchObject({
      code: "project",
    });
    const types = nativeDouble(
      new Map([
        ["/rest/api/2/project", [{ key: "REQ" }]],
        [
          "/rest/api/2/project/REQ/statuses",
          Array.from({ length: 51 }, (_, index) => ({ name: `T${String(index)}` })),
        ],
      ]),
    );
    await expect(readLabProjects({}, types)).rejects.toMatchObject({ code: "issue-type-listing" });
  });
});

describe("the lab-instance assertion", () => {
  let sessionDir;
  let tempRoot;
  const env = { KEIKO_OS_KEYCHAIN: "off" };
  beforeEach(() => {
    sessionDir = realpathSync(mkdtempSync(join(tmpdir(), "baseline-session-")));
    tempRoot = mkdtempSync(join(realpathSync(tmpdir()), "keiko-jira-live-chat-"));
  });
  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("accepts the lab's own disposable and retained state directories", () => {
    const retained = join(sessionDir, "keiko-jira-live-chat-abc123");
    mkdirSync(retained);
    expect(() =>
      assertLabInstance({ root: tempRoot, session: { directory: sessionDir }, env }),
    ).not.toThrow();
    expect(() =>
      assertLabInstance({ root: retained, session: { directory: sessionDir }, env }),
    ).not.toThrow();
  });

  it("refuses a state directory the lab did not create, or an enabled keychain", () => {
    const real = join(sessionDir, "state");
    mkdirSync(real);
    const elsewhere = mkdtempSync(join(sessionDir, "x-"));
    const session = { directory: sessionDir };
    expect(() => assertLabInstance({ root: real, session, env })).toThrow(BaselineTemplateError);
    expect(() => assertLabInstance({ root: elsewhere, session, env })).toThrow(
      BaselineTemplateError,
    );
    expect(() => assertLabInstance({ root: tempRoot, session, env: {} })).toThrow(
      BaselineTemplateError,
    );
    expect(() =>
      assertLabInstance({ root: tempRoot, session, env: { KEIKO_OS_KEYCHAIN: "on" } }),
    ).toThrow(BaselineTemplateError);
    expect(() => assertLabInstance({ root: "relative", session, env })).toThrow(
      BaselineTemplateError,
    );
    expect(() => assertLabInstance({ root: tempRoot, session: {}, env })).toThrow(
      BaselineTemplateError,
    );
  });

  it("refuses a lab-named directory under a foreign parent", () => {
    const foreign = mkdtempSync(join(sessionDir, "parent-"));
    const root = join(foreign, "keiko-jira-live-chat-evil");
    mkdirSync(root);
    expect(() => assertLabInstance({ root, session: { directory: sessionDir }, env })).toThrow(
      BaselineTemplateError,
    );
  });
});

describe("the product-start hook and its opt-out", () => {
  const read = async (_session, path) =>
    path === "/rest/api/2/project" ? [{ key: "REQ" }] : [{ name: "Epic" }];
  let sessionDir;
  let root;
  const env = { KEIKO_OS_KEYCHAIN: "off" };
  beforeEach(() => {
    sessionDir = realpathSync(mkdtempSync(join(tmpdir(), "baseline-hook-")));
    root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-jira-live-chat-"));
  });
  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("defaults on and turns off by the option or the exact environment value only", () => {
    expect(baselineEnabled(undefined, {})).toBe(true);
    expect(baselineEnabled(true, {})).toBe(true);
    expect(baselineEnabled(false, {})).toBe(false);
    expect(baselineEnabled(undefined, { [BASELINE_OFF_ENV]: "off" })).toBe(false);
    expect(baselineEnabled(undefined, { [BASELINE_OFF_ENV]: "0" })).toBe(true);
    expect(baselineEnabled(undefined, { [BASELINE_OFF_ENV]: "OFF" })).toBe(true);
  });

  it("seeds an enabled lab instance and nothing for an opted-out one", async () => {
    const library = skillLibrary();
    const session = { directory: sessionDir };
    await seedLabBaseline({ session, root, request: library.request, env, read });
    expect(library.skills.size).toBe(1);
    const other = skillLibrary();
    await seedLabBaseline({ session, root, request: other.request, enabled: false, env, read });
    await seedLabBaseline({
      session,
      root,
      request: other.request,
      env: { ...env, [BASELINE_OFF_ENV]: "off" },
      read,
    });
    expect(other.calls).toEqual([]);
  });

  it("proves the instance is a lab one before it writes anything", async () => {
    const library = skillLibrary();
    await expect(
      seedLabBaseline({
        session: { directory: sessionDir },
        root: sessionDir,
        request: library.request,
        env,
        read,
      }),
    ).rejects.toMatchObject({ code: "not-a-lab-instance" });
    expect(library.calls).toEqual([]);
  });

  it("binds the paired product's origin and cookie to the library routes", async () => {
    const jsonRequest = vi.fn(async (_origin, _cookie, _name, _path, _body, method) =>
      method === "GET" ? { templates: [] } : { skill: { id: "s", revision: 1 } },
    );
    await expect(
      seedProductBaseline({
        origin: "http://127.0.0.1:1",
        cookie: "c",
        root,
        session: { directory: sessionDir },
        baselineTemplates: false,
        jsonRequest,
      }),
    ).resolves.toBeUndefined();
    expect(jsonRequest).not.toHaveBeenCalled();
  });

  it("is wired at both product starts of chat-read.mjs and nowhere else", () => {
    const source = readFileSync(
      new URL("../testing/jira-chat-lab/chat-read.mjs", import.meta.url),
      "utf8",
    );
    expect(source.match(/await seedProductBaseline\(/gu)).toHaveLength(2);
    expect(source).toContain("baselineTemplates = true");
  });
});

describe("a journey that installs its own templates, and a lane that must see none", () => {
  const journeyMarkdown = [
    "---",
    "keiko: jira-issue-template",
    "version: 1",
    "project: REQ",
    'issueType: "Epic"',
    "activateOn: [create]",
    "requiredLabels: [lab]",
    "---",
    "# Vorlage Epic",
    "",
    "## Ziel",
  ].join("\n");
  const importJourney = (library) =>
    library.request("template-import", "/api/skills", {
      fileName: "Vorlage-Epic.md",
      contentBase64: Buffer.from(journeyMarkdown).toString("base64"),
    });

  it("keeps the journey's rules in force beside the baseline, and the baseline after it", async () => {
    const library = skillLibrary();
    await seedBaselineTemplates(library.request, PAIRS);
    const { skill } = await importJourney(library);
    const during = checkJiraIssueTemplates(
      parsedTemplates(library),
      subject("create", "Epic", { summary: "x", labels: [] }),
      [],
    );
    expect(during.length).toBeGreaterThan(0);
    await library.request(
      "template-delete",
      `/api/skills/${skill.id}`,
      { expectedRevision: 1 },
      "DELETE",
    );
    expect(
      checkJiraIssueTemplates(parsedTemplates(library), subject("create", "Epic"), []),
    ).toEqual([]);
    await expect(seedBaselineTemplates(library.request, PAIRS)).resolves.toMatchObject({
      imported: 0,
    });
  });

  it("removes only the baseline while suspended and restores it, verified, afterwards", async () => {
    const library = skillLibrary();
    await seedBaselineTemplates(library.request, PAIRS);
    const { skill } = await importJourney(library);
    let during;
    await withBaselineSuspended(library.request, PAIRS, async () => {
      during = library.entries().map((entry) => entry.name);
    });
    expect(during).toEqual(["Vorlage Epic"]);
    expect(library.skills.has(skill.id)).toBe(true);
    expect(library.skills.size).toBe(8);
  });

  it("restores the baseline when the suspended body throws", async () => {
    const library = skillLibrary();
    await seedBaselineTemplates(library.request, PAIRS);
    await expect(
      withBaselineSuspended(library.request, PAIRS, async () => {
        throw new TypeError("journey failed");
      }),
    ).rejects.toThrow("journey failed");
    expect(library.skills.size).toBe(7);
  });
});

describe("withBaselineSuspended failure modes", () => {
  /** A library whose Nth DELETE or whose imports after a switch throw. */
  function failing(library, { failDeleteAt, failImports }) {
    let deletes = 0;
    let importsFail = false;
    const request = async (name, path, body, method = "POST") => {
      if (method === "DELETE") {
        deletes += 1;
        if (deletes === failDeleteAt) throw new TypeError("delete failed");
        if (failImports) importsFail = true;
      }
      if (method === "POST" && importsFail) throw new TypeError("reseed failed");
      return library.request(name, path, body, method);
    };
    return request;
  }

  it("restores every baseline template and reports the delete error when a delete fails midway", async () => {
    const library = skillLibrary();
    await seedBaselineTemplates(library.request, PAIRS);
    const body = vi.fn();
    const request = failing(library, { failDeleteAt: 3 });
    await expect(withBaselineSuspended(request, PAIRS, body)).rejects.toThrow("delete failed");
    expect(body).not.toHaveBeenCalled();
    expect(library.skills.size).toBe(7);
    expect(
      library.entries().every((entry) => entry.valid && entry.name.startsWith("Lab baseline")),
    ).toBe(true);
  });

  it("surfaces the reseed error when only the restoration fails", async () => {
    const library = skillLibrary();
    await seedBaselineTemplates(library.request, PAIRS);
    const request = failing(library, { failImports: true });
    await expect(withBaselineSuspended(request, PAIRS, async () => "ok")).rejects.toThrow(
      "reseed failed",
    );
  });

  it("surfaces both errors when the body and the restoration fail, the body's as the cause", async () => {
    const library = skillLibrary();
    await seedBaselineTemplates(library.request, PAIRS);
    const request = failing(library, { failImports: true });
    const bodyError = new TypeError("journey failed");
    const error = await withBaselineSuspended(request, PAIRS, async () => {
      throw bodyError;
    }).catch((failure) => failure);
    expect(error).toBeInstanceOf(BaselineTemplateError);
    expect(error.code).toBe("restore");
    expect(error.cause).toBe(bodyError);
    expect(error.restoreError.message).toBe("reseed failed");
  });

  it("still rethrows the body's own error when the restoration succeeds", async () => {
    const library = skillLibrary();
    await seedBaselineTemplates(library.request, PAIRS);
    const bodyError = new TypeError("journey failed");
    await expect(
      withBaselineSuspended(library.request, PAIRS, async () => {
        throw bodyError;
      }),
    ).rejects.toBe(bodyError);
    expect(library.skills.size).toBe(7);
  });
});
