// Epic #1852 child #1870 — pre-consent no-side-effect + leakage regression suite. It proves that the
// /api/docs-browser/propose and /approve routes, run against a battery of hostile targets, never:
//   * create a Knowledge Pod, capsule, document, chunk, vector, or persistent indexing job,
//   * request a Model Gateway port (so no embedding/reranker/chat model can be called),
//   * leak a raw token, credential, private path, or query string into any response body.
// The store is REAL (a temp SQLite db) so a write regression is observable as a row that should be
// zero. This is the hard gate: if any pre-consent side effect appears, this suite goes red.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCspHeader } from "./csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "./index.js";
import { createRunRegistry } from "./runs.js";
import { createUiServer, UI_HOST } from "./server.js";
import { openKnowledgeStoreForDeps } from "./local-knowledge-store-open.js";
import { listKnowledgePodSummaries } from "@oscharko-dev/keiko-local-knowledge";

interface Fixture {
  readonly port: number;
  readonly deps: UiHandlerDeps;
  readonly modelPortFactory: ReturnType<typeof vi.fn>;
  readonly close: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const staticRoot = await mkdtemp(join(tmpdir(), "keiko-consent-safety-"));
  const runtimeDir = await mkdtemp(join(tmpdir(), "keiko-consent-state-"));
  const modelPortFactory = vi.fn((): undefined => undefined);
  const deps: UiHandlerDeps = {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): string => "",
      list: (): readonly string[] => [],
      get: (): undefined => undefined,
      delete: (): undefined => undefined,
    },
    env: process.env,
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory,
    store: createInMemoryUiStore(),
    uiDbPath: join(runtimeDir, "ui.sqlite"),
  };
  let server = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps: deps });
  await new Promise<void>((resolve) => server.listen(0, UI_HOST, resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port, handlerDeps: deps });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
  return {
    port,
    deps,
    modelPortFactory,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      deps.store.close();
      await rm(staticRoot, { recursive: true, force: true });
      await rm(runtimeDir, { recursive: true, force: true });
    },
  };
}

let active: Fixture[] = [];
beforeEach(() => {
  active = [];
});
afterEach(async () => {
  for (const fx of active) await fx.close();
  active = [];
});

async function fixture(): Promise<Fixture> {
  const fx = await makeFixture();
  active.push(fx);
  return fx;
}

const CSRF_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/json",
  "X-Keiko-CSRF": "1",
};

function post(fx: Fixture, route: "propose" | "approve", target: string): Promise<Response> {
  return fetch(`http://${UI_HOST}:${String(fx.port)}/api/docs-browser/${route}`, {
    method: "POST",
    headers: CSRF_HEADERS,
    body: JSON.stringify({ target }),
  });
}

function countIndexingJobs(deps: UiHandlerDeps): number {
  const handle = openKnowledgeStoreForDeps(deps);
  try {
    const row = handle.store._internal.db
      .prepare("SELECT COUNT(*) AS n FROM indexing_jobs")
      .get() as { readonly n: number };
    return row.n;
  } finally {
    handle.close();
  }
}

function countPods(deps: UiHandlerDeps): number {
  const handle = openKnowledgeStoreForDeps(deps);
  try {
    return listKnowledgePodSummaries(handle.store).length;
  } finally {
    handle.close();
  }
}

// Targets that carry secrets, credentials, traversal, or dynamic shapes. Redaction must hold for
// every one, and none may produce any index state.
const HOSTILE = [
  {
    target: "https://intranet/docs/index.html?token=SECRET123&api_key=leakme",
    leaks: ["SECRET123", "leakme", "token", "api_key"],
  },
  { target: "https://user:hunter2@intranet/handbook/index.html", leaks: ["hunter2"] },
  { target: "https://intranet/docs/../../private/passwd/index.html", leaks: ["passwd"] },
  { target: "file:///home/alice/private-secret/manual.html", leaks: ["alice", "private-secret"] },
  { target: "javascript:alert('xss')", leaks: ["alert", "xss"] },
  {
    target: "https://intranet/login?redirect=/admin&session=abc",
    leaks: ["admin", "session", "abc"],
  },
  { target: `https://intranet/docs/${"deep/".repeat(2000)}index.html`, leaks: ["deep"] },
] as const;

describe("pre-consent no-side-effect gate (#1870)", () => {
  it("never writes index state, never calls a model, and never leaks across the hostile battery", async () => {
    const fx = await fixture();
    for (const entry of HOSTILE) {
      for (const route of ["propose", "approve"] as const) {
        const res = await post(fx, route, entry.target);
        const text = await res.text();
        for (const secret of entry.leaks) {
          expect(text).not.toContain(secret);
        }
      }
    }
    expect(fx.modelPortFactory).not.toHaveBeenCalled();
    expect(countPods(fx.deps)).toBe(0);
    expect(countIndexingJobs(fx.deps)).toBe(0);
  });

  it("proposing many legitimate manuals still creates no capsule, job, or model call", async () => {
    const fx = await fixture();
    for (const target of [
      "https://intranet/handbook/index.html",
      "http://127.0.0.1:8080/docs/",
      "file:///opt/manuals/index.html",
      "https://intranet/guide/chapter.html",
    ]) {
      await post(fx, "propose", target);
      await post(fx, "approve", target);
    }
    expect(countPods(fx.deps)).toBe(0);
    expect(countIndexingJobs(fx.deps)).toBe(0);
    expect(fx.modelPortFactory).not.toHaveBeenCalled();
  });
});

describe("hostile input fail-closed classification (#1870)", () => {
  it("denies credentialed targets, declines unsupported schemes, and degrades action pages", async () => {
    const fx = await fixture();
    const stateOf = async (target: string): Promise<string> =>
      ((await (await post(fx, "propose", target)).json()) as { state: string }).state;
    expect(await stateOf("https://user:p@intranet/index.html")).toBe("denied");
    expect(await stateOf("javascript:alert(1)")).toBe("unsupported");
    expect(await stateOf("https://intranet/docs/login")).toBe("degraded");
  });

  it("refuses to approve any non-approvable hostile target", async () => {
    const fx = await fixture();
    for (const target of [
      "https://user:p@intranet/index.html",
      "javascript:alert(1)",
      "https://example.com/docs/index.html",
      "https://intranet/docs/login",
    ]) {
      const res = await post(fx, "approve", target);
      expect(res.status).toBe(409);
    }
  });
});
