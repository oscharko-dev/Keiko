// Tests for what the Coding Workbench live-lab drivers do on the operator's behalf: the approval
// policy applied to the two gates of a run (shared by wb-run.mjs and wb-ui.mjs), the poll loop of
// wb-run.mjs and the buttons of wb-ui.mjs (permissions, the package-script trust pause and the
// change review of Ask for approval) against fakes, and the pairing helpers of lab-common.mjs (a
// minted attestation is checked with the product's own pairing port, and the HTTP session against a
// stubbed fetch). Nothing here talks to a dev server.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as sessionContracts from "../../packages/keiko-contracts/dist/coding-app-session.js";
import * as launcherPairing from "../../packages/keiko-server/dist/coding-app-session/launcherSessionPairingPort.js";
import * as sessionCookies from "../../packages/keiko-server/dist/coding-app-session/sessionCookie.js";
import {
  CSRF_HEADERS,
  LAB_COMMANDS,
  REPO_ROOT,
  UsageError,
  gateActions,
  importBuilt,
  mintPairing,
  openApiSession,
  runMain,
} from "../testing/coding-workbench-lab/lab-common.mjs";
import { watchRun } from "../testing/coding-workbench-lab/wb-run.mjs";
import { answerGates } from "../testing/coding-workbench-lab/wb-ui.mjs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

const RUNNING = { state: "running", revision: 1 };
const awaiting = (requestId, revision = 2) => ({
  state: "awaiting-approval",
  revision,
  pendingPermission: { requestId, kind: "command-execution" },
});
const PAUSED = { state: "paused", revision: 3 };
const DONE = { state: "succeeded", revision: 9 };

describe("gateActions: the approval policy applied to the gates of a run", () => {
  it("answers nothing under ask, whatever the run waits for", () => {
    const decided = new Set();
    for (const snapshot of [RUNNING, PAUSED, awaiting("permission-1"), DONE]) {
      expect(gateActions(snapshot, "ask", decided)).toEqual([]);
    }
    expect(decided.size).toBe(0);
  });

  it("approves a pending permission once under all, and allows package scripts only then", () => {
    const decided = new Set();
    expect(gateActions(awaiting("permission-1"), "all", decided)).toEqual([
      { kind: "permission", requestId: "permission-1", decision: "approved" },
    ]);
    expect(gateActions(PAUSED, "all", decided)).toEqual([{ kind: "allow-package-scripts" }]);
  });

  it("denies a pending permission under none and never allows package scripts", () => {
    const decided = new Set();
    expect(gateActions(awaiting("permission-1"), "none", decided)).toEqual([
      { kind: "permission", requestId: "permission-1", decision: "denied" },
    ]);
    expect(gateActions(PAUSED, "none", decided)).toEqual([]);
  });

  it("answers each permission request once, and a new request again", () => {
    const decided = new Set();
    expect(gateActions(awaiting("permission-1"), "all", decided)).toHaveLength(1);
    expect(gateActions(awaiting("permission-1", 4), "all", decided)).toEqual([]);
    expect(gateActions(awaiting("permission-2", 5), "all", decided)).toHaveLength(1);
    expect([...decided]).toEqual(["permission-1", "permission-2"]);
  });

  it("does nothing for a run that is running, done, or waiting without a request", () => {
    const decided = new Set();
    for (const snapshot of [
      RUNNING,
      DONE,
      { state: "awaiting-approval", revision: 2 },
      { state: "running", revision: 2, pendingPermission: { requestId: "permission-1" } },
    ]) {
      expect(gateActions(snapshot, "all", decided)).toEqual([]);
    }
  });
});

/** A dev-server session that answers the polls of a run from a script and records every call. */
function scriptedSession(snapshots) {
  const calls = [];
  let poll = 0;
  return {
    calls,
    request(method, path, body) {
      calls.push({ method, path, body });
      if (method === "GET" && path.endsWith("/runs/run-1")) {
        const snapshot = snapshots[Math.min(poll, snapshots.length - 1)];
        poll += 1;
        return Promise.resolve({ status: 200, json: { snapshot } });
      }
      if (path.endsWith("/approval-review")) {
        return Promise.resolve({ status: 200, json: { command: {}, diff: {} } });
      }
      if (path.endsWith("/approvals")) return Promise.resolve({ status: 200, json: {} });
      return Promise.reject(new Error(`unexpected request ${method} ${path}`));
    },
  };
}

