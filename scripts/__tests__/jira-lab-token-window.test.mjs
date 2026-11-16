import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureFixtureAdminToken } from "../testing/jira-chat-lab/seed-identities.mjs";

const { native } = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock("../testing/jira-chat-lab/lab-client.mjs", async (original) => ({
  ...(await original()),
  labRequest: native,
  checked: async (...args) => {
    const [session, , ...request] = args;
    return (await native(session, ...request)).value;
  },
}));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
function createdTokenResponse(state, token, body) {
  if (state.failCreation) throw new TypeError("Synthetic lost response");
  // Native Jira Data Center refuses a PAT name longer than 40 characters with 400 (observed live).
  if (body.name.length > 40) return { status: 400, value: {} };
  const next = { ...token(state.nextId++, state.replacementSeconds), name: body.name };
  state.tokens.push(next);
  if (state.loseCreationResponse) throw new TypeError("Synthetic committed lost creation response");
  return { status: 201, value: { ...next, rawToken: "synthetic-new-private-token" } };
}
function tokenResponse(state, token, method, target, body) {
  if (target === "/rest/pat/latest/tokens" && method === "GET")
    return { status: 200, value: structuredClone(state.tokens) };
  if (target === "/rest/pat/latest/tokens" && method === "POST")
    return createdTokenResponse(state, token, body);
  if (target.startsWith("/rest/pat/latest/tokens/") && method === "DELETE") {
    const id = Number(target.split("/").at(-1));
    state.tokens = state.tokens.filter((row) => row.id !== id);
    if (state.failRetirement) throw new TypeError("Synthetic lost retirement response");
    return { status: 204 };
  }
  throw new TypeError("Unexpected synthetic token route");
}

