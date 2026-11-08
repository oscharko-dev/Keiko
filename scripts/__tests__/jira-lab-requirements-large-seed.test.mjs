// The seed of the large project (epic #4173, #4174, #4181 AC1) as a script, against a fake Jira on
// an ephemeral loopback port: `--only LRG` adds LRG to a seeded laboratory without touching REQ,
// RPT or the other entries of the truth file, is idempotent, and refuses a project that holds
// issues the truth does not record.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { LARGE_PROJECT, largePlan } from "../testing/jira-chat-lab/requirements/large-project.mjs";

const run = promisify(execFile);
const SEED = join(
  import.meta.dirname,
  "..",
  "testing",
  "jira-chat-lab",
  "requirements",
  "seed-projects.mjs",
);
const EPIC_NAME = "com.pyxis.greenhopper.jira:gh-epic-label";
const EPIC_LINK = "com.pyxis.greenhopper.jira:gh-epic-link";
const LINK_FIELD = "customfield_10100";
const NAME_FIELD = "customfield_10000";
const TRANSITIONS = [
  { id: "11", to: { name: "To Do" } },
  { id: "21", to: { name: "In Progress" } },
  { id: "31", to: { name: "Done" } },
];

/** A fake Jira Data Center that keeps projects, issues, statuses and the requests it served. */
function fakeJira() {
  const projects = new Map();
  const requests = [];
  const created = (key, name) => {
    projects.set(key, { name, issues: [] });
    return projects.get(key);
  };
  const issueOf = (key) => {
    const project = projects.get(key.split("-")[0]);
    return project?.issues.find((issue) => issue.key === key);
  };
  const bulk = (body) => {
    const issues = body.issueUpdates.map(({ fields }) => {
      const project = projects.get(fields.project.key);
      const issue = {
        key: `${fields.project.key}-${project.issues.length + 1}`,
        type: fields.issuetype.name,
        status: "To Do",
        fields,
      };
      project.issues.push(issue);
      return { key: issue.key };
    });
    return [201, { issues, errors: [] }];
  };
  const move = (issue, id) => {
    issue.status = TRANSITIONS.find((transition) => transition.id === id).to.name;
    return [204];
  };
  const routes = [
    [
      "GET",
      /^\/rest\/api\/2\/project\/(\w+)$/,
      (m) => (projects.has(m[1]) ? [200, { key: m[1] }] : [404, {}]),
    ],
    [
      "POST",
      /^\/rest\/api\/2\/project$/,
      (_m, _url, body) => {
        created(body.key, body.name);
        return [201, { key: body.key }];
      },
    ],
    ["POST", /\/project\/\w+\/role\/\d+$/, () => [204]],
    ["GET", /createmeta\/\w+\/issuetypes$/, () => [200, { values: [{ id: "1", name: "Task" }] }]],
    [
      "GET",
      /createmeta\/\w+\/issuetypes\/1$/,
      () => [
        200,
        { values: [{ fieldId: LINK_FIELD, name: "Epic Link", schema: { custom: EPIC_LINK } }] },
      ],
    ],
    [
      "GET",
      /^\/rest\/api\/2\/field$/,
      () => [
        200,
        [
          { id: NAME_FIELD, schema: { custom: EPIC_NAME } },
          { id: LINK_FIELD, schema: { custom: EPIC_LINK } },
        ],
      ],
    ],
    ["POST", /^\/rest\/api\/2\/issue\/bulk$/, (_m, _url, body) => bulk(body)],
    [
      "GET",
      /^\/rest\/api\/2\/search$/,
      (_m, url) => {
        const key = /project = (\w+)/.exec(url.searchParams.get("jql"))[1];
        return [200, { total: projects.get(key)?.issues.length ?? 0, issues: [] }];
      },
    ],
    [
      "GET",
      /^\/rest\/api\/2\/issue\/[\w-]+\/transitions$/,
      () => [200, { transitions: TRANSITIONS }],
    ],
    [
      "POST",
      /^\/rest\/api\/2\/issue\/([\w-]+)\/transitions$/,
      (m, _url, body) => move(issueOf(m[1]), body.transition.id),
    ],
  ];
  const route = (method, path, body) => {
    const url = new URL(path, "http://fake");
    for (const [verb, pattern, handler] of routes) {
      const match = verb === method ? pattern.exec(url.pathname) : null;
      if (match !== null) return handler(match, url, body);
    }
    return [404, {}];
  };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      requests.push(`${request.method} ${request.url}`);
      const [status, value] = route(
        request.method,
        request.url,
        text === "" ? undefined : JSON.parse(text),
      );
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(value === undefined ? undefined : JSON.stringify(value));
    });
  });
  return { projects, requests, server, created };
}