const posts = (session) => session.calls.filter((call) => call.method === "POST");

describe("wb-run.mjs: the poll loop", () => {
  const sequence = [
    RUNNING,
    awaiting("permission-1"),
    awaiting("permission-1"),
    awaiting("permission-2", 4),
    DONE,
  ];
  const options = (approve) => ({
    approve,
    deadline: Number.POSITIVE_INFINITY,
    wait: () => Promise.resolve(),
    now: () => 0,
  });

  it("approves each request once under all, with the revision it was shown at", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const session = scriptedSession(sequence);
    const last = await watchRun(session, "run-1", options("all"));
    expect(last).toBe(DONE);
    expect(posts(session).map((call) => call.body)).toEqual([
      { requestId: "permission-1", expectedRevision: 2, decision: "approved", grantScope: "once" },
      { requestId: "permission-2", expectedRevision: 4, decision: "approved", grantScope: "once" },
    ]);
    expect(posts(session).every((call) => call.path.endsWith("/runs/run-1/approvals"))).toBe(true);
  });

  it("denies under none", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const session = scriptedSession(sequence);
    await watchRun(session, "run-1", options("none"));
    expect(posts(session).map((call) => call.body.decision)).toEqual(["denied", "denied"]);
  });

  it("reads the request and posts nothing under ask: a person decides", async () => {
    const print = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const session = scriptedSession(sequence);
    await watchRun(session, "run-1", options("ask"));
    expect(posts(session)).toEqual([]);
    const reviews = session.calls.filter((call) => call.path.endsWith("/approval-review"));
    expect(reviews).toHaveLength(2);
    const lines = print.mock.calls.map((call) => String(call[1]));
    expect(lines.filter((line) => line === "approval requested:")).toHaveLength(2);
  });

  it("says once that it cannot answer the package-script trust pause, and never grants it", async () => {
    const print = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const session = scriptedSession([RUNNING, PAUSED, PAUSED, PAUSED, DONE]);
    await watchRun(session, "run-1", options("all"));
    expect(posts(session)).toEqual([]);
    const notices = print.mock.calls.filter((call) => /cannot answer it/u.test(String(call[1])));
    expect(notices).toHaveLength(1);
  });

  it("stops at the deadline with the last snapshot it saw", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const session = scriptedSession([RUNNING]);
    let clock = 0;
    const last = await watchRun(session, "run-1", {
      approve: "none",
      deadline: 3,
      wait: () => Promise.resolve(),
      now: () => clock++,
    });
    expect(last).toBe(RUNNING);
    expect(session.calls.filter((call) => call.method === "GET")).toHaveLength(3);
  });

  it("returns nothing when the deadline has already passed", async () => {
    const session = scriptedSession([RUNNING]);
    await expect(
      watchRun(session, "run-1", {
        approve: "all",
        deadline: 0,
        wait: () => Promise.resolve(),
        now: () => 1,
      }),
    ).resolves.toBeUndefined();
    expect(session.calls).toEqual([]);
  });
});

/**
 * A Playwright page that shows only the buttons named in `visible` (by the source of their pattern)
 * and whose change-review panel is as `review` says (`visible`, and `enabled` for its buttons).
 */
function fakePage(visible = [], review = {}) {
  const clicks = [];
  const apiPosts = [];
  const panels = [];
  const reviewButtons = [];
  return {
    clicks,
    apiPosts,
    panels,
    reviewButtons,
    locator(selector) {
      panels.push(selector);
      return {
        isVisible: () => Promise.resolve(review.visible === true),
        getByRole: (role, options) => {
          reviewButtons.push({ role, ...options });
          return {
            isEnabled: () => Promise.resolve(review.enabled === true),
            click: () => {
              clicks.push(options.name);
              return Promise.resolve();
            },
          };
        },
      };
    },
    getByRole(role, { name }) {
      expect(role).toBe("button");
      return {
        first: () => ({
          isVisible: () => Promise.resolve(visible.includes(name.source)),
          textContent: () => Promise.resolve(`button ${name.source}`),
          click: () => {
            clicks.push(name.source);
            return Promise.resolve();
          },
        }),
      };
    },
    request: {
      post: (url, options) => {
        apiPosts.push({ url, options });
        return Promise.resolve({ status: () => 200 });
      },
    },
  };
}

