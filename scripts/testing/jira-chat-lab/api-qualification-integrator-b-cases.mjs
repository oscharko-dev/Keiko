// AC7 recipes 66-78: reindex, search error lookup, security level, project-owned avatars and the
// upgrade result. Every oracle reads Jira directly with the lab actor; evidence stays body-free.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { basicAuth, labRequest, labSessionConnection } from "./lab-client.mjs";
import { readCase } from "./api-qualification-cases.mjs";
import { proof, read } from "./api-qualification-read.mjs";
import { adminMutationCase, observeAdminActor } from "./api-qualification-admin-cases.mjs";
import {
  bindQualificationFile,
  createQualificationIssue,
  createQualificationProject,
  issueReview,
  projectReview,
  qualificationPng,
  releaseQualificationFile,
} from "./api-qualification-fixtures.mjs";

const POLL_DEADLINE_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;
const REQUEST_PROBE_LIMIT = 25;
/** Jira answers an absent reindex task with a plain-text 404, so the body is parsed only when JSON. */
async function native(c, path) {
  if (!path.startsWith("/rest/")) throw new TypeError("Unexpected laboratory API path");
  const response = await globalThis.fetch(new URL(path, labSessionConnection(c.session).origin), {
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(30_000),
    headers: { Accept: "application/json", Authorization: basicAuth(c.session, c.actor) },
  });
  const text = await response.text();
  try {
    return { status: response.status, value: text === "" ? undefined : JSON.parse(text) };
  } catch {
    return { status: response.status, value: undefined };
  }
}
const admin = (entry) => ({ ...entry, actor: "admin", administration: true });
const effect = (f) => ({ expectedActorKey: f.adminActorKey, confirmUnverifiedEffect: true });

/** Bounded polling without a loop-carried await: each round either answers or waits once. */
async function until(check, deadline = Date.now() + POLL_DEADLINE_MS) {
  const value = await check();
  if (value !== undefined) return value;
  assert.ok(Date.now() < deadline, "The bounded native poll reached its deadline");
  await sleep(POLL_INTERVAL_MS);
  return until(check, deadline);
}

// ---- reindex -------------------------------------------------------------------------------
const OBSERVED_TEXT_FIELDS = ["currentSubTask", "finishTime", "startTime", "submittedTime", "type"];
/** The latest native task as the product's reviewed shape; GET 404 is the documented no-prior. */
async function latestReindex(c) {
  const response = await native(c, "/rest/api/2/reindex");
  if (response.status === 404) return { taskState: "no-prior-task" };
  // Jira redirects to the task's progress page while it runs; a poll keeps waiting for the result.
  if (response.status === 303) return { taskState: "running" };
  assert.equal(response.status, 200);
  const value = response.value;
  assert.equal(typeof value.type, "string");
  assert.ok(Number.isSafeInteger(value.currentProgress));
  assert.equal(typeof value.success, "boolean");
  return {
    taskState: "observed",
    currentProgress: value.currentProgress,
    success: value.success,
    ...Object.fromEntries(
      OBSERVED_TEXT_FIELDS.filter((key) => typeof value[key] === "string").map((key) => [
        key,
        value[key],
      ]),
    ),
  };
}
/** A review is only valid once no task is running: wait for the observed finish time. */
const settledReindex = (c) =>
  until(async () => {
    const latest = await latestReindex(c);
    return latest.taskState === "no-prior-task" || latest.finishTime !== undefined
      ? latest
      : undefined;
  });
async function prepareReindex(c, f) {
  await observeAdminActor(c, f);
  f.reindexBefore = await settledReindex(c);
}
const nativeRequestIds = async (c) => {
  const probes = Array.from({ length: REQUEST_PROBE_LIMIT }, (_, index) => String(index + 1));
  const rows = await Promise.all(
    probes.map(async (id) => ({
      id,
      status: (await native(c, `/rest/api/2/reindex/request/${id}`)).status,
    })),
  );
  return rows.filter((row) => row.status === 200).map((row) => row.id);
};
const requestId = (f) => f.reindexRequestIds?.[0] ?? "1";
// The product requires a nonempty selection, so an instance without requests probes the first ID.
const requestedIds = (f) =>
  f.reindexRequestIds?.length ? f.reindexRequestIds.slice(0, 10) : ["1"];
