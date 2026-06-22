import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import type {
  EditorPatchApplyWireResponse,
  EditorPatchVerificationSummary,
  EvidenceStore,
} from "@oscharko-dev/keiko-contracts";
import { buildRedactor, createInMemoryUiStore } from "../index.js";
import type { RouteContext, UiHandlerDeps } from "../index.js";
import type { UiStore } from "../store/index.js";
import {
  handleEditorPatchApply,
  isPatchApplyEnabledByPolicy,
  isPatchApplyVerificationEnabledByPolicy,
  type EditorPatchApplyRouteOptions,
} from "./patchApplyRoutes.js";
import type {
  PostApplyVerificationPreflightPort,
  PostApplyVerificationPort,
} from "./postApplyVerification.js";

let root: string;
let store: UiStore;

function postContext(body: unknown): RouteContext {
  const req = Readable.from([
    Buffer.from(JSON.stringify(body), "utf8"),
  ]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL("http://localhost/api/editor/patch-apply"),
  };
}

function rawPostContext(body: string): RouteContext {
  const req = Readable.from([Buffer.from(body, "utf8")]) as unknown as IncomingMessage;
  (req as { method?: string }).method = "POST";
  return {
    req,
    res: {} as unknown as ServerResponse,
    params: {},
    url: new URL("http://localhost/api/editor/patch-apply"),
  };
}

function deps(
  input: { env?: Record<string, string | undefined>; evidenceStore?: EvidenceStore } = {},
): UiHandlerDeps {
  return {
    store,
    redactor: buildRedactor(input.env ?? {}, undefined),
    evidenceStore: input.evidenceStore ?? createInMemoryEvidenceStore(),
    env: input.env ?? {},
  } as unknown as UiHandlerDeps;
}

const ENABLED = { KEIKO_EDITOR_PATCH_APPLY: "on" };
const ENABLED_NO_VERIFY = {
  KEIKO_EDITOR_PATCH_APPLY: "on",
  KEIKO_EDITOR_PATCH_APPLY_VERIFICATION: "off",
};
const PATCH_ID = "0123456789abcdef0123456789abcdef";

const CREATE_DIFF = "--- /dev/null\n+++ b/src/a.test.ts\n@@ -0,0 +1,1 @@\n+it('x', () => {});\n";
const MODIFY_DIFF = "--- a/src/x.txt\n+++ b/src/x.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";
const ESCAPE_DIFF = "--- a/../../etc/x\n+++ b/../../etc/x\n@@ -1,1 +1,1 @@\n-a\n+b\n";

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    root,
    patchId: PATCH_ID,
    decision: "apply",
    diff: CREATE_DIFF,
    ...overrides,
  };
}

function summary(
  overrides: Partial<EditorPatchVerificationSummary> = {},
): EditorPatchVerificationSummary {
  return {
    outcome: "passed",
    networkEnforced: true,
    sandboxBackend: "bubblewrap",
    stepCount: 1,
    passed: 1,
    failed: 0,
    durationMs: 5,
    bounds: { wallTimeMs: 120_000, maxOutputBytes: 1_048_576, envAllowlistCount: 14 },
    preApply: false,
    secretsRedacted: true,
    ...overrides,
  };
}

function verificationPort(s: EditorPatchVerificationSummary): PostApplyVerificationPort {
  return () => Promise.resolve({ summary: s, command: "npx vitest run" });
}

const passingPreflight: PostApplyVerificationPreflightPort = () => Promise.resolve({ ok: true });

function deniedPreflight(s: EditorPatchVerificationSummary): PostApplyVerificationPreflightPort {
  return () => Promise.resolve({ ok: false, summary: s, command: "none" });
}

function options(
  s: EditorPatchVerificationSummary = summary(),
  preflight: PostApplyVerificationPreflightPort = passingPreflight,
): EditorPatchApplyRouteOptions {
  return { verification: verificationPort(s), verificationPreflight: preflight, now: () => 1_000 };
}

function wire(result: { status: number; body: unknown }): EditorPatchApplyWireResponse {
  return result.body as EditorPatchApplyWireResponse;
}

async function exists(rel: string): Promise<boolean> {
  try {
    await stat(join(root, rel));
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "keiko-patchapply-route-")));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
  store = createInMemoryUiStore();
  store.createProject(root, "fixture");
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("patch-apply policy gates", () => {
  it("is disabled by default and enabled only on an explicit token", () => {
    expect(isPatchApplyEnabledByPolicy(undefined)).toBe(false);
    expect(isPatchApplyEnabledByPolicy({})).toBe(false);
    expect(isPatchApplyEnabledByPolicy(ENABLED)).toBe(true);
  });

  it("runs verification by default and skips it only on an explicit disable token", () => {
    expect(isPatchApplyVerificationEnabledByPolicy(undefined)).toBe(true);
    expect(isPatchApplyVerificationEnabledByPolicy(ENABLED)).toBe(true);
    expect(isPatchApplyVerificationEnabledByPolicy(ENABLED_NO_VERIFY)).toBe(false);
  });
});