describe("wb-ui.mjs: the gates of a run in the Workbench", () => {
  const gates = (approve) => ({ approve, decided: new Set() });
  const APPROVE = String.raw`^(Approve|Allow|Apply)`;
  const DENY = String.raw`^(Deny|Reject)`;
  const ALLOW_SCRIPTS = String.raw`^Allow package scripts`;

  it("touches nothing under ask", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const page = fakePage([APPROVE, DENY, ALLOW_SCRIPTS]);
    await answerGates(page, "run-1", awaiting("permission-1"), gates("ask"));
    await answerGates(page, "run-1", PAUSED, gates("ask"));
    expect(page.clicks).toEqual([]);
    expect(page.apiPosts).toEqual([]);
  });

  it("clicks the approve button under all, and the one to allow package scripts while paused", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const page = fakePage([APPROVE, ALLOW_SCRIPTS]);
    await answerGates(page, "run-1", awaiting("permission-1"), gates("all"));
    await answerGates(page, "run-1", PAUSED, gates("all"));
    expect(page.clicks).toEqual([APPROVE, ALLOW_SCRIPTS]);
    expect(page.apiPosts).toEqual([]);
  });

  it("falls back to the API with the same decision when the button is not on screen", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const page = fakePage([]);
    await answerGates(page, "run-1", awaiting("permission-1", 7), gates("all"));
    expect(page.clicks).toEqual([]);
    expect(page.apiPosts).toEqual([
      {
        url: "/api/coding-workbench/runtime/runs/run-1/approvals",
        options: {
          headers: CSRF_HEADERS,
          data: {
            requestId: "permission-1",
            expectedRevision: 7,
            decision: "approved",
            grantScope: "once",
          },
        },
      },
    ]);
  });

  it("clicks deny under none, never allows package scripts, and denies through the API without the button", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const page = fakePage([DENY, ALLOW_SCRIPTS]);
    await answerGates(page, "run-1", awaiting("permission-1"), gates("none"));
    await answerGates(page, "run-1", PAUSED, gates("none"));
    expect(page.clicks).toEqual([DENY]);
    const bare = fakePage([]);
    await answerGates(bare, "run-1", awaiting("permission-2"), gates("none"));
    expect(bare.apiPosts[0].options.data.decision).toBe("denied");
  });

  it("answers one request once even though the poll sees it again", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const page = fakePage([APPROVE]);
    const state = gates("all");
    await answerGates(page, "run-1", awaiting("permission-1"), state);
    await answerGates(page, "run-1", awaiting("permission-1", 3), state);
    expect(page.clicks).toEqual([APPROVE]);
  });
});

