// The Composer lane's command line and native fixtures (#4369): selection errors, baseline grouping,
// report directory, required fields read from the project's own metadata, and the work-project lock.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { actorDetails } from "../testing/jira-chat-lab/lab-client.mjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => new Map());
vi.mock("../testing/jira-chat-lab/lab-client.mjs", async (original) => ({
  ...(await original()),
  basicAuth: () => "Basic fixture",
  checked: vi.fn(async (_session, _name, _method, path) => structuredClone(reads.get(path))),
}));
import { COMPOSER_SCENARIOS } from "../testing/jira-chat-lab/requirements/composer-catalog.mjs";
import {
  composerGroups,
  composerSelectionOf,
  composerTruth,
  reportDirectoryName,
  selectedScenarios,
  withBaselineSetting,
} from "../testing/jira-chat-lab/requirements/composer-run.mjs";
import { SCENARIOS } from "../testing/jira-chat-lab/requirements/catalog.mjs";
import {
  oracleReader,
  requiredFieldValues,
} from "../testing/jira-chat-lab/requirements/journeys.mjs";
import { SELECTION_CASES } from "../testing/jira-chat-lab/catalog-selection-cases.mjs";

describe("--only is validated against the selected set", () => {
  it("returns the whole set without --only and the named scenarios with it", () => {
    expect(selectedScenarios(COMPOSER_SCENARIOS, undefined, "composer")).toBe(COMPOSER_SCENARIOS);
    expect(
      selectedScenarios(COMPOSER_SCENARIOS, "C03,C01", "composer").map((entry) => entry.id),
    ).toEqual(["C01", "C03"]);
  });

  it("refuses an id that is not in the set, so no empty valid report results", () => {
    expect(() => selectedScenarios(COMPOSER_SCENARIOS, "S07", "composer")).toThrow(
      "S07, which is not in the composer set",
    );
    expect(() => selectedScenarios(SCENARIOS, "C01", "documents")).toThrow(
      "C01, which is not in the documents set",
    );
    expect(() => selectedScenarios(COMPOSER_SCENARIOS, "C01,C99", "composer")).toThrow("C99");
    expect(() => selectedScenarios(COMPOSER_SCENARIOS, "", "composer")).toThrow(TypeError);
  });
});

describe("types and modes", () => {
  it("accepts the closed vocabularies and refuses anything else", () => {
    expect(composerSelectionOf({})).toEqual({});
    expect(composerSelectionOf({ types: "task,sub-task", modes: "ask,full-access" })).toEqual({
      types: ["task", "sub-task"],
      modes: ["ask", "full-access"],
    });
    expect(() => composerSelectionOf({ types: "task,subtask" })).toThrow("--types names subtask");
    expect(() => composerSelectionOf({ modes: "everything" })).toThrow("--modes names everything");
  });
});

describe("baseline grouping and settings", () => {
  it("runs C03 and C04 in their own group without the baseline, the rest as before", () => {
    expect(composerGroups(["C01", "C02", "C03", "C04", "C05"])).toEqual([
      { ids: ["C01", "C02", "C05"], baseline: "default" },
      { ids: ["C03", "C04"], baseline: "off" },
    ]);
    expect(composerGroups(["C03"])).toEqual([{ ids: ["C03"], baseline: "off" }]);
    expect(composerGroups(["C01"])).toEqual([{ ids: ["C01"], baseline: "default" }]);
    expect(composerGroups([])).toEqual([]);
  });

  it("sets the opt-out only for the group's product and restores the previous value", async () => {
    const env = { KEIKO_JIRA_LAB_BASELINE_TEMPLATES: "on" };
    await withBaselineSetting(
      "off",
      async () => expect(env.KEIKO_JIRA_LAB_BASELINE_TEMPLATES).toBe("off"),
      env,
    );
    expect(env.KEIKO_JIRA_LAB_BASELINE_TEMPLATES).toBe("on");
    const bare = {};
    await withBaselineSetting(
      "default",
      async () => expect(bare.KEIKO_JIRA_LAB_BASELINE_TEMPLATES).toBeUndefined(),
      bare,
    );
    await expect(
      withBaselineSetting(
        "off",
        async () => {
          throw new Error("x");
        },
        bare,
      ),
    ).rejects.toThrow("x");
    expect(Object.hasOwn(bare, "KEIKO_JIRA_LAB_BASELINE_TEMPLATES")).toBe(false);
  });
});