describe("POST /api/editor/patch-apply — switched off (v1 default)", () => {
  it("returns disabled and performs no write when the flag is off", async () => {
    const result = await handleEditorPatchApply(postContext(body()), deps(), options());
    expect(result.status).toBe(200);
    const response = wire(result);
    expect(response.status).toBe("disabled");
    expect(response.patchId).toBe("disabled");
    expect(await exists("src/a.test.ts")).toBe(false);
  });

  it("returns disabled for malformed JSON without request validation when the flag is off", async () => {
    const result = await handleEditorPatchApply(rawPostContext("{not json"), deps(), options());
    expect(result.status).toBe(200);
    expect(wire(result).status).toBe("disabled");
  });

  it("returns disabled for an oversized raw body without reading it when the flag is off", async () => {
    const result = await handleEditorPatchApply(
      rawPostContext("x".repeat(2 * 1_048_576 + 1)),
      deps(),
      options(),
    );
    expect(result.status).toBe(200);
    expect(wire(result).status).toBe("disabled");
  });

  it("rejects a malformed request body with 400", async () => {
    const result = await handleEditorPatchApply(
      postContext({ schemaVersion: "1", root }),
      deps({ env: ENABLED }),
      options(),
    );
    expect(result.status).toBe(400);
  });
});

describe("POST /api/editor/patch-apply — explicit decision (AC1)", () => {
  it("applies a reviewed create patch on an explicit apply, then verifies (success)", async () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const result = await handleEditorPatchApply(
      postContext(body()),
      deps({ env: ENABLED, evidenceStore }),
      options(),
    );
    const response = wire(result);
    expect(response.status).toBe("applied");
    expect(response.applied).toEqual({ changedFiles: 1, created: 1, deleted: 0 });
    expect(response.verification?.outcome).toBe("passed");
    expect(response.verification?.networkEnforced).toBe(true);
    expect(await readFile(join(root, "src/a.test.ts"), "utf8")).toBe("it('x', () => {});\n");
    // Proposal → apply → verification evidence linkage by patchId (AC4).
    expect(response.evidence?.applyRunId).toBeTruthy();
    expect(response.evidence?.verificationRunId).toBeTruthy();
    expect(evidenceStore.list().length).toBe(2);
  });

  it("records a reject decision and mutates nothing", async () => {
    const result = await handleEditorPatchApply(
      postContext(body({ decision: "reject" })),
      deps({ env: ENABLED }),
      options(),
    );
    const response = wire(result);
    expect(response.status).toBe("rejected");
    expect(response.evidence?.applyRunId).toBeTruthy();
    expect(await exists("src/a.test.ts")).toBe(false);
  });
});

describe("POST /api/editor/patch-apply — scope and conflict guardrails", () => {
  it("rejects an out-of-scope patch (AC2) and writes nothing", async () => {
    const result = await handleEditorPatchApply(
      postContext(body({ diff: ESCAPE_DIFF })),
      deps({ env: ENABLED }),
      options(),
    );
    const response = wire(result);
    expect(response.status).toBe("conflict");
    expect(response.rejections?.some((r) => r.reason === "out-of-scope")).toBe(true);
  });

  it("rejects silently overwriting an existing file without confirmation (AC7/AC14)", async () => {
    await writeFile(join(root, "src/a.test.ts"), "existing\n", "utf8");
    const result = await handleEditorPatchApply(
      postContext(body()),
      deps({ env: ENABLED }),
      options(),
    );
    const response = wire(result);
    expect(response.status).toBe("conflict");
    expect(response.rejections?.some((r) => r.reason === "would-overwrite")).toBe(true);
    expect(await readFile(join(root, "src/a.test.ts"), "utf8")).toBe("existing\n");
  });

  it("overwrites an existing file only with explicit allowOverwrite confirmation", async () => {
    await writeFile(join(root, "src/a.test.ts"), "existing\n", "utf8");
    const result = await handleEditorPatchApply(
      postContext(body({ allowOverwrite: true })),
      deps({ env: ENABLED }),
      options(),
    );
    expect(wire(result).status).toBe("applied");
    expect(await readFile(join(root, "src/a.test.ts"), "utf8")).toBe("it('x', () => {});\n");
  });

  it("rejects a write-conflict when the file changed after the patch was proposed", async () => {
    await writeFile(join(root, "src/x.txt"), "one\nDIFFERENT\n", "utf8");
    const result = await handleEditorPatchApply(
      postContext(body({ diff: MODIFY_DIFF })),
      deps({ env: ENABLED }),
      options(),
    );
    const response = wire(result);
    expect(response.status).toBe("conflict");
    expect(response.rejections?.some((r) => r.reason === "write-conflict")).toBe(true);
  });

  it("rejects an unparseable (invalid) patch", async () => {
    const broken = "--- a/src/x.txt\n+++ b/src/x.txt\n@@ BROKEN @@\n-a\n+b\n";
    const result = await handleEditorPatchApply(
      postContext(body({ diff: broken })),
      deps({ env: ENABLED }),
      options(),
    );
    const response = wire(result);
    expect(response.status).toBe("conflict");
    expect(response.rejections?.some((r) => r.reason === "invalid-patch")).toBe(true);
  });

  it("rejects a patch that contains no file changes (empty)", async () => {
    const result = await handleEditorPatchApply(
      postContext(body({ diff: "this is not a diff" })),
      deps({ env: ENABLED }),
      options(),
    );
    const response = wire(result);
    expect(response.status).toBe("conflict");
    expect(response.rejections?.some((r) => r.reason === "empty-patch")).toBe(true);
  });
});