describe("wb-ui.mjs: the change review of Ask for approval", () => {
  const gates = (approve) => ({ approve, decided: new Set() });
  const READY = { visible: true, enabled: true };
  const silent = () => vi.spyOn(console, "log").mockImplementation(() => undefined);
  const UI = join(
    REPO_ROOT,
    "packages",
    "keiko-ui",
    "src",
    "app",
    "components",
    "desktop",
    "widgets",
    "coding-workbench",
  );

  it("applies the review under all and rejects it under none, while the run stays running", async () => {
    const print = silent();
    const apply = fakePage([], READY);
    await answerGates(apply, "run-1", RUNNING, gates("all"));
    expect(apply.clicks).toEqual(["Apply change"]);
    expect(apply.apiPosts).toEqual([]);
    const reject = fakePage([], READY);
    await answerGates(reject, "run-1", RUNNING, gates("none"));
    expect(reject.clicks).toEqual(["Reject change"]);
    expect(print.mock.calls.map((call) => String(call[1]))).toEqual([
      "change review via UI:",
      "change review via UI:",
    ]);
  });

  it("leaves the review to a person under ask: the panel is not even looked at", async () => {
    silent();
    const page = fakePage([], READY);
    await answerGates(page, "run-1", RUNNING, gates("ask"));
    expect(page.panels).toEqual([]);
    expect(page.clicks).toEqual([]);
  });

  it("does nothing while the panel is hidden, and never decides one review twice (its buttons are disabled)", async () => {
    silent();
    const hidden = fakePage([], { visible: false, enabled: true });
    await answerGates(hidden, "run-1", RUNNING, gates("all"));
    expect(hidden.reviewButtons).toEqual([]);
    const decided = fakePage([], { visible: true, enabled: false });
    await answerGates(decided, "run-1", RUNNING, gates("all"));
    expect(decided.reviewButtons).toHaveLength(1);
    expect(decided.clicks).toEqual([]);
  });

  it("watches the panel only while the run is running, not while it waits for a permission or the trust decision", async () => {
    silent();
    const page = fakePage([], READY);
    await answerGates(page, "run-1", awaiting("permission-1"), gates("all"));
    await answerGates(page, "run-1", PAUSED, gates("all"));
    await answerGates(page, "run-1", DONE, gates("all"));
    expect(page.panels).toEqual([]);
  });

  it("asks for the exact button of the panel", async () => {
    silent();
    const page = fakePage([], READY);
    await answerGates(page, "run-1", RUNNING, gates("all"));
    expect(page.reviewButtons).toEqual([{ role: "button", name: "Apply change", exact: true }]);
  });

  it("uses a panel selector and button names that exist in the Workbench UI source", async () => {
    silent();
    const window = readFileSync(join(UI, "CodingWorkbenchWindow.tsx"), "utf8");
    const labels = readFileSync(join(UI, "coding-workbench-i18n.en.ts"), "utf8");
    const apply = fakePage([], READY);
    await answerGates(apply, "run-1", RUNNING, gates("all"));
    const reject = fakePage([], READY);
    await answerGates(reject, "run-1", RUNNING, gates("none"));
    const headingId = /aria-labelledby="([^"]+)"/u.exec(apply.panels[0])?.[1];
    expect(headingId).toBeDefined();
    expect(window).toContain(`aria-labelledby="${String(headingId)}"`);
    expect(window).toContain(`id="${String(headingId)}"`);
    expect(labels).toContain(
      `"codingWorkbench.changesetReview.approve": "${apply.reviewButtons[0].name}"`,
    );
    expect(labels).toContain(
      `"codingWorkbench.changesetReview.deny": "${reject.reviewButtons[0].name}"`,
    );
  });
});

describe("runMain", () => {
  it("turns what main returns into the exit code, 0 when it returns nothing", async () => {
    runMain(() => Promise.resolve(3));
    await vi.waitFor(() => expect(process.exitCode).toBe(3));
    runMain(() => Promise.resolve(undefined));
    await vi.waitFor(() => expect(process.exitCode).toBe(0));
  });

  it("prints a usage error as it is and exits 2", async () => {
    const print = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runMain(() => Promise.reject(new UsageError("pass --approve")));
    await vi.waitFor(() => expect(process.exitCode).toBe(2));
    expect(print).toHaveBeenCalledWith("pass --approve");
  });

  it("prefixes any other failure with the lab and exits 1", async () => {
    const print = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runMain(() => Promise.reject(new Error("boom")));
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(print).toHaveBeenCalledWith("lab: boom");
    runMain(() => Promise.reject("plain text"));
    await vi.waitFor(() => expect(print).toHaveBeenCalledWith("lab: plain text"));
  });
});

describe("importBuilt", () => {
  it("loads a module of a built workspace package", async () => {
    const built = await importBuilt("keiko-contracts", "coding-app-session.js");
    expect(built.CODING_APP_SESSION_LAUNCHER_SECRET_ENV).toBe(
      sessionContracts.CODING_APP_SESSION_LAUNCHER_SECRET_ENV,
    );
  });

  it("tells the operator to build the packages when the module is not there", async () => {
    let failure;
    try {
      await importBuilt("keiko-contracts", "not-built-yet.js");
    } catch (error) {
      failure = error;
    }
    expect(failure.message).toMatch(
      /cannot load keiko-contracts\/dist\/not-built-yet\.js: run "npm run build:packages"/u,
    );
    expect(failure.cause.code).toBe("ERR_MODULE_NOT_FOUND");
  });
});

