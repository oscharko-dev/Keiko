import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";
import {
  PREPARATION_REASONS,
  QualificationPreparationError,
  adminRequest,
  prepareAssetDashboard,
  prepareEmailDefault,
  prepareOperatorFixtures,
  prepareOptionFixture,
  preparePermissionAttribute,
  prepareSyncedSprints,
} from "../testing/jira-chat-lab/api-qualification-operator-fixtures.mjs";

const NONCE = "abcd1234";
const directories = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

/** A scripted native Jira: handlers are matched by "METHOD path"; anything else is a 404. */
function io(handlers, extra = {}) {
  const calls = [];
  return {
    calls,
    origin: "http://127.0.0.1:18081",
    request: async (method, path, body, contentType) => {
      calls.push({ method, path, body, contentType });
      const handler = handlers[`${method} ${path}`];
      const result = typeof handler === "function" ? handler(body) : handler;
      return result ?? { status: 404 };
    },
    withAdmin: async () => undefined,
    ensureSecurityScheme: async () => true,
    sleep: async () => undefined,
    observeEmailPack: async () => ({ manifestSha256: "m", entries: [{ path: "a" }] }),
    ...extra,
  };
}
const reasonOf = async (promise) => {
  const error = await promise.then(
    () => undefined,
    (value) => value,
  );
  expect(error).toBeInstanceOf(QualificationPreparationError);
  expect(PREPARATION_REASONS).toContain(error.reason);
  return error.reason;
};