const cleanup = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function laboratory() {
  const jira = fakeJira();
  await new Promise((resolve) => jira.server.listen(0, "127.0.0.1", resolve));
  const directory = mkdtempSync(join(tmpdir(), "keiko-lrg-seed-"));
  mkdirSync(join(directory, "secrets"), { mode: 0o700 });
  writeFileSync(join(directory, "secrets", "admin-password"), "synthetic", { mode: 0o600 });
  writeFileSync(
    join(directory, "session.json"),
    JSON.stringify({
      schemaVersion: 1,
      syntheticOnly: true,
      project: "keiko-jira-4081-seed-test",
      httpPort: jira.server.address().port,
    }),
    { mode: 0o600 },
  );
  cleanup.push(async () => {
    await new Promise((resolve) => jira.server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const truthPath = join(directory, "requirements-truth.json");
  return {
    jira,
    truthPath,
    seed: (...args) => run(process.execPath, [SEED, directory, ...args]),
    truth: () => JSON.parse(readFileSync(truthPath, "utf8")),
  };
}

/** A laboratory that was seeded before LRG existed: RPT holds issues and the truth records them. */
function seededWithoutLarge(lab) {
  const rpt = lab.jira.created("RPT", "Auswertung");
  rpt.issues.push({ key: "RPT-1", type: "Epic", status: "To Do", fields: {} });
  lab.jira.created("REQ", "Anforderungen");
  const recorded = {
    schemaVersion: 1,
    projects: { work: "REQ", report: "RPT" },
    fieldIds: { epicLink: LINK_FIELD },
    uncoveredRequirements: ["LH-010"],
    issues: [{ key: "RPT-1", type: "Epic", deviations: [] }],
  };
  writeFileSync(lab.truthPath, JSON.stringify(recorded));
  return recorded;
}

const touchesOtherProjects = (requests) => requests.filter((request) => /RPT|REQ/.test(request));

describe("seed-projects.mjs --only LRG", () => {
  it("adds the large project to a seeded laboratory and leaves everything else alone", async () => {
    const lab = await laboratory();
    const recorded = seededWithoutLarge(lab);
    const before = lab.jira.requests.length;
    await lab.seed("--only", LARGE_PROJECT);
    const truth = lab.truth();
    expect({ ...truth, projects: recorded.projects, large: undefined }).toEqual({
      ...recorded,
      large: undefined,
    });
    expect(truth.projects).toEqual({ ...recorded.projects, large: LARGE_PROJECT });
    expect(touchesOtherProjects(lab.jira.requests.slice(before))).toEqual([]);
    expect(lab.jira.projects.get("RPT").issues).toHaveLength(1);
    expect(truth.large.issueCount).toBe(largePlan().length);
    expect(truth.large.fieldIds).toEqual({ epicLink: LINK_FIELD, epicName: NAME_FIELD });
  }, 120_000);

  it("creates exactly the planned issues: types, epic links and statuses", async () => {
    const lab = await laboratory();
    seededWithoutLarge(lab);
    await lab.seed("--only", LARGE_PROJECT);
    const { issues } = lab.jira.projects.get(LARGE_PROJECT);
    const plan = largePlan();
    expect(issues).toHaveLength(plan.length);
    const epicKeys = issues.filter((issue) => issue.type === "Epic").map((issue) => issue.key);
    expect(epicKeys).toHaveLength(plan.filter((item) => item.type === "Epic").length);
    issues.forEach((issue, index) => {
      expect(issue.type).toBe(plan[index].type);
      expect(issue.status).toBe(plan[index].status);
      if (plan[index].epic !== undefined)
        expect(issue.fields).toMatchObject({
          [LINK_FIELD]: epicKeys[plan[index].epic],
        });
    });
    const recorded = lab.truth().large;
    const member = (epic) => plan.filter((item) => item.epic === epic);
    recorded.epics.forEach((epic, index) => {
      expect(epic).toEqual({
        key: epicKeys[index],
        members: member(index).length,
        done: member(index).filter((item) => item.status === "Done").length,
      });
    });
  }, 120_000);

  it("is idempotent: a second run sends no request that creates or moves an issue", async () => {
    const lab = await laboratory();
    seededWithoutLarge(lab);
    await lab.seed("--only", LARGE_PROJECT);
    const first = lab.truth();
    const requests = lab.jira.requests.length;
    const { stdout } = await lab.seed("--only", LARGE_PROJECT);
    expect(stdout).toContain("large project exists");
    expect(lab.jira.requests).toHaveLength(requests);
    expect(lab.truth()).toEqual(first);
  }, 120_000);

  it("refuses a project that holds issues the truth does not record", async () => {
    const lab = await laboratory();
    seededWithoutLarge(lab);
    lab.jira
      .created(LARGE_PROJECT, "Partly seeded")
      .issues.push({ key: "LRG-1", type: "Epic", status: "To Do", fields: {} });
    await expect(lab.seed("--only", LARGE_PROJECT)).rejects.toMatchObject({
      stderr: expect.stringContaining("does not record it"),
    });
    expect(lab.jira.requests.some((request) => request.includes("/issue/bulk"))).toBe(false);
    expect(lab.truth().large).toBeUndefined();
  }, 120_000);

  it("refuses to start without a seeded laboratory and for another project", async () => {
    const lab = await laboratory();
    await expect(lab.seed("--only", LARGE_PROJECT)).rejects.toMatchObject({
      stderr: expect.stringContaining("run the full seed first"),
    });
    await expect(lab.seed("--only", "RPT")).rejects.toMatchObject({
      stderr: expect.stringContaining("--only accepts LRG"),
    });
    expect(lab.jira.requests).toEqual([]);
  }, 120_000);
});

describe("seed-projects.mjs without --only", () => {
  it("seeds REQ, RPT and LRG once and then skips a laboratory whose truth exists", async () => {
    const lab = await laboratory();
    await lab.seed();
    const truth = lab.truth();
    expect(truth.projects).toEqual({ work: "REQ", report: "RPT", large: LARGE_PROJECT });
    expect(truth.issues.length).toBeGreaterThan(0);
    const requests = lab.jira.requests.length;
    const { stdout } = await lab.seed();
    expect(stdout).toContain("truth exists");
    expect(lab.jira.requests).toHaveLength(requests);
  }, 120_000);
});