function fixture(seconds = 60) {
  const directory = mkdtempSync(join(tmpdir(), "jira-lab-token-window-"));
  roots.push(directory);
  mkdirSync(join(directory, "secrets"), { mode: 0o700 });
  const path = join(directory, "secrets", "admin-token");
  writeFileSync(path, "synthetic-old-private-token", { mode: 0o600 });
  writeFileSync(join(directory, "secrets", "admin-password"), "synthetic-private-password", {
    mode: 0o600,
  });
  const token = (id, seconds) => ({
    id,
    name: "Keiko synthetic 4081 session",
    expiringAt: Date.now() + seconds * 1000,
  });
  const state = {
    tokens: [token(1, seconds)],
    failCreation: false,
    wrongIdentity: false,
    replacementSeconds: 86_400,
    failRetirement: false,
    loseCreationResponse: false,
    nextId: 2,
  };
  native.mockImplementation(async (_session, method, target, auth, body) => {
    if (target.startsWith("/rest/pat/latest/tokens"))
      return tokenResponse(state, token, method, target, body);
    if (target === "/rest/api/2/myself" && auth.includes("concurrent-replacement"))
      return { status: 401 };
    if (target === "/rest/api/2/myself")
      return {
        status: 200,
        value: {
          name:
            state.wrongIdentity && auth.includes("new-private") ? "keiko-foreign" : "keiko-admin",
          active: true,
        },
      };
    if (target.startsWith("/rest/api/2/mypermissions"))
      return { status: 200, value: { permissions: { ADMINISTER: { havePermission: true } } } };
    throw new TypeError("Unexpected synthetic route");
  });
  return { session: { directory }, path, state };
}
it("renews a nearly expired owned PAT, verifies its identity and expiry, then retires only the old id", async () => {
  const f = fixture();
  await ensureFixtureAdminToken(f.session);
  expect(readFileSync(f.path, "utf8")).toBe("synthetic-new-private-token");
  expect(f.state.tokens.map((row) => row.id)).toEqual([2]);
  expect(native.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
});
it("reuses a PAT with sufficient native remaining time without mutations", async () => {
  const f = fixture(7200);
  await ensureFixtureAdminToken(f.session);
  expect(readFileSync(f.path, "utf8")).toBe("synthetic-old-private-token");
  expect(native.mock.calls.some((call) => call[1] !== "GET")).toBe(false);
});
it("retains the intent after a lost creation response and never creates a second replacement", async () => {
  const f = fixture();
  f.state.failCreation = true;
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  expect(native.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
});
it("does not replace the credential or revoke the old token if the new identity differs", async () => {
  const f = fixture();
  f.state.wrongIdentity = true;
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  expect(readFileSync(f.path, "utf8")).toBe("synthetic-old-private-token");
  expect(native.mock.calls.some((call) => call[1] === "DELETE")).toBe(false);
});
it("refuses ambiguous owned PAT metadata before any mutation", async () => {
  const f = fixture();
  f.state.tokens.push({ ...f.state.tokens[0], id: 3 });
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  expect(native.mock.calls.some((call) => call[1] !== "GET")).toBe(false);
});

it.each([undefined, null, "invalid", 0, NaN])(
  "refuses an unknown native token expiry before mutation: %s",
  async (expiry) => {
    const f = fixture();
    f.state.tokens[0].expiringAt = expiry;
    await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
    expect(native.mock.calls.some((call) => call[1] !== "GET")).toBe(false);
  },
);
it("withholds a replacement that does not outlast the requested window", async () => {
  const f = fixture();
  f.state.replacementSeconds = 60;
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  expect(readFileSync(f.path, "utf8")).toBe("synthetic-old-private-token");
  expect(native.mock.calls.some((call) => call[1] === "DELETE")).toBe(false);
});
it("recovers the verified replacement without replay after uncertain predecessor retirement", async () => {
  const f = fixture();
  f.state.failRetirement = true;
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  expect(readFileSync(f.path, "utf8")).toBe("synthetic-new-private-token");
  await ensureFixtureAdminToken(f.session);
  expect(native.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
  expect(native.mock.calls.filter((call) => call[1] === "DELETE")).toHaveLength(1);
});

it("creates and independently verifies the initial fixture PAT once", async () => {
  const f = fixture();
  unlinkSync(f.path);
  f.state.tokens = [];
  await ensureFixtureAdminToken(f.session);
  await ensureFixtureAdminToken(f.session);
  expect(readFileSync(f.path, "utf8")).toBe("synthetic-new-private-token");
  expect(native.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
  expect(native.mock.calls.some((call) => call[1] === "DELETE")).toBe(false);
});
it("keeps the original one-use guard after an uncertain initial creation", async () => {
  const f = fixture();
  unlinkSync(f.path);
  f.state.tokens = [];
  writeFileSync(join(f.session.directory, "secrets", "admin-pat-creation-started"), "1", {
    mode: 0o600,
  });
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow();
  expect(native.mock.calls.some((call) => call[1] !== "GET")).toBe(false);
});
it("refuses a credential changed by another preflight before dispatching renewal", async () => {
  const f = fixture();
  const request = native.getMockImplementation();
  native.mockImplementation(async (...args) => {
    const result = await request(...args);
    if (args[2] === "/rest/api/2/myself")
      writeFileSync(f.path, "synthetic-concurrent-replacement", { mode: 0o600 });
    return result;
  });
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  expect(native.mock.calls.some((call) => call[1] !== "GET")).toBe(false);
});

it("persists the received candidate before identity checks and recovers it without another POST", async () => {
  const f = fixture();
  f.state.wrongIdentity = true;
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  expect(readFileSync(`${f.path}.next`, "utf8")).toContain("synthetic-new-private-token");
  f.state.wrongIdentity = false;
  await ensureFixtureAdminToken(f.session);
  expect(readFileSync(f.path, "utf8")).toBe("synthetic-new-private-token");
  expect(native.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
});

it("reconstructs a lost pending file from the private candidate bundle without creating another PAT", async () => {
  const f = fixture();
  f.state.wrongIdentity = true;
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  unlinkSync(join(f.session.directory, "secrets", "admin-pat-renewal.pending.json"));
  f.state.wrongIdentity = false;
  await ensureFixtureAdminToken(f.session);
  expect(readFileSync(f.path, "utf8")).toBe("synthetic-new-private-token");
  expect(native.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
});

it("compensates only the nonce-bound orphan after a committed lost creation response", async () => {
  const f = fixture();
  f.state.loseCreationResponse = true;
  await expect(ensureFixtureAdminToken(f.session)).rejects.toThrow(TypeError);
  f.state.loseCreationResponse = false;
  await ensureFixtureAdminToken(f.session);
  const deleted = native.mock.calls.filter((call) => call[1] === "DELETE").map((call) => call[2]);
  expect(deleted).toEqual(["/rest/pat/latest/tokens/2", "/rest/pat/latest/tokens/1"]);
  expect(f.state.tokens.map((row) => row.id)).toEqual([3]);
  expect(native.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(2);
});

it("waits for another active lane before creating or retiring a PAT", async () => {
  const { ensureFixtureToken } = await import("../testing/jira-chat-lab/fixture-tokens.mjs");
  const f = fixture();
  const other = process.pid + 1;
  const lanes = join(f.session.directory, "lanes");
  mkdirSync(lanes);
  writeFileSync(join(lanes, String(other)), "active\n", { mode: 0o600 });
  const operation = ensureFixtureToken(f.session, "admin", 3600, {
    pollMs: 1,
    isAlive: () => true,
    log: () => undefined,
  });
  try {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    expect(native.mock.calls.some((call) => call[1] !== "GET")).toBe(false);
    expect(readFileSync(f.path, "utf8")).toBe("synthetic-old-private-token");
  } finally {
    writeFileSync(join(lanes, String(other)), "waiting\n", { mode: 0o600 });
  }
  await operation;
  expect(native.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
});

it("rechecks the credential after acquiring active-lane admission", async () => {
  const { ensureFixtureToken } = await import("../testing/jira-chat-lab/fixture-tokens.mjs");
  const f = fixture(7200);
  const lock = join(f.session.directory, "license-restart.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner"), String(process.pid + 1), { mode: 0o600 });
  const operation = ensureFixtureToken(f.session, "admin", 3600, {
    pollMs: 1,
    isAlive: () => true,
  });
  try {
    await vi.waitFor(() =>
      expect(native.mock.calls.some((call) => call[2] === "/rest/api/2/myself")).toBe(true),
    );
    writeFileSync(f.path, "synthetic-new-private-token", { mode: 0o600 });
    f.state.tokens = [{ ...f.state.tokens[0], id: 2 }];
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
  expect(await operation).toBe("Bearer synthetic-new-private-token");
  expect(native.mock.calls.some((call) => call[1] !== "GET")).toBe(false);
});