async function discoverRequests(c, f) {
  f.reindexRequestIds = await nativeRequestIds(c);
}

const reindexStatus = admin({
  tool: "jira.reindex-status",
  arguments: () => ({}),
  prepare: settledReindex,
  readback: async (c, data) => {
    const response = await native(c, "/rest/api/2/reindex");
    if (response.status === 404) {
      assert.equal(data.taskState, "no-prior-task");
      return proof(2);
    }
    assert.equal(response.status, 200);
    assert.equal(data.taskSelection, "active-or-latest");
    for (const field of ["type", "success", "currentProgress", "finishTime"])
      assert.equal(data[field], response.value[field]);
    return proof(5);
  },
});
const startReindex = adminMutationCase(
  "jira.start-reindex",
  (f) => ({
    ...effect(f),
    expectedReindex: f.reindexBefore,
    type: "BACKGROUND",
    indexComments: false,
    indexChangeHistory: false,
    indexWorklogs: false,
  }),
  async (c, _data, f) => {
    const before = f.reindexBefore;
    const finished = await until(async () => {
      const latest = await latestReindex(c);
      if (latest.taskState !== "observed" || latest.finishTime === undefined) return undefined;
      return before.taskState === "observed" && latest.submittedTime === before.submittedTime
        ? undefined
        : latest;
    });
    assert.equal(finished.success, true);
    return proof(2);
  },
  prepareReindex,
);
const reindexIssues = adminMutationCase(
  "jira.reindex-issues",
  (f) => ({
    ...effect(f),
    expectedIssues: [{ issueId: f.reindexIssue.id, issueKey: f.reindexIssue.key }],
    indexComments: false,
    indexChangeHistory: false,
    indexWorklogs: false,
  }),
  async (c, data, f) => {
    if (data.issueIds !== undefined) assert.deepEqual(data.issueIds, [f.reindexIssue.id]);
    const search = await read(
      c,
      `/rest/api/2/search?jql=${encodeURIComponent(`key = ${f.reindexIssue.key}`)}&fields=summary`,
    );
    assert.equal(search.total, 1);
    assert.equal(String(search.issues[0].id), f.reindexIssue.id);
    assert.equal(search.issues[0].fields.summary, f.reindexIssue.summary);
    return proof(4);
  },
  async (c, f) => {
    await observeAdminActor(c, f);
    f.reindexIssue = issueReview(await createQualificationIssue(c, f, "reindex"));
  },
);
const processReindexRequests = adminMutationCase(
  "jira.process-reindex-requests",
  (f) => ({ ...effect(f), expectedReindex: f.reindexBefore }),
  async (c, data, f) => {
    const ids = data.reindexRequestIds ?? [];
    assert.ok(Array.isArray(ids));
    const statuses = await Promise.all(
      ids.map(async (id) => (await native(c, `/rest/api/2/reindex/request/${id}`)).status),
    );
    assert.ok(statuses.every((status) => status === 200));
    f.reindexRequestIds = ids;
    // Processing may start a background task: leave the lab usable before the next recipe.
    await settledReindex(c);
    return proof(2 + ids.length);
  },
  prepareReindex,
);
const reindexRequests = admin({
  tool: "jira.reindex-requests",
  arguments: (f) => ({ requestIds: requestedIds(f), maxResults: 100 }),
  prepare: discoverRequests,
  readback: async (c, data, f) => {
    const requested = requestedIds(f);
    const query = requested.map((id) => `requestId=${id}`).join("&");
    const rows = await read(c, `/rest/api/2/reindex/request/bulk?${query}`);
    assert.ok(Array.isArray(rows));
    const nativeIds = new Set(rows.map((row) => String(row.id)));
    assert.deepEqual(new Set(data.items.map((row) => row.id)), nativeIds);
    assert.deepEqual(
      new Set(data.unreturnedRequestIds),
      new Set(requested.filter((id) => !nativeIds.has(id))),
    );
    return proof(2);
  },
});
const reindexRequest = admin({
  ...readCase(
    "jira.reindex-request",
    (f) => `/rest/api/2/reindex/request/${requestId(f)}`,
    ["id"],
    {
      nativeRoot: "single",
      productRoot: "single",
      args: (f) => ({ requestId: requestId(f) }),
      optionalFields: ["type"],
    },
  ),
  prepare: discoverRequests,
});
const reindexProgress = admin({
  ...readCase(
    "jira.reindex-progress",
    "/rest/api/2/reindex/progress",
    ["currentProgress", "success", "type"],
    { nativeRoot: "single", productRoot: "single" },
  ),
  prepare: settledReindex,
});