describe("POST /api/editor/patch-apply — post-apply verification (AC3/AC5/AC10)", () => {
  it("runs verification after apply by default", async () => {
    const result = await handleEditorPatchApply(
      postContext(body()),
      deps({ env: ENABLED }),
      options(summary({ outcome: "passed" })),
    );
    expect(wire(result).verification?.outcome).toBe("passed");
  });

  it("ignores request-level verify=false and still runs verification", async () => {
    const result = await handleEditorPatchApply(
      postContext(body({ verify: false })),
      deps({ env: ENABLED }),
      options(),
    );
    expect(wire(result).verification?.outcome).toBe("passed");
  });

  it("skips verification when disabled by deployment policy", async () => {
    const result = await handleEditorPatchApply(
      postContext(body()),
      deps({ env: ENABLED_NO_VERIFY }),
      options(),
    );
    expect(wire(result).verification?.outcome).toBe("skipped");
  });

  it("surfaces a guarded revert proposal on failed verification, without auto-reverting (AC5)", async () => {
    const result = await handleEditorPatchApply(
      postContext(body()),
      deps({ env: ENABLED }),
      options(summary({ outcome: "failed", passed: 0, failed: 1 })),
    );
    const response = wire(result);
    expect(response.status).toBe("applied");
    expect(response.verification?.outcome).toBe("failed");
    expect(response.revertProposal?.patchId).toBe(PATCH_ID);
    expect(response.revertProposal?.diff).toContain("+++ /dev/null");
    // The applied file is NOT auto-reverted (no unreviewed follow-up mutation).
    expect(await exists("src/a.test.ts")).toBe(true);
  });

  it("denies before write when verification preflight cannot enforce egress", async () => {
    const evidenceStore = createInMemoryEvidenceStore();
    const result = await handleEditorPatchApply(
      postContext(body()),
      deps({ env: ENABLED, evidenceStore }),
      options(
        summary(),
        deniedPreflight(
          summary({
            outcome: "denied",
            networkEnforced: false,
            sandboxBackend: "none",
            stepCount: 0,
            passed: 0,
            failed: 0,
            preApply: true,
          }),
        ),
      ),
    );
    const response = wire(result);
    expect(response.status).toBe("failed");
    expect(response.evidence?.applyRunId).toBeTruthy();
    expect(response.evidence?.verificationRunId).toBeTruthy();
    expect(await exists("src/a.test.ts")).toBe(false);
    expect(evidenceStore.list()).toHaveLength(2);
  });

  it("does not expose a restore diff after confirmed overwrite failure", async () => {
    await writeFile(join(root, "src/a.test.ts"), "existing\n", "utf8");
    const result = await handleEditorPatchApply(
      postContext(body({ allowOverwrite: true })),
      deps({ env: ENABLED }),
      options(summary({ outcome: "failed", passed: 0, failed: 1 })),
    );
    const response = wire(result);
    expect(response.status).toBe("applied");
    expect(await readFile(join(root, "src/a.test.ts"), "utf8")).toBe("it('x', () => {});\n");
    expect(response.revertProposal).toBeUndefined();
  });

  it("does not propose a revert when verification is denied (egress unavailable)", async () => {
    const result = await handleEditorPatchApply(
      postContext(body()),
      deps({ env: ENABLED }),
      options(summary({ outcome: "denied", networkEnforced: false, sandboxBackend: "none" })),
    );
    const response = wire(result);
    expect(response.status).toBe("applied");
    expect(response.verification?.outcome).toBe("denied");
    expect(response.revertProposal).toBeUndefined();
  });
});
