// HTTP route tests for POST /api/git-delivery/action-sheet (Issue #473, Epic #470).
//
// Two harnesses:
//   * The real `createUiServer` dispatch — exercises the CENTRAL CSRF + 415 + body-cap enforcement,
//     request validation, the default (no-pack → fail-closed) policy path, and the redaction
//     guarantee. The default route uses NO trusted packs.
//   * A direct handler call with an injected `policyPacks` seam — exercises the policy-dependent
//     states (ready / waiting / blocked-policy) that need configured TRUSTED packs. Packs are a
//     server-side seam, never a request field (AUTHORITY RULE / AC1).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  GitDeliveryActionSheet,
  GitDeliveryOrgPolicyPack,
  GitDeliveryResolvedInputs,
} from "@oscharko-dev/keiko-contracts";
import type { GitWorktreeSnapshot } from "@oscharko-dev/keiko-tools";
import { createUiServer, UI_HOST } from "../server.js";
import { buildCspHeader } from "../csp.js";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "../index.js";
import { createInMemoryUiStore, type UiStore } from "../store/index.js";
import type { RouteContext } from "../routes.js";
import {
  createHandleGitDeliveryActionSheet,
  type GitDeliveryActionSheetErrorBody,
} from "./actionSheetRoutes.js";

const POST_HEADERS = { "Content-Type": "application/json", "X-Keiko-CSRF": "1" } as const;
const PATH = "/api/git-delivery/action-sheet";

const CLEAN_SNAPSHOT: GitWorktreeSnapshot = {
  headDetached: false,
  currentBranchName: "feature/x",
  stagedFileCount: 3,
  unstagedFileCount: 0,
  untrackedFileCount: 0,
  hasUpstream: true,
  aheadCount: 1,
  behindCount: 0,
  existingLocalBranchNames: ["feature/x", "main"],
  remoteAliases: ["origin"],
};

const COMMIT_INPUTS: GitDeliveryResolvedInputs = {
  kind: "commit",
  messageByteLength: 42,
  stagedPathCount: 3,
  allowEmptyCommit: false,
};

function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    resolvedInputs: COMMIT_INPUTS,
    worktreeSnapshot: CLEAN_SNAPSHOT,
    ...overrides,
  };
}

let server: Server;
let port: number;
let staticRoot: string;
let store: UiStore;

function deps(overrides: Partial<UiHandlerDeps> = {}): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store,
    ...overrides,
  };
}

function url(path: string): string {
  return `http://${UI_HOST}:${String(port)}${path}`;
}

async function closeServer(): Promise<void> {
  await new Promise<void>((res) => {
    server.close(() => {
      res();
    });
  });
}

async function startBound(overrides: Partial<UiHandlerDeps> = {}): Promise<void> {
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0 });
  await new Promise<void>((res) => server.listen(0, UI_HOST, res));
  port = (server.address() as AddressInfo).port;
  await closeServer();
  server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port,
    handlerDeps: deps(overrides),
  });
  await new Promise<void>((res) => server.listen(port, UI_HOST, res));
}

async function post(
  body: unknown,
  headers: Record<string, string> = POST_HEADERS,
): Promise<Response> {
  return fetch(url(PATH), {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// Build a RouteContext over an in-memory request body for direct handler calls (policy-dependent
// states needing a configured-pack seam the static route table cannot inject).
function ctxFor(body: unknown): RouteContext {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw, "utf8")]) as IncomingMessage;
  req.method = "POST";
  req.headers = { "content-type": "application/json", "x-keiko-csrf": "1" };
  return {
    req,
    res: {} as ServerResponse,
    params: {},
    url: new URL(`http://127.0.0.1${PATH}`),
  };
}

const ALLOW_COMMIT_ORG: GitDeliveryOrgPolicyPack = {
  schemaVersion: "1",
  orgId: "org-1",
  rules: [{ actionKind: "commit", decision: "allowed" }],
};

const APPROVAL_GATED_ORG: GitDeliveryOrgPolicyPack = {
  schemaVersion: "1",
  orgId: "org-1",
  rules: [
    { actionKind: "commit", decision: "approval-gated", requiredApprovers: ["lead@example.test"] },
  ],
};

beforeEach(async () => {
  staticRoot = mkdtempSync(join(tmpdir(), "keiko-gd-static-"));
  store = createInMemoryUiStore();
  await startBound();
});

afterEach(async () => {
  await closeServer();
  store.close();
  rmSync(staticRoot, { recursive: true, force: true });
});

