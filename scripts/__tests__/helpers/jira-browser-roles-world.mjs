import { URL } from "node:url";
import assert from "node:assert/strict";

export const EXECUTION = [
  "PL1",
  "PL2",
  "PL3",
  "PL4",
  "PL5",
  "PL6",
  "PL7",
  "Dev1",
  "Dev2",
  "Dev3",
  "Dev4",
  "Dev5",
  "Dev6",
  "Dev7",
  "Dev8",
  "Dev9",
  "Dev10",
  "PL8",
  "PL9",
  "PL10",
  "PL11",
  "TL1",
  "TL2",
  "TL3",
  "TL4",
  "TL5",
  "TL6",
  "TL7",
  "TL8",
  "TL9",
];
const TYPES = [
  { id: "1", name: "Epic", subtask: false },
  { id: "2", name: "Story", subtask: false },
  { id: "3", name: "Task", subtask: false },
  { id: "4", name: "Bug", subtask: false },
  { id: "5", name: "Sub-task", subtask: true },
];
const BLOCKS = { id: "70", name: "Blocks", inward: "is blocked by", outward: "blocks" };
const GOAL = "Deliver the first customer increment.";
const NEXT_GOAL = "Finish the scoped stories and verify integration.";
const WORKLOG = "Implementation and focused verification.";
const COMMENT = "Implemented and checked the scoped change.";
const SUBTASK = "Verify the focused implementation";
const SUBTASK_DESCRIPTION = "Run the focused checks and record the result.";
const BUG = "Regression blocks the story";
const BUG_DESCRIPTION = "Synthetic defect observed while implementing the selected story.";
const PR = {
  object: {
    url: "https://github.com/example/roles-qualification/pull/42",
    title: "Implementation pull request",
  },
};
const page = (field, rows) => ({ startAt: 0, total: rows.length, isLast: true, [field]: rows });
const copy = (value) => structuredClone(value);
export const roleOf = (id) =>
  id.startsWith("PL") ? "projectLead" : id.startsWith("Dev") ? "developer" : "techLead";

function seedIssue(id, key, type, fields = {}) {
  return {
    id: String(id),
    key,
    fields: {
      project: { id: "100", key: "SYN" },
      summary: `Seed ${key}`,
      description: "Synthetic description",
      issuetype: TYPES.find((item) => item.name === type),
      status: { id: "1", name: "To Do", statusCategory: { key: "new" } },
      resolution: null,
      components: [],
      fixVersions: [],
      labels: ["seed-label"],
      issuelinks: [],
      ...fields,
    },
  };
}
function seedFixture() {
  const epics = [seedIssue(101, "SYN-1", "Epic"), seedIssue(102, "SYN-2", "Epic")];
  const stories = Array.from({ length: 8 }, (_, index) =>
    seedIssue(201 + index, `SYN-${index + 3}`, "Story", {
      customfield_10001: index + 1,
      customfield_10002: epics[index < 4 ? 0 : 1].key,
      assignee: index === 0 ? { key: "dev-key", name: "developer" } : null,
    }),
  );
  const task = seedIssue(301, "SYN-11", "Task");
  const identities = (rows) =>
    rows.map(({ id, key, fields }) => ({ id, key, summary: fields.summary }));
  return {
    issues: [...epics, ...stories, task],
    fixture: {
      project: { id: "100", key: "SYN", name: "Synthetic" },
      board: { id: "20", name: "Board" },
      epics: identities(epics),
      stories: identities(stories),
      task: identities([task])[0],
      storyPointsField: { id: "customfield_10001" },
      actors: {
        projectLead: { key: "pl-key", name: "project-lead" },
        developer: { key: "dev-key", name: "developer" },
        techLead: { key: "tl-key", name: "tech-lead" },
      },
      dates: {
        startDate: "2026-01-05T09:00:00.000Z",
        endDate: "2026-01-19T09:00:00.000Z",
        releaseDate: "2026-02-04",
      },
    },
  };
}

