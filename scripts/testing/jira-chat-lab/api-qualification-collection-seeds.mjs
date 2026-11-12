// Native seeds for the collection reads of the model-free AC7 qualification. A read of a
// collection proves a projection only when Jira holds rows, so each collection the lab can
// populate gets one owned, disposable, synthetic record. Every step first observes the native
// collection and acts only when it is empty; it then observes it again and fails closed with the
// closed reason `collection-seed-not-observed` when the record is not visible. Nothing here involves
// Keiko: these are the laboratory's own native administrator calls.
import {
  QualificationPreparationError,
  expectNative,
} from "./api-qualification-preparation-core.mjs";

const numeric = /^[1-9]\d*$/u;
const SYNTHETIC_KEY = "keiko.synthetic.fixture";
const SNAPSHOT_POLLS = 60;
const SNAPSHOT_POLL_MS = 2_000;

const rowsOf = (value, root) => {
  const rows = root === undefined ? value : value?.[root];
  return Array.isArray(rows) ? rows : [];
};
const present = async (io, path, root) =>
  rowsOf(await expectNative(io, "GET", path, undefined, [200]), root).length > 0;
async function observed(io, path, root) {
  if (!(await present(io, path, root)))
    throw new QualificationPreparationError("collection-seed-not-observed");
}
const idOf = (value) => {
  const id = String(value?.id);
  if (!numeric.test(id)) throw new QualificationPreparationError("native-response-unexpected");
  return id;
};
const issueKey = (fixture) => {
  const key = fixture.issueKeys?.[0];
  if (typeof key !== "string" || !/^KEIKO-[1-9]\d*$/u.test(key))
    throw new QualificationPreparationError("fixture-manifest-invalid");
  return key;
};

async function seedFavouriteFilter(io) {
  const path = "/rest/api/2/filter/favourite";
  if (await present(io, path)) return {};
  await expectNative(
    io,
    "POST",
    "/rest/api/2/filter",
    { name: "Keiko synthetic favourite filter", jql: "project = KEIKO", favourite: true },
    [200, 201],
  );
  await observed(io, path);
  return { seedFavouriteFilter: true };
}

async function seedProjectCategory(io) {
  if (await present(io, "/rest/api/2/projectCategory")) return {};
  await expectNative(
    io,
    "POST",
    "/rest/api/2/projectCategory",
    { name: "Keiko synthetic category", description: "Synthetic AC7 seed" },
    [200, 201],
  );
  await observed(io, "/rest/api/2/projectCategory");
  return { seedProjectCategory: true };
}

async function seedComponent(io) {
  if (await present(io, "/rest/api/2/project/KEIKO/components")) return {};
  await expectNative(
    io,
    "POST",
    "/rest/api/2/component",
    { project: "KEIKO", name: "Keiko synthetic component", description: "Synthetic AC7 seed" },
    [200, 201],
  );
  await observed(io, "/rest/api/2/project/KEIKO/components");
  await observed(io, "/rest/api/2/component/page?startAt=0&maxResults=100", "values");
  return { seedComponent: true };
}

async function seedProperties(io, fixture) {
  const key = issueKey(fixture);
  const targets = [
    [`/rest/api/2/issue/${key}/properties`, `/rest/api/2/issue/${key}/properties/${SYNTHETIC_KEY}`],
    [
      "/rest/api/2/project/KEIKO/properties",
      `/rest/api/2/project/KEIKO/properties/${SYNTHETIC_KEY}`,
    ],
    [
      `/rest/api/2/issuetype/${fixture.issueTypeId}/properties`,
      `/rest/api/2/issuetype/${fixture.issueTypeId}/properties/${SYNTHETIC_KEY}`,
    ],
    [
      "/rest/api/2/user/properties?username=keiko-api",
      `/rest/api/2/user/properties/${SYNTHETIC_KEY}?username=keiko-api`,
    ],
  ];
  if (!numeric.test(String(fixture.issueTypeId)))
    throw new QualificationPreparationError("fixture-manifest-invalid");
  for (const [list, write] of targets) {
    if (await present(io, list, "keys")) continue;
    await expectNative(io, "PUT", write, { seeded: true }, [200, 201, 204]);
    await observed(io, list, "keys");
  }
  return { seedProperties: true };
}

async function subtaskTypeId(io) {
  const project = await expectNative(io, "GET", "/rest/api/2/project/KEIKO", undefined, [200]);
  const types = (project?.issueTypes ?? []).filter((type) => type.subtask === true);
  if (types.length === 0) throw new QualificationPreparationError("collection-seed-not-observed");
  return String(types[0].id);
}