describe("POST /api/git-delivery/action-sheet — central enforcement + validation", () => {
  it("returns 200 and blocks fail-closed (no-applicable-rule) when no packs are configured", async () => {
    const res = await post(validRequest());
    expect(res.status).toBe(200);
    const sheet = (await res.json()) as GitDeliveryActionSheet;
    expect(sheet.schemaVersion).toBe("1");
    expect(sheet.state).toBe("blocked");
    expect(sheet.blocked?.cause).toBe("policy");
    expect(sheet.policyExplanation.blockReason).toBe("no-applicable-rule");
  });

  it("does not require a deployment enable flag before policy evaluation", async () => {
    await closeServer();
    await startBound({ env: {} });
    const res = await post(validRequest());
    expect(res.status).toBe(200);
    const sheet = (await res.json()) as GitDeliveryActionSheet;
    expect(sheet.state).toBe("blocked");
    expect(sheet.blocked?.cause).toBe("policy");
    expect(sheet.policyExplanation.blockReason).toBe("no-applicable-rule");
  });

  it("returns 413 for an oversized body", async () => {
    const big = "x".repeat(70 * 1024);
    const res = await post(validRequest({ pad: big }));
    expect(res.status).toBe(413);
    const body = (await res.json()) as GitDeliveryActionSheetErrorBody;
    expect(body.error.code).toBe("GIT_DELIVERY_ACTION_SHEET_PAYLOAD_TOO_LARGE");
  });

  it("returns 400 for invalid resolvedInputs", async () => {
    const res = await post(validRequest({ resolvedInputs: { kind: "commit" } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as GitDeliveryActionSheetErrorBody;
    expect(body.error.code).toBe("GIT_DELIVERY_ACTION_SHEET_BAD_REQUEST");
  });

  it("returns 400 for an unknown top-level key", async () => {
    const res = await post(validRequest({ smuggled: "x" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as GitDeliveryActionSheetErrorBody;
    expect(body.error.code).toBe("GIT_DELIVERY_ACTION_SHEET_BAD_REQUEST");
  });

  it("returns 400 for a non-JSON body", async () => {
    const res = await post("{not json", POST_HEADERS);
    expect(res.status).toBe(400);
    const body = (await res.json()) as GitDeliveryActionSheetErrorBody;
    expect(body.error.code).toBe("GIT_DELIVERY_ACTION_SHEET_BAD_REQUEST");
  });

  it("returns 400 forbidden-payload for a credential-shaped string field", async () => {
    const res = await post(
      validRequest({
        resolvedInputs: {
          kind: "push",
          sourceBranchName: "Authorization: Bearer abc",
          remoteAlias: "origin",
          remoteBranchName: "feature/x",
          forcePush: false,
          setUpstreamTracking: false,
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as GitDeliveryActionSheetErrorBody;
    expect(body.error.code).toBe("GIT_DELIVERY_ACTION_SHEET_FORBIDDEN_PAYLOAD");
  });

  it("returns 400 for a branch name carrying a bidi/zero-width format character (Trojan-Source)", async () => {
    const res = await post(
      validRequest({
        resolvedInputs: {
          kind: "branch-create",
          // A right-to-left override (U+202E) spoofing the approval target.
          branchName: "feature/\u202Emain",
          baseBranchName: "main",
          startPointRefHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as GitDeliveryActionSheetErrorBody;
    expect(body.error.code).toBe("GIT_DELIVERY_ACTION_SHEET_BAD_REQUEST");
  });

  it("rejects the POST without the CSRF header (403, central enforcement)", async () => {
    const res = await post(validRequest(), { "Content-Type": "application/json" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "FORBIDDEN_CSRF" } });
  });

  it("rejects the POST without a JSON content-type (415, central enforcement)", async () => {
    const res = await post(validRequest(), { "X-Keiko-CSRF": "1" });
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ error: { code: "UNSUPPORTED_MEDIA_TYPE" } });
  });

  it("never echoes raw paths or secrets — the response carries only typed/content-free fields", async () => {
    const res = await post(validRequest());
    const text = await res.text();
    expect(text).not.toContain("Bearer ");
    expect(text).not.toContain("/Users/");
    expect(text).not.toContain("apiKey");
  });
});

describe("POST /api/git-delivery/action-sheet — policy-dependent states (trusted-pack seam)", () => {
  it("ready-to-execute for an allowed policy over a clean snapshot", async () => {
    const handler = createHandleGitDeliveryActionSheet({
      policyPacks: () => ({ orgPack: ALLOW_COMMIT_ORG }),
    });
    const result = await handler(ctxFor(validRequest()), deps());
    expect(result.status).toBe(200);
    const sheet = result.body as GitDeliveryActionSheet;
    expect(sheet.state).toBe("ready-to-execute");
    expect(sheet.policyExplanation.decision).toBe("allowed");
    expect(sheet.recovery).toHaveLength(0);
  });

  it("waiting-for-approval for an approval-gated policy with no approval attached", async () => {
    const handler = createHandleGitDeliveryActionSheet({
      policyPacks: () => ({ orgPack: APPROVAL_GATED_ORG }),
    });
    const result = await handler(ctxFor(validRequest()), deps());
    const sheet = result.body as GitDeliveryActionSheet;
    expect(sheet.state).toBe("waiting-for-approval");
    expect(sheet.approval.necessity).toBe("required");
    expect(sheet.approval.requiredApprovers).toEqual(["lead@example.test"]);
    expect(sheet.recovery.some((hint) => hint.actionHint === "request-approval")).toBe(true);
  });

  it("blocked preflight with recovery hints for a commit with nothing staged", async () => {
    const handler = createHandleGitDeliveryActionSheet({
      policyPacks: () => ({ orgPack: ALLOW_COMMIT_ORG }),
    });
    const result = await handler(
      ctxFor(validRequest({ worktreeSnapshot: { ...CLEAN_SNAPSHOT, stagedFileCount: 0 } })),
      deps(),
    );
    const sheet = result.body as GitDeliveryActionSheet;
    expect(sheet.state).toBe("blocked");
    expect(sheet.blocked?.cause).toBe("preflight");
    expect(
      sheet.blocked?.expectedBlockers.some((b) => b.reasonCode === "nothing-staged-to-commit"),
    ).toBe(true);
    expect(sheet.recovery.some((hint) => hint.actionHint === "stage-changes")).toBe(true);
  });

  it("uses an injected idGenerator deterministically", async () => {
    const handler = createHandleGitDeliveryActionSheet({
      idGenerator: () => "fixed-id",
      policyPacks: () => ({ orgPack: ALLOW_COMMIT_ORG }),
    });
    const result = await handler(ctxFor(validRequest()), deps());
    expect((result.body as GitDeliveryActionSheet).actionId).toBe("fixed-id");
  });
});