// ---- search error, security level, upgrade result ----------------------------------------------
const searchError = admin({
  tool: "jira.search-error",
  arguments: () => ({}),
  readback: async (c, data) => {
    const response = await native(c, "/rest/api/2/search/error/lookup");
    assert.ok(response.status === 200 || response.status === 204);
    assert.equal(data.scope, "current-user-http-context");
    assert.equal(data.errorPresent, response.status === 200);
    return proof(2);
  },
});
const levelId = (f) => String(f.securityLevelId ?? "1");
async function discoverSecurityLevel(c, f) {
  const schemes = (await read(c, "/rest/api/2/issuesecurityschemes")).issueSecuritySchemes;
  const details = await Promise.all(
    schemes.map((scheme) => read(c, `/rest/api/2/issuesecurityschemes/${scheme.id}`)),
  );
  f.securityLevelId = details.flatMap((scheme) => scheme.levels ?? [])[0]?.id;
}
const securityLevel = admin({
  ...readCase(
    "jira.security-level",
    (f) => `/rest/api/2/securitylevel/${levelId(f)}`,
    ["id", "name"],
    {
      nativeRoot: "single",
      productRoot: "single",
      args: (f) => ({ levelId: levelId(f) }),
      optionalFields: ["description"],
    },
  ),
  prepare: discoverSecurityLevel,
});
const UPGRADE_STATES = new Map([
  [303, "running"],
  [404, "no-prior-result"],
  [200, "result"],
]);
const upgradeResult = admin({
  tool: "jira.upgrade-result",
  arguments: () => ({}),
  readback: async (c, data) => {
    const response = await native(c, "/rest/api/2/upgrade");
    const state = UPGRADE_STATES.get(response.status);
    assert.ok(state !== undefined, "Only the documented native upgrade statuses are graded");
    assert.equal(data.upgradeState, state);
    if (state === "result") assert.equal(data.upgradeOutcome, response.value.outcome);
    return proof(state === "result" ? 3 : 2);
  },
});