describe("the account the oracles read Jira as", () => {
  const sessionWith = (language) => {
    const directory = mkdtempSync(join(tmpdir(), "oracle-reader-"));
    if (language !== undefined) writeFileSync(join(directory, "language.json"), language);
    return { directory };
  };

  it("is the administrator unless the session is German, so default sessions read as before", () => {
    expect(oracleReader(sessionWith(undefined))).toBe("admin");
    expect(oracleReader(sessionWith(JSON.stringify({ locale: "en_US" })))).toBe("admin");
    expect(oracleReader({})).toBe("admin");
  });

  it("is the localized lab actor in a German session, the account whose names the product sees", () => {
    expect(oracleReader(sessionWith(JSON.stringify({ locale: "de_DE" })))).toBe("api");
  });
});

describe("the truth record a group of journeys takes", () => {
  const record = {
    schemaVersion: 1,
    projects: { work: "REQ", report: "RPT", large: "LRG" },
    fieldIds: { epicName: "cf-1", epicLink: "cf-2", storyPoints: "cf-3" },
    uncoveredRequirements: ["LH-010"],
    issues: [{ key: "RPT-1", deviations: [] }],
  };

  it("hands only the work project and the two parent fields to journeys that grade nothing else", () => {
    const narrowed = composerTruth(record, ["C01", "C02", "C08"]);
    expect(narrowed).toEqual({
      projects: { work: "REQ" },
      fieldIds: { epicName: "cf-1", epicLink: "cf-2" },
    });
    expect(JSON.stringify(narrowed)).not.toMatch(/RPT|LH-010|storyPoints/u);
  });

  it("keeps the whole record for the group that runs the document lane's S10 and S11 oracles", () => {
    expect(composerTruth(record, ["C05", "C07"])).toBe(record);
  });

  it("is wired into the scorecard per group, for the Composer lane only", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../testing/jira-chat-lab/requirements/scorecard.mjs"),
      "utf8",
    );
    expect(source).toContain("truth: composer ? composerTruth(truth, group.ids) : truth");
  });
});

describe("report directory", () => {
  it("carries the model id, made safe, and never collides across models", () => {
    expect(reportDirectoryName("gemma-4-31b-it")).toBe("gemma-4-31b-it");
    expect(reportDirectoryName("azure/gpt-5.4 (eu)")).toBe("azure_gpt-5.4_eu_");
    expect(reportDirectoryName(undefined)).toBe("no-model");
    expect(reportDirectoryName("../../etc")).not.toContain("/");
  });
});