describe("synced sprints", () => {
  const native = (synced = true) => {
    let next = 100;
    const created = new Map();
    return {
      "POST /rest/api/2/filter": { status: 200, value: { id: "7" } },
      "POST /rest/agile/1.0/board": { status: 201, value: { id: 5 } },
      "POST /rest/agile/1.0/sprint": (body) => {
        const id = next++;
        created.set(String(id), { id, synced: body.synced && synced, originBoardId: 5 });
        return { status: 201, value: { id } };
      },
      get: (path) => ({ status: 200, value: created.get(path.split("/").at(-1)) }),
    };
  };
  it("creates two disjoint synced sets on a scrum board and reads each back", async () => {
    const handlers = native();
    const fake = io(handlers);
    const original = fake.request;
    fake.request = (method, path, body) =>
      method === "GET" && path.startsWith("/rest/agile/1.0/sprint/")
        ? Promise.resolve(handlers.get(path))
        : original(method, path, body);
    const result = await prepareSyncedSprints(fake, {}, NONCE);
    expect(result.planningSyncedSprintIds).toEqual(["100", "101"]);
    expect(result.planningAllSyncedSprintIds).toEqual(["102", "103"]);
    const board = fake.calls.find((call) => call.path === "/rest/agile/1.0/board");
    expect(board.body).toMatchObject({ type: "scrum", filterId: 7 });
    const sprint = fake.calls.find((call) => call.path === "/rest/agile/1.0/sprint");
    expect(sprint.body).toMatchObject({ synced: true, originBoardId: 5 });
  });
  it("is idempotent while both stored sets are still natively synced", async () => {
    const fake = io({
      "GET /rest/agile/1.0/sprint/1": { status: 200, value: { synced: true } },
      "GET /rest/agile/1.0/sprint/2": { status: 200, value: { synced: true } },
    });
    const fixture = { planningSyncedSprintIds: ["1"], planningAllSyncedSprintIds: ["2"] };
    expect(await prepareSyncedSprints(fake, fixture, NONCE)).toEqual({});
    expect(fake.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("refuses a sprint that Jira did not record as synced", async () => {
    const handlers = native(false);
    const fake = io(handlers);
    const original = fake.request;
    fake.request = (method, path, body) =>
      method === "GET" && path.startsWith("/rest/agile/1.0/sprint/")
        ? Promise.resolve(handlers.get(path))
        : original(method, path, body);
    expect(await reasonOf(prepareSyncedSprints(fake, {}, NONCE))).toBe("sprint-not-synced");
  });
  it("reports a disabled synced-sprint feature by its own closed reason", async () => {
    const fake = io({
      "POST /rest/api/2/filter": { status: 200, value: { id: "7" } },
      "POST /rest/agile/1.0/board": { status: 201, value: { id: 5 } },
      "POST /rest/agile/1.0/sprint": {
        status: 400,
        value: {
          errorMessages: ["You cannot create a synced sprint when the feature is disabled."],
        },
      },
    });
    expect(await reasonOf(prepareSyncedSprints(fake, {}, NONCE))).toBe(
      "sprint-sync-feature-disabled",
    );
  });
  it("refuses an unexpected board response", async () => {
    const fake = io({
      "POST /rest/api/2/filter": { status: 200, value: { id: "7" } },
      "POST /rest/agile/1.0/board": { status: 400 },
    });
    expect(await reasonOf(prepareSyncedSprints(fake, {}, NONCE))).toBe(
      "native-response-unexpected",
    );
  });
});

describe("option field", () => {
  const optionsPath =
    "/rest/api/2/customFields/10010/options?page=1&maxResults=100&useAllContexts=true";
  it("creates a select field, adds the option in the UI and reads the id back", async () => {
    const added = vi.fn();
    const fake = io(
      {
        "POST /rest/api/2/field": (body) => ({
          status: 201,
          value: { id: "customfield_10010", type: body.type },
        }),
        [`GET ${optionsPath}`]: {
          status: 200,
          value: { values: [{ id: 33, value: `Synthetic AC7 option ${NONCE}` }] },
        },
      },
      {
        withAdmin: async (run) =>
          run({
            goto: added,
            getByRole: () => ({ first: () => ({ click: vi.fn() }), click: vi.fn() }),
            locator: () => ({ fill: vi.fn() }),
            getByText: () => ({ first: () => ({ waitFor: vi.fn() }) }),
          }),
      },
    );
    const result = await prepareOptionFixture(fake, {}, NONCE);
    expect(result).toMatchObject({ optionFieldId: "customfield_10010", optionId: "33" });
    expect(fake.calls[0].body.type).toMatch(/:select$/u);
    expect(added).toHaveBeenCalledWith(
      expect.stringContaining("ConfigureCustomField!default.jspa?customFieldId=10010"),
      expect.anything(),
    );
  });
  it("refuses a UI failure and a missing option with closed reasons", async () => {
    const create = {
      "POST /rest/api/2/field": { status: 201, value: { id: "customfield_10010" } },
    };
    const failing = io(create, {
      withAdmin: async () => {
        throw new TypeError("Synthetic Jira administration failed");
      },
    });
    expect(await reasonOf(prepareOptionFixture(failing, {}, NONCE))).toBe("option-not-created");
    const empty = io({
      ...create,
      [`GET ${optionsPath}`]: { status: 200, value: { values: [] } },
    });
    expect(await reasonOf(prepareOptionFixture(empty, {}, NONCE))).toBe("option-not-created");
  });
  it("refuses a malformed field id", async () => {
    const fake = io({ "POST /rest/api/2/field": { status: 201, value: { id: "nope" } } });
    expect(await reasonOf(prepareOptionFixture(fake, {}, NONCE))).toBe(
      "native-response-unexpected",
    );
  });
});

describe("permission attribute", () => {
  const attribute = "/rest/api/2/permissionscheme/12/attribute/ac7.key";
  it("creates an own scheme and stores a text/plain false attribute", async () => {
    const fake = io({
      "POST /rest/api/2/permissionscheme": { status: 201, value: { id: 12 } },
      [`PUT ${attribute}`]: { status: 204 },
      [`GET ${attribute}`]: { status: 200, value: { key: "ac7.key", value: "false" } },
    });
    const result = await preparePermissionAttribute(fake, {}, NONCE, "ac7.key");
    expect(result).toEqual({
      permissionAttributeSchemeId: "12",
      permissionAttributeKey: "ac7.key",
    });
    const put = fake.calls.find((call) => call.method === "PUT");
    expect(put).toMatchObject({ body: "false", contentType: "text/plain" });
  });
  it("refuses a value that was not stored and a refused write", async () => {
    const base = { "POST /rest/api/2/permissionscheme": { status: 201, value: { id: 12 } } };
    const unstored = io({
      ...base,
      [`PUT ${attribute}`]: { status: 204 },
      [`GET ${attribute}`]: { status: 200, value: { key: "ac7.key", value: "true" } },
    });
    expect(await reasonOf(preparePermissionAttribute(unstored, {}, NONCE, "ac7.key"))).toBe(
      "attribute-not-stored",
    );
    const refused = io({ ...base, [`PUT ${attribute}`]: { status: 400 } });
    expect(await reasonOf(preparePermissionAttribute(refused, {}, NONCE, "ac7.key"))).toBe(
      "native-response-unexpected",
    );
  });
  it("keeps an already stored attribute", async () => {
    const fake = io({
      [`GET ${attribute}`]: { status: 200, value: { key: "ac7.key", value: "false" } },
    });
    const fixture = { permissionAttributeSchemeId: "12", permissionAttributeKey: "ac7.key" };
    expect(await preparePermissionAttribute(fake, fixture, NONCE, "ac7.key")).toEqual({});
  });
});

describe("asset dashboard", () => {
  const name = `Synthetic AC7 dashboard ${NONCE}`;
  const native = {
    "GET /rest/api/2/dashboard?filter=my&maxResults=100": {
      status: 200,
      value: { dashboards: [{ id: "50", name }] },
    },
    "GET /rest/api/2/dashboard/50": { status: 200, value: { id: "50", name } },
    "GET /rest/api/2/dashboard/50/items/60/properties": { status: 200, value: { keys: [] } },
  };
  const formPage = (post) => ({
    request: {
      get: async () => ({
        ok: () => true,
        status: () => 200,
        text: async () => '<form><input type="hidden" name="atl_token" value="T&amp;1"></form>',
      }),
      post,
    },
  });
  const created = async (_url, options) => ({
    status: () => 302,
    headers: () => ({ location: "/secure/Dashboard.jspa?selectPageId=50" }),
    options,
  });
  const gadget = { "POST /rest/dashboards/1.0/50/gadget": { status: 200, value: { id: 60 } } };
  it("creates the dashboard through its own form and adds the item only after native readback", async () => {
    const post = vi.fn(created);
    const fake = io({ ...native, ...gadget }, { withAdmin: async (run) => run(formPage(post)) });
    expect(await prepareAssetDashboard(fake, {}, NONCE)).toEqual({
      assetDashboard: { id: "50", itemId: "60", name },
    });
    const sent = post.mock.calls[0][1];
    expect(sent.form).toMatchObject({ atl_token: "T&1", portalPageName: name });
    expect(sent.maxRedirects).toBe(0);
  });
  it("takes the item from the dashboard when the gadget response carries no id", async () => {
    const handlers = {
      ...native,
      "POST /rest/dashboards/1.0/50/gadget": { status: 201, value: {} },
      "GET /rest/dashboards/1.0/50": { status: 200, value: { gadgets: [{ id: 60 }] } },
    };
    const fake = io(handlers, { withAdmin: async (run) => run(formPage(created)) });
    expect((await prepareAssetDashboard(fake, {}, NONCE)).assetDashboard.itemId).toBe("60");
  });
  it("names the stage that refused: form, create, gadget or readback", async () => {
    const noToken = {
      request: { get: async () => ({ ok: () => true, status: () => 200, text: async () => "" }) },
    };
    const denied = { request: { get: async () => ({ ok: () => false, status: () => 403 }) } };
    const rejected = formPage(async () => ({ status: () => 200, headers: () => ({}) }));
    for (const [page, reason] of [
      [noToken, "dashboard-form-unavailable"],
      [denied, "dashboard-form-unavailable"],
      [rejected, "dashboard-create-refused"],
    ])
      expect(
        await reasonOf(
          prepareAssetDashboard(io(native, { withAdmin: async (run) => run(page) }), {}, NONCE),
        ),
      ).toBe(reason);
    const noGadget = io(
      { ...native, "POST /rest/dashboards/1.0/50/gadget": { status: 500 } },
      { withAdmin: async (run) => run(formPage(created)) },
    );
    expect(await reasonOf(prepareAssetDashboard(noGadget, {}, NONCE))).toBe(
      "dashboard-gadget-refused",
    );
    const unlisted = io(
      { "POST /rest/dashboards/1.0/50/gadget": gadget["POST /rest/dashboards/1.0/50/gadget"] },
      { withAdmin: async (run) => run(formPage(created)) },
    );
    expect(await reasonOf(prepareAssetDashboard(unlisted, {}, NONCE))).toBe(
      "dashboard-not-created",
    );
    const throwing = io(native, {
      withAdmin: async () => {
        throw new TypeError("x");
      },
    });
    expect(await reasonOf(prepareAssetDashboard(throwing, {}, NONCE))).toBe(
      "dashboard-create-refused",
    );
  });
  it("keeps a still-native stored dashboard", async () => {
    const fake = io(native);
    const fixture = { assetDashboard: { id: "50", itemId: "60", name } };
    expect(await prepareAssetDashboard(fake, fixture, NONCE)).toEqual({});
  });
});

describe("email default", () => {
  const session = { ...DEFAULT_LAB_CONNECTION };
  it("captures the pack once and binds release and image", async () => {
    const result = await prepareEmailDefault(io({}), {}, session);
    expect(result).toMatchObject({
      assetEmailDefault: { manifestSha256: "m" },
      assetEmailDefaultRelease: session.jiraVersion,
      assetEmailDefaultImage: session.jiraImageDigest,
    });
  });
  it("never recaptures a pack bound to the same release and image", async () => {
    const observe = vi.fn();
    const fixture = {
      assetEmailDefault: { entries: [] },
      assetEmailDefaultRelease: session.jiraVersion,
      assetEmailDefaultImage: session.jiraImageDigest,
    };
    expect(
      await prepareEmailDefault(io({}, { observeEmailPack: observe }), fixture, session),
    ).toEqual({});
    expect(observe).not.toHaveBeenCalled();
  });
  it("refuses an unavailable or empty export", async () => {
    const failing = io({}, { observeEmailPack: async () => Promise.reject(new Error("x")) });
    expect(await reasonOf(prepareEmailDefault(failing, {}, session))).toBe(
      "email-default-unavailable",
    );
    const empty = io({}, { observeEmailPack: async () => ({ entries: [] }) });
    expect(await reasonOf(prepareEmailDefault(empty, {}, session))).toBe(
      "email-default-unavailable",
    );
  });
});

describe("manifest merge", () => {
  const session = (directory) => ({ ...DEFAULT_LAB_CONNECTION, directory });
  const manifestDirectory = (content) => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-operator-"));
    directories.push(directory);
    if (content !== undefined) writeFileSync(join(directory, "fixture.json"), content);
    return directory;
  };
  it("rejects a missing or non-object fixture manifest", async () => {
    for (const content of [undefined, "[]", "null"])
      expect(
        await reasonOf(prepareOperatorFixtures(session(manifestDirectory(content)), io({}))),
      ).toBe("fixture-manifest-invalid");
  });
  it("preserves existing keys, writes privately and runs every step despite refusals", async () => {
    const directory = manifestDirectory(
      JSON.stringify({ project: "KEIKO", issueKeys: ["KEIKO-1"] }),
    );
    const fake = io({ "POST /rest/api/2/filter": { status: 500 } });
    let outcomes;
    await reasonOf(
      prepareOperatorFixtures(session(directory), fake, {
        nonce: NONCE,
        onOutcomes: (value) => (outcomes = value),
      }),
    );
    expect(outcomes.find((entry) => entry.step === "email-default").outcome).toBe("completed");
    expect(outcomes.find((entry) => entry.step === "synced-sprints")).toMatchObject({
      outcome: "failed",
      reason: "native-response-unexpected",
      status: 500,
    });
    expect(outcomes.find((entry) => entry.step === "seed-subtask")).toBeDefined();
    const written = JSON.parse(readFileSync(join(directory, "fixture.json"), "utf8"));
    expect(written).toMatchObject({ project: "KEIKO", issueKeys: ["KEIKO-1"] });
    expect(written.assetEmailDefault.entries).toHaveLength(1);
    expect(statSync(join(directory, "fixture.json")).mode & 0o077).toBe(0);
  });
});

describe("security scheme step", () => {
  const manifest = () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-operator-"));
    directories.push(directory);
    writeFileSync(join(directory, "fixture.json"), JSON.stringify({ issueKeys: ["KEIKO-1"] }));
    return { ...DEFAULT_LAB_CONNECTION, directory };
  };
  const securityOutcome = async (ensure) => {
    let outcomes;
    await prepareOperatorFixtures(manifest(), io({}, { ensureSecurityScheme: ensure }), {
      nonce: NONCE,
      onOutcomes: (value) => (outcomes = value),
    }).catch(() => undefined);
    return outcomes.find((entry) => entry.step === "security-scheme");
  };
  it("retries a cold administration page from observation and then succeeds", async () => {
    const ensure = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("timeout"))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    expect(await securityOutcome(ensure)).toEqual({
      step: "security-scheme",
      outcome: "completed",
    });
    expect(ensure).toHaveBeenCalledTimes(3);
  });
  it("reports a closed reason after the bounded attempts", async () => {
    const ensure = vi.fn().mockResolvedValue(false);
    expect(await securityOutcome(ensure)).toEqual({
      step: "security-scheme",
      outcome: "failed",
      reason: "security-scheme-unavailable",
    });
    expect(ensure).toHaveBeenCalledTimes(3);
  });
});

describe("native request", () => {
  it("sends the raw text body with its content type and rejects other paths", async () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-operator-"));
    directories.push(directory);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(directory, "secrets"));
    writeFileSync(join(directory, "secrets/admin-password"), "synthetic", { mode: 0o600 });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new globalThis.Response("not json", { status: 200 }));
    const result = await adminRequest(
      { ...DEFAULT_LAB_CONNECTION, directory },
      "PUT",
      "/rest/api/2/x",
      "false",
      "text/plain",
    );
    expect(result).toEqual({ status: 200, value: undefined });
    expect(fetch.mock.calls[0][1]).toMatchObject({ body: "false" });
    expect(fetch.mock.calls[0][1].headers["Content-Type"]).toBe("text/plain");
    await expect(
      adminRequest({ ...DEFAULT_LAB_CONNECTION, directory }, "GET", "/secure/x"),
    ).rejects.toThrow(TypeError);
  });
});