async function seedSubtask(io, fixture) {
  const key = issueKey(fixture);
  const path = `/rest/api/2/issue/${key}/subtask`;
  if (await present(io, path)) return {};
  await expectNative(
    io,
    "POST",
    "/rest/api/2/issue",
    {
      fields: {
        project: { key: "KEIKO" },
        parent: { key },
        issuetype: { id: await subtaskTypeId(io) },
        summary: "Synthetic AC7 seed sub-task",
      },
    },
    [201],
  );
  await observed(io, path);
  return { seedSubtask: true };
}

async function epicFieldId(io) {
  const fields = await expectNative(io, "GET", "/rest/api/2/field", undefined, [200]);
  const found = fields.filter(
    (field) => field.schema?.custom === "com.pyxis.greenhopper.jira:gh-epic-label",
  );
  if (found.length !== 1) throw new QualificationPreparationError("collection-seed-not-observed");
  return found[0].id;
}

/** Board epics follow the board's filter, so one owned Epic of KEIKO is seeded before the board. */
async function seedBoardEpic(io) {
  const search = "/rest/api/2/search?maxResults=1&fields=summary&jql=";
  const jql = encodeURIComponent(
    'project = KEIKO AND issuetype = Epic AND summary ~ "AC7 seed epic"',
  );
  const found = await expectNative(io, "GET", `${search}${jql}`, undefined, [200]);
  if (rowsOf(found, "issues").length > 0) return {};
  const project = await expectNative(io, "GET", "/rest/api/2/project/KEIKO", undefined, [200]);
  const types = (project?.issueTypes ?? []).filter((type) => type.name === "Epic");
  if (types.length !== 1) throw new QualificationPreparationError("collection-seed-not-observed");
  await expectNative(
    io,
    "POST",
    "/rest/api/2/issue",
    {
      fields: {
        project: { key: "KEIKO" },
        issuetype: { id: String(types[0].id) },
        summary: "Synthetic AC7 seed epic",
        [await epicFieldId(io)]: "AC7 seed epic",
      },
    },
    [201],
  );
  return { seedBoardEpic: true };
}

async function seedPinnedComment(io, fixture) {
  const key = issueKey(fixture);
  const path = `/rest/api/2/issue/${key}/pinned-comments`;
  if (await present(io, path)) return {};
  const comment = await expectNative(
    io,
    "POST",
    `/rest/api/2/issue/${key}/comment`,
    { body: "Synthetic AC7 pinned comment" },
    [201],
  );
  await expectNative(io, "PUT", `/rest/api/2/comment/${idOf(comment)}/pin`, true, [200, 204]);
  await observed(io, path);
  return { seedPinnedComment: true };
}

async function seedRemoteLink(io, fixture) {
  const key = issueKey(fixture);
  const path = `/rest/api/2/issue/${key}/remotelink`;
  if (await present(io, path)) return {};
  await expectNative(
    io,
    "POST",
    path,
    { object: { url: "https://example.invalid/keiko-ac7-seed", title: "Synthetic AC7 seed link" } },
    [200, 201],
  );
  await observed(io, path);
  return { seedRemoteLink: true };
}

/** Jira lists a deleted worklog only after a worklog existed and was removed natively. */
async function seedDeletedWorklog(io, fixture) {
  const key = issueKey(fixture);
  const path = "/rest/api/2/worklog/deleted?since=0";
  if (await present(io, path, "values")) return {};
  const worklog = await expectNative(
    io,
    "POST",
    `/rest/api/2/issue/${key}/worklog`,
    { timeSpentSeconds: 60, comment: "Synthetic AC7 deleted worklog" },
    [201],
  );
  await expectNative(
    io,
    "DELETE",
    `/rest/api/2/issue/${key}/worklog/${idOf(worklog)}`,
    undefined,
    [204],
  );
  await observed(io, path, "values");
  return { seedDeletedWorklog: true };
}

async function seedIndexSnapshot(io) {
  const list = "/rest/api/2/index-snapshot";
  if (await present(io, list)) return {};
  await expectNative(io, "POST", list, undefined, [200, 201, 202]);
  for (let poll = 0; poll < SNAPSHOT_POLLS; poll++) {
    if (await present(io, list)) return { seedIndexSnapshot: true };
    await io.sleep(SNAPSHOT_POLL_MS);
  }
  throw new QualificationPreparationError("collection-seed-not-observed");
}

/** Independent steps: none reads another's result, so one failure never hides the others. */
export const COLLECTION_SEED_STEPS = Object.freeze([
  ["seed-favourite-filter", seedFavouriteFilter],
  ["seed-project-category", seedProjectCategory],
  ["seed-component", seedComponent],
  ["seed-properties", seedProperties],
  ["seed-subtask", seedSubtask],
  ["seed-board-epic", seedBoardEpic],
  ["seed-pinned-comment", seedPinnedComment],
  ["seed-remote-link", seedRemoteLink],
  ["seed-deleted-worklog", seedDeletedWorklog],
  ["seed-index-snapshot", seedIndexSnapshot],
]);