describe("native create reads the required fields from the project's own metadata", () => {
  const base = "/rest/api/2/issue/createmeta/REQ/issuetypes";
  const fields = { project: { key: "REQ" }, issuetype: { name: "Task" }, summary: "x" };
  beforeEach(() => reads.set(base, { values: [{ id: "10002", name: "Task" }] }));

  it("fills a required text field and a required field with allowed values, leaves supplied fields alone", async () => {
    reads.set(base, { values: [{ id: "10002", name: "Task" }] });
    reads.set(`${base}/10002?maxResults=200`, {
      values: [
        { fieldId: "summary", required: true, schema: { type: "string" } },
        { fieldId: "customfield_10112", required: true, schema: { type: "string" } },
        { fieldId: "priority", required: true, allowedValues: [{ id: "2" }, { id: "3" }] },
        { fieldId: "description", required: false, schema: { type: "string" } },
      ],
    });
    expect(await requiredFieldValues({}, fields)).toEqual({
      customfield_10112: "Synthetic required value",
      priority: { id: "2" },
    });
  });

  it("fills the required user field with the creating account, as REQ's every issue type needs", async () => {
    reads.set(base, { values: [{ id: "10002", name: "Task" }] });
    reads.set(`${base}/10002?maxResults=200`, {
      values: [
        { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } },
        { fieldId: "issuetype", name: "Issue Type", required: true, schema: { type: "issuetype" } },
        { fieldId: "project", name: "Project", required: true, schema: { type: "project" } },
        { fieldId: "reporter", name: "Reporter", required: true, schema: { type: "user" } },
      ],
    });
    // summary, issuetype and project are supplied by the fixture; only the reporter is left.
    expect(
      await requiredFieldValues(
        {},
        { ...fields, issuetype: { name: "Task" }, project: { key: "REQ" } },
      ),
    ).toEqual({ reporter: { name: actorDetails("admin").name } });
  });

  it("fills a number, a date and an option array, and takes the sub-task's parent from the fixture only", async () => {
    reads.set(`${base}/10002?maxResults=200`, {
      values: [
        { fieldId: "customfield_1", name: "Points", required: true, schema: { type: "number" } },
        { fieldId: "customfield_2", name: "Due", required: true, schema: { type: "date" } },
        {
          fieldId: "customfield_3",
          name: "Components",
          required: true,
          schema: { type: "array" },
          allowedValues: [{ id: 7 }, { id: 8 }],
        },
        { fieldId: "parent", name: "Parent", required: true, schema: { type: "issuelink" } },
      ],
    });
    const supplied = { ...fields, parent: { key: "REQ-2" } };
    const filled = await requiredFieldValues({}, supplied);
    expect(filled.customfield_1).toBe(1);
    expect(filled.customfield_2).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(filled.customfield_3).toEqual([{ id: "7" }]);
    expect(Object.hasOwn(filled, "parent")).toBe(false);
  });

  it("fails closed on a required field of an unknown type, naming the field, its schema type and the issue type", async () => {
    reads.set(`${base}/10002?maxResults=200`, {
      values: [
        { fieldId: "parent", name: "Parent", required: true, schema: { type: "issuelink" } },
        { fieldId: "customfield_9", name: "Team", required: true, schema: { type: "team" } },
      ],
    });
    const error = await requiredFieldValues({}, fields).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toContain("parent");
    expect(error.message).toContain("Parent");
    expect(error.message).toContain("issuelink");
    expect(error.message).toContain("on Task");
    const unnamed = await (async () => {
      reads.set(`${base}/10002?maxResults=200`, {
        values: [{ fieldId: "customfield_9", required: true }],
      });
      return requiredFieldValues({}, fields).catch((thrown) => thrown);
    })();
    expect(unnamed.message).toContain('customfield_9 "unnamed" (schema type unknown) on Task');
  });

  it("fails closed on an unknown issue type", async () => {
    await expect(
      requiredFieldValues({}, { ...fields, issuetype: { name: "Nope" } }),
    ).rejects.toThrow("no issue type Nope");
  });

  it("never depends on another project's fixture file", async () => {
    reads.set(`${base}/10002?maxResults=200`, { values: [] });
    expect(await requiredFieldValues({ directory: "/does/not/exist" }, fields)).toEqual({});
  });
});

describe("the selection lane's creates in the work project", () => {
  it("hold the work-project lock; creates in the fixture project do not", () => {
    const locked = SELECTION_CASES.filter((entry) => entry.workProject === true).map(
      (entry) => entry.id,
    );
    expect(locked).toEqual(["create-epic", "create-story", "create-bug"]);
    for (const id of ["create-task", "create-subtask"])
      expect(SELECTION_CASES.find((entry) => entry.id === id).workProject).toBe(false);
  });
});