// ---- project-owned avatars ---------------------------------------------------------------------
const avatarPath = (f) => `/rest/api/2/universal_avatar/type/project/owner/${f.avatarProject.id}`;
async function avatarRows(c, f) {
  const value = await read(c, avatarPath(f));
  const rows = (category) =>
    value[category].map((entry) => ({
      id: String(entry.id),
      category,
      selected: entry.isSelected === true,
      ...(typeof entry.owner === "string" ? { owner: entry.owner } : {}),
    }));
  return [...rows("system"), ...rows("custom")];
}
const avatarTarget = (f) => ({ kind: "project", id: f.avatarProject.id, key: f.avatarProject.key });
async function prepareAvatarUpload(c, f, chat) {
  await observeAdminActor(c, f);
  f.avatarProject = projectReview(await createQualificationProject(c, f, "avatar-owner"));
  // The recipe's own file is the connected source of this Chat while the avatar cases run.
  f.avatarFile = await bindQualificationFile(c, f, chat, "avatar-b", () =>
    qualificationPng(48, 0x7f),
  );
}
function removeAvatarFixture(c, f) {
  return releaseQualificationFile(c, f, "avatar-b");
}
const uploadOwnedAvatar = adminMutationCase(
  "jira.upload-owned-avatar",
  (f) => ({
    expectedActorKey: f.adminActorKey,
    target: avatarTarget(f),
    source: { kind: "connected-file", path: f.avatarFile.name },
    expectedFile: f.avatarFile,
    acceptTemporaryReplacement: true,
  }),
  async (c, data, f) => {
    assert.equal(data.uploadSha256, f.avatarFile.sha256);
    assert.equal(data.uploadBytes, f.avatarFile.sizeBytes);
    f.avatarTemporary = {
      uploadSha256: data.uploadSha256,
      uploadBytes: data.uploadBytes,
      crop: data.temporaryCrop,
      needsCropping: data.temporaryNeedsCropping,
    };
    // The temporary slot is session-scoped; the owner's own collection is the independent read.
    const project = await read(c, `/rest/api/2/project/${f.avatarProject.id}`);
    assert.equal(String(project.id), f.avatarProject.id);
    assert.ok((await avatarRows(c, f)).length > 0);
    return proof(5);
  },
  prepareAvatarUpload,
);
const createOwnedAvatar = adminMutationCase(
  "jira.create-owned-avatar",
  (f) => ({
    expectedActorKey: f.adminActorKey,
    target: avatarTarget(f),
    expectedTemporary: f.avatarTemporary,
    crop: f.avatarTemporary.crop,
    expectedAvatars: f.avatarsBefore,
  }),
  async (c, data, f) => {
    assert.match(data.avatarId, /^[1-9][0-9]*$/u);
    const after = await avatarRows(c, f);
    assert.equal(
      after.filter((row) => row.id === data.avatarId && row.category === "custom").length,
      1,
    );
    assert.equal(
      f.avatarsBefore.every((row) => after.some((entry) => entry.id === row.id)),
      true,
    );
    assert.equal(
      f.avatarsBefore.some((row) => row.id === data.avatarId),
      false,
    );
    f.createdAvatarId = data.avatarId;
    return proof(4);
  },
  async (c, f) => {
    await observeAdminActor(c, f);
    f.avatarsBefore = await avatarRows(c, f);
  },
);
const deleteOwnedAvatar = {
  ...adminMutationCase(
    "jira.delete-owned-avatar",
    (f) => ({
      expectedActorKey: f.adminActorKey,
      target: avatarTarget(f),
      avatarId: f.createdAvatarId,
      expectedAvatars: f.avatarsBefore,
    }),
    async (c, _data, f) => {
      const after = await avatarRows(c, f);
      assert.equal(
        after.some((row) => row.id === f.createdAvatarId),
        false,
      );
      assert.equal(
        f.avatarsBefore
          .filter((row) => row.id !== f.createdAvatarId)
          .every((row) => after.some((entry) => entry.id === row.id)),
        true,
      );
      return proof(2);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      f.avatarsBefore = await avatarRows(c, f);
      assert.equal(
        f.avatarsBefore.some((row) => row.id === f.createdAvatarId && row.category === "custom"),
        true,
      );
    },
  ),
  cleanup: removeAvatarFixture,
};

export const API_QUALIFICATION_INTEGRATOR_B_CASES = [
  reindexStatus,
  startReindex,
  reindexIssues,
  processReindexRequests,
  reindexRequests,
  reindexRequest,
  reindexProgress,
  searchError,
  securityLevel,
  uploadOwnedAvatar,
  createOwnedAvatar,
  deleteOwnedAvatar,
  upgradeResult,
];