describe("pairing as the local operator", () => {
  const { CODING_APP_SESSION_LAUNCHER_SECRET_ENV: SECRET_ENV } = sessionContracts;
  const secret = "s".repeat(sessionContracts.CODING_APP_SESSION_LAUNCHER_SECRET_MIN_CHARS);
  const env = { [SECRET_ENV]: secret };

  it("mints one attestation the product's own pairing port approves, once, and only for this secret", async () => {
    const { attestation, fragment } = await mintPairing(env);
    expect(sessionContracts.isWellFormedCodingAppSessionPairingAttestation(attestation)).toBe(true);
    expect(attestation.requestId).toMatch(/^lab-/u);
    expect(sessionContracts.decodeCodingAppSessionPairingFragment(fragment)).toEqual(attestation);
    const port = launcherPairing.createLauncherSessionPairingPort({ secret });
    expect(port.attest(attestation).outcome).toBe("approved");
    expect(port.attest(attestation).outcome).not.toBe("approved");
    const other = launcherPairing.createLauncherSessionPairingPort({
      secret: "t".repeat(secret.length),
    });
    expect(other.attest((await mintPairing(env)).attestation).outcome).not.toBe("approved");
  });

  it("refuses a missing or short secret, naming the variable and the README step", async () => {
    for (const bad of [{}, { [SECRET_ENV]: "short" }, { [SECRET_ENV]: 42 }]) {
      await expect(mintPairing(bad)).rejects.toThrow(UsageError);
      await expect(mintPairing(bad)).rejects.toThrow(new RegExp(SECRET_ENV, "u"));
      await expect(mintPairing(bad)).rejects.toThrow(new RegExp(LAB_COMMANDS, "u"));
    }
  });

  it("pairs over HTTP and sends every request with the session cookie and the CSRF header", async () => {
    const seen = [];
    vi.stubGlobal("fetch", (url, init) => {
      seen.push({ url, init });
      if (url.endsWith("/api/coding-workbench/app-session/pair")) {
        return Promise.resolve(
          new globalThis.Response(null, {
            status: 204,
            headers: {
              "set-cookie": [`${sessionCookies.APP_SESSION_COOKIE_NAME}=abc123; Path=/; HttpOnly`],
            },
          }),
        );
      }
      return Promise.resolve(
        globalThis.Response.json({ ok: true }, { headers: { "x-keiko-correlation-id": "corr-1" } }),
      );
    });
    const session = await openApiSession("http://127.0.0.1:1983", env);
    const answer = await session.request("POST", "/api/thing", { a: 1 });
    expect(answer).toEqual({ status: 200, json: { ok: true }, correlationId: "corr-1" });
    expect(seen[0].url).toBe("http://127.0.0.1:1983/api/coding-workbench/app-session/pair");
    expect(seen[0].init.headers).toEqual(CSRF_HEADERS);
    expect(
      sessionContracts.isWellFormedCodingAppSessionPairingAttestation(
        JSON.parse(seen[0].init.body),
      ),
    ).toBe(true);
    expect(seen[1].url).toBe("http://127.0.0.1:1983/api/thing");
    expect(seen[1].init.method).toBe("POST");
    expect(seen[1].init.body).toBe('{"a":1}');
    expect(seen[1].init.headers).toEqual({
      ...CSRF_HEADERS,
      cookie: `${sessionCookies.APP_SESSION_COOKIE_NAME}=abc123`,
    });
  });

  it("keeps a short, body-free excerpt of an answer that is not JSON, and sends no body for a GET", async () => {
    const seen = [];
    vi.stubGlobal("fetch", (url, init) => {
      seen.push({ url, init });
      if (url.endsWith("/pair")) {
        return Promise.resolve(
          new globalThis.Response(null, {
            headers: { "set-cookie": `${sessionCookies.APP_SESSION_COOKIE_NAME}=c; Path=/` },
          }),
        );
      }
      return Promise.resolve(new globalThis.Response("x".repeat(500), { status: 502 }));
    });
    const session = await openApiSession("http://127.0.0.1:1983", env);
    const answer = await session.request("GET", "/api/down");
    expect(answer.status).toBe(502);
    expect(answer.json).toEqual({ raw: "x".repeat(300) });
    expect(answer.correlationId).toBeNull();
    expect(seen[1].init.body).toBeUndefined();
  });

  it("fails with the status when the dev server does not issue a session", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new globalThis.Response(null, { status: 401 })));
    await expect(openApiSession("http://127.0.0.1:1983", env)).rejects.toThrow(
      /pairing failed \(HTTP 401\); is the dev server running with the same launcher secret\?/u,
    );
  });
});