export class RoleWorld {
  constructor() {
    const seeded = seedFixture();
    this.fixture = seeded.fixture;
    this.issues = seeded.issues;
    this.rank = this.issues.map(({ key }) => key);
    this.sprints = [];
    this.memberships = new Map();
    this.versions = [];
    this.components = [];
    this.worklogs = [];
    this.comments = [];
    this.watchers = [];
    this.remoteLinks = [];
    this.drift = false;
  }
  issue(value) {
    const found = this.issues.find(({ id, key }) => id === String(value) || key === value);
    assert.ok(found, `Unknown native issue ${value}`);
    return found;
  }
  write(operation, method, path, body, apply, status = 201) {
    return { operation, method, path, body, apply, status };
  }
  edit(index, fields) {
    const issue = this.fixture.stories[index];
    return this.write(
      "jira.edit",
      "PUT",
      `/rest/api/2/issue/${issue.key}`,
      { fields, update: {} },
      () => Object.assign(this.issue(issue.id).fields, copy(fields)),
    );
  }
  sprintFields(number) {
    const dates =
      number === 1
        ? ["2026-01-05", "2026-01-19"]
        : number === 2
          ? ["2026-01-19", "2026-02-02"]
          : ["2026-02-02", "2026-02-16"];
    return {
      name: `SYN ${number === 3 ? "Cleanup" : `Iteration ${number}`}`,
      originBoardId: 20,
      goal: GOAL,
      startDate: `${dates[0]}T09:00:00.000Z`,
      endDate: `${dates[1]}T09:00:00.000Z`,
    };
  }
  createSprint(number) {
    const fields = this.sprintFields(number);
    const id = String(400 + number);
    return this.write("jira.sprint-create", "POST", "/rest/agile/1.0/sprint", fields, () => {
      this.sprints.push({ ...fields, id, state: "future" });
      this.memberships.set(id, []);
    });
  }
  updateSprint(fields) {
    return this.write("jira.sprint-update", "POST", "/rest/agile/1.0/sprint/401", fields, () => {
      Object.assign(
        this.sprints.find(({ id }) => id === "401"),
        fields,
      );
      if (fields.state === "closed")
        this.sprints.find(({ id }) => id === "401").completeDate = "2026-01-19T09:00:00.000Z";
    });
  }
  membership(id, keys) {
    return this.write(
      "jira.sprint-move-issues",
      "POST",
      `/rest/agile/1.0/sprint/${id}/issue`,
      { issues: keys },
      () => this.memberships.set(id, [...keys]),
    );
  }
  createIssue(type, summary, description, id, key, parent) {
    const fields = {
      project: { id: "100" },
      issuetype: { id: TYPES.find((item) => item.name === type).id },
      summary,
      description,
      ...(parent ? { parent: { id: parent } } : {}),
    };
    return this.write("jira.create", "POST", "/rest/api/2/issue", { fields, update: {} }, () => {
      const issue = seedIssue(id, key, type, {
        summary,
        description,
        ...(parent ? { parent: { id: parent } } : {}),
      });
      this.issues.push(issue);
      this.rank.push(key);
    });
  }
  link(left, right, id) {
    const body = { type: { id: "70" }, inwardIssue: { id: left }, outwardIssue: { id: right } };
    return this.write("jira.create-issue-link", "POST", "/rest/api/2/issueLink", body, () => {
      this.issue(left).fields.issuelinks.push({
        id,
        type: BLOCKS,
        outwardIssue: { id: right, key: this.issue(right).key },
      });
      this.issue(right).fields.issuelinks.push({
        id,
        type: BLOCKS,
        inwardIssue: { id: left, key: this.issue(left).key },
      });
    });
  }
  transition(done) {
    const fields = done ? { resolution: { id: "1" } } : {};
    return this.write(
      "jira.transition",
      "POST",
      "/rest/api/2/issue/SYN-4/transitions",
      { fields, update: {}, transition: { id: done ? "41" : "31" } },
      () => {
        this.issue("202").fields.status = {
          id: done ? "5" : "3",
          name: done ? "Done" : "In Progress",
          statusCategory: { key: done ? "done" : "indeterminate" },
        };
        if (done) this.issue("202").fields.resolution = { id: "1", name: "Fixed" };
      },
    );
  }
  plPlanningPlans(id) {
    const keys = this.fixture.stories.map(({ key }) => key);
    const plans = {
      PL1: () => [this.createSprint(1)],
      PL2: () => [this.updateSprint({ name: "SYN Delivery 1", goal: NEXT_GOAL })],
      PL3: () => [this.createSprint(2)],
      PL4: () => [this.membership("401", keys.slice(0, 4))],
      PL5: () => [
        this.write(
          "jira.rank-issues",
          "PUT",
          "/rest/agile/1.0/issue/rank",
          { rankBeforeIssue: "201", rankCustomFieldId: 10003, issues: ["204"] },
          () => {
            this.rank = this.rank.filter((key) => key !== "SYN-6");
            this.rank.splice(this.rank.indexOf("SYN-3"), 0, "SYN-6");
          },
        ),
      ],
    };
    return plans[id]();
  }
  createVersionPlan() {
    return this.write(
      "jira.create-version",
      "POST",
      "/rest/api/2/version",
      { projectId: 100, name: "1.0", releaseDate: "2026-02-04" },
      () =>
        this.versions.push({
          id: "501",
          name: "1.0",
          releaseDate: "2026-02-04",
          released: false,
          archived: false,
        }),
    );
  }
  plReleasePlans(id) {
    const plans = {
      PL6: () => [
        this.createVersionPlan(),
        ...[0, 1, 2].map((index) => this.edit(index, { fixVersions: [{ id: "501" }] })),
      ],
      PL7: () => [this.updateSprint({ state: "active" })],
      PL8: () => [
        this.updateSprint({ state: "closed" }),
        this.membership("402", ["SYN-3", "SYN-5", "SYN-6"]),
      ],
      PL9: () => [
        this.write(
          "jira.update-version",
          "PUT",
          "/rest/api/2/version/501",
          { released: true },
          () => {
            this.versions[0].released = true;
          },
        ),
      ],
      PL10: () => [],
      PL11: () => [
        this.createSprint(3),
        this.write(
          "jira.delete-sprint",
          "DELETE",
          "/rest/agile/1.0/sprint/403",
          undefined,
          () => {
            this.sprints = this.sprints.filter(({ id }) => id !== "403");
            this.memberships.delete("403");
          },
          204,
        ),
      ],
    };
    return plans[id]();
  }
  plPlans(id) {
    return Number(id.slice(2)) <= 5 ? this.plPlanningPlans(id) : this.plReleasePlans(id);
  }
  devIssuePlans(id) {
    const plans = {
      Dev1: () => [],
      Dev2: () => [
        this.write(
          "jira.assign",
          "PUT",
          "/rest/api/2/issue/SYN-4/assignee",
          { name: "developer" },
          () => {
            this.issue("202").fields.assignee = { key: "dev-key", name: "developer" };
          },
        ),
      ],
      Dev3: () => [this.transition(false)],
      Dev4: () => [
        this.write(
          "jira.create-worklog",
          "POST",
          "/rest/api/2/issue/202/worklog?adjustEstimate=leave",
          { comment: WORKLOG, started: "2026-01-05T09:00:00.000+0000", timeSpentSeconds: 7200 },
          () =>
            this.worklogs.push({
              id: "801",
              comment: WORKLOG,
              started: "2026-01-05T09:00:00.000+0000",
              timeSpentSeconds: 7200,
              author: { key: "dev-key" },
            }),
        ),
      ],
      Dev5: () => [
        this.write(
          "jira.comment",
          "POST",
          "/rest/api/2/issue/SYN-4/comment",
          { body: COMMENT },
          () => this.comments.push({ id: "802", body: COMMENT, author: { key: "dev-key" } }),
        ),
      ],
    };
    return plans[id]();
  }
  devFollowupPlans(id) {
    const plans = {
      Dev6: () => [
        this.createIssue("Sub-task", SUBTASK, SUBTASK_DESCRIPTION, "901", "SYN-12", "301"),
      ],
      Dev7: () => [
        this.createIssue("Bug", BUG, BUG_DESCRIPTION, "902", "SYN-13"),
        this.link("902", "202", "1001"),
      ],
      Dev8: () => [this.transition(true)],
      Dev9: () => [
        this.write("jira.watch", "POST", "/rest/api/2/issue/202/watchers", undefined, () =>
          this.watchers.push({ key: "dev-key", name: "developer" }),
        ),
      ],
      Dev10: () => [
        this.write(
          "jira.delete-sprint",
          "DELETE",
          "/rest/agile/1.0/sprint/402",
          undefined,
          () => undefined,
          403,
        ),
      ],
    };
    return plans[id]();
  }
  devPlans(id) {
    return Number(id.slice(3)) <= 5 ? this.devIssuePlans(id) : this.devFollowupPlans(id);
  }
  tlPlans(id) {
    const plans = {
      TL1: () => [
        this.write(
          "jira.create-component",
          "POST",
          "/rest/api/2/component",
          { name: "Backend", leadUserName: "tech-lead", project: "SYN" },
          () =>
            this.components.push({
              id: "601",
              name: "Backend",
              lead: { name: "tech-lead" },
              project: "SYN",
            }),
        ),
      ],
      TL2: () => [4, 5, 6].map((index) => this.edit(index, { components: [{ id: "601" }] })),
      TL3: () => [this.link("205", "206", "1002")],
      TL4: () => [],
      TL5: () => [4, 5].map((index) => this.edit(index, { labels: ["seed-label", "tech-debt"] })),
      TL6: () => [
        this.write(
          "jira.epic-move-issues",
          "POST",
          "/rest/agile/1.0/epic/101/issue",
          { issues: ["SYN-9"] },
          () => {
            this.issue("207").fields.customfield_10002 = "SYN-1";
          },
        ),
      ],
      TL7: () =>
        [4, 5, 6].map((index, position) =>
          this.edit(index, { customfield_10001: [8, 13, 21][position] }),
        ),
      TL8: () => [],
      TL9: () => [
        this.write("jira.upsert-remote-link", "POST", "/rest/api/2/issue/205/remotelink", PR, () =>
          this.remoteLinks.push({ id: "1101", ...copy(PR) }),
        ),
      ],
    };
    return plans[id]();
  }
  plans(id) {
    return id.startsWith("PL")
      ? this.plPlans(id)
      : id.startsWith("Dev")
        ? this.devPlans(id)
        : this.tlPlans(id);
  }
  observedState() {
    const state = {};
    for (const [name, id] of [
      ["sprint1", "401"],
      ["sprint2", "402"],
    ])
      if (this.sprints.some((sprint) => sprint.id === id)) state[name] = { id };
    if (this.versions.length) state.version = { id: "501" };
    if (this.components.length) state.component = { id: "601" };
    return state;
  }
  prepare(id) {
    for (const previous of EXECUTION) {
      if (previous === id) break;
      for (const plan of this.plans(previous)) plan.apply();
    }
    return this;
  }
  search(jql) {
    let issues = [...this.issues];
    const sprint = /\bsprint = ([0-9]+)/u.exec(jql)?.[1];
    const version = /\bfixVersion = ([0-9]+)/u.exec(jql)?.[1];
    if (sprint) issues = issues.filter(({ key }) => this.memberships.get(sprint).includes(key));
    if (version)
      issues = issues.filter(({ fields }) => fields.fixVersions.some(({ id }) => id === version));
    if (jql.includes('assignee = "developer"'))
      issues = issues.filter(({ fields }) => fields.assignee?.key === "dev-key");
    if (jql.includes("statusCategory != Done"))
      issues = issues.filter(({ fields }) => fields.status.statusCategory.key !== "done");
    return jql.includes("ORDER BY Rank ASC")
      ? this.rank.map((key) => this.issue(key))
      : issues.sort((a, b) => a.key.localeCompare(b.key));
  }
  agileRead(path) {
    if (path === "/rest/agile/1.0/board/20/configuration")
      return { ranking: { rankCustomFieldId: 10003 } };
    if (path === "/rest/agile/1.0/board/20/sprint") return page("values", this.sprints);
    const sprint = /^\/rest\/agile\/1\.0\/sprint\/(\d+)(\/issue)?$/u.exec(path);
    if (sprint)
      return sprint[2]
        ? page(
            "issues",
            this.memberships.get(sprint[1]).map((key) => this.issue(key)),
          )
        : this.sprints.find(({ id }) => id === sprint[1]);
    const epic = /^\/rest\/agile\/1\.0\/epic\/(\d+)\/issue$/u.exec(path);
    assert.ok(epic);
    return page(
      "issues",
      this.issues.filter(({ fields }) => fields.customfield_10002 === this.issue(epic[1]).key),
    );
  }
  coreRead(path) {
    const fixed = {
      "/rest/api/2/project/100": { id: "100", key: "SYN", issueTypes: TYPES },
      "/rest/api/2/project/100/versions": this.versions,
      "/rest/api/2/project/100/components": this.components,
      "/rest/api/2/version/501": this.versions[0],
      "/rest/api/2/component/601": this.components[0],
      "/rest/api/2/issueLinkType": { issueLinkTypes: [BLOCKS] },
      "/rest/api/2/field": [
        { id: "customfield_10002", schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-link" } },
      ],
      "/rest/api/2/resolution": [{ id: "1", name: "Fixed" }],
    };
    if (Object.hasOwn(fixed, path)) return fixed[path];
    const parts = /^\/rest\/api\/2\/issue\/([^/]+)(?:\/(\w+))?$/u.exec(path);
    assert.ok(parts);
    return this.issueEndpoint(parts[1], parts[2]);
  }
  issueEndpoint(key, endpoint) {
    const issue = this.issue(key);
    if (endpoint === undefined) return issue;
    const data = {
      transitions: {
        transitions: [
          {
            id: "31",
            to: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } },
            fields: {},
          },
          {
            id: "41",
            to: { id: "5", name: "Done", statusCategory: { key: "done" } },
            fields: { resolution: { allowedValues: [{ id: "1", name: "Fixed" }] } },
          },
        ],
      },
      worklog: page("worklogs", this.worklogs),
      comment: page("comments", this.comments),
      watchers: { watchCount: this.watchers.length, watchers: this.watchers },
      remotelink: this.remoteLinks,
    };
    assert.ok(Object.hasOwn(data, endpoint));
    return data[endpoint];
  }
  read(path) {
    const url = new URL(path, "https://native.invalid");
    const value =
      url.pathname === "/rest/api/2/search"
        ? page("issues", this.search(url.searchParams.get("jql")))
        : url.pathname.startsWith("/rest/agile/")
          ? this.agileRead(url.pathname)
          : this.coreRead(url.pathname);
    assert.notEqual(value, undefined, `Unknown native observation ${path}`);
    return copy(this.drift ? corrupt(value) : value);
  }
  answer(id) {
    const fixed = {
      Dev1: "SYN-3\nAnzahl: 1",
      Dev10: "Berechtigung fehlt",
      TL4: "SYN-8\nAnzahl: 1",
      PL10: "SYN-3 SYN-4 SYN-5 SYN-6\nErledigt: 1\nOffen: 3\nStory Points: 10\nErledigte Punkte: 2\nOffene Punkte: 8",
      TL8: "SYN-3 SYN-5\nAnzahl: 2\nStory Points: 4",
    };
    return fixed[id] ?? "Die angefragte Änderung wurde beobachtet.";
  }
}
function corrupt(value) {
  if (Array.isArray(value)) return [];
  for (const field of ["values", "issues", "worklogs", "comments", "issueLinkTypes"])
    if (Array.isArray(value[field])) return { ...value, [field]: [], total: 0 };
  return {
    ...value,
    id: "99999",
    name: "Native drift",
    state: "future",
    originBoardId: 999,
    released: false,
    projectId: 999,
    lead: undefined,
    watchers: [],
    watchCount: 0,
    fields: value.fields
      ? { ...value.fields, fixVersions: [], status: { id: "99", statusCategory: { key: "new" } } }
      : undefined,
  };
}
