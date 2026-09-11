// Epic #3384 correction 7 (on #3385): a run's issue-context attachment reads GitHub through the
// connector surface, and the per-checkout GitHub-reader grant (`isGitHubIssueReaderAuthorized`,
// enforced by `resolveGitHubIssue` before `buildContext` ever reaches the connector) is the real
// authorization for that read. A prior fix restated the connector-scope entitlement as
// `DELIVERY_CONNECTOR_SCOPES`, gated to `autonomous-delivery` — the run's own live network-EGRESS
// scopes, not a read taken under an already-verified grant — so a `governed-assist`/
// `supervised-coding` read with a valid grant failed `authority-denied` even though ADR-0138 D1
// admits reads and planning in every mode. `connectorScopesFor` now derives the scope from the
// matrix's one producer (`codingWorkbenchPolicyEffectFor`, `internet`/`low`, mirroring how
// `atlassian-connectors.ts` composes every other read-only connector action), which is never
// `denied` for a real mode today, so a read is admitted below Full access too; the scope is
// withheld only on an actual matrix `denied` verdict, exercised below via a mock since no mode
// issues one today.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CodingWorkbenchPolicyEffect } from "@oscharko-dev/keiko-contracts";
import type { ServerLogEvent } from "../observability/index.js";
import { createInMemoryUiStore } from "../store/index.js";
import { deriveRepositoryId } from "../task-workspace/naming.js";
import {
  createProductionCodingRuntimeIssueIntake,
  linkedIssueNumbers,
  MAX_LINKED_ISSUES,
  resolvedLinkedIssueNumbers,
} from "./codingRuntimeIssueIntake.js";
import type { GitHubIssueResolutionDeps } from "./githubIssueResolution.js";

// Forces the shared mode/resource/risk matrix to answer `denied` for one test only, so the
// "connector scope withheld" branch of `connectorScopesFor` is exercised even though no mode in
// the real, current matrix denies a read-only `internet`/`low` connector action (ADR-0138 D2).
let forcedEffect: CodingWorkbenchPolicyEffect | undefined;

vi.mock(
  "@oscharko-dev/keiko-contracts/runtime/coding-workbench",
  async (importOriginal): Promise<object> => {
    const actual =
      await importOriginal<
        typeof import("@oscharko-dev/keiko-contracts/runtime/coding-workbench")
      >();
    return {
      ...actual,
      codingWorkbenchPolicyEffectFor: (
        ...args: Parameters<typeof actual.codingWorkbenchPolicyEffectFor>
      ): CodingWorkbenchPolicyEffect =>
        forcedEffect ?? actual.codingWorkbenchPolicyEffectFor(...args),
    };
  },
);

let root: string;

function git(args: readonly string[]): void {
  execFileSync("git", args, { cwd: root });
}

// A real, remote-less git repository with a resolvable default branch: `buildContext` re-resolves
// the issue through the production resolver, which reads `refs/remotes/origin/HEAD` for real (only
// the GitHub port and the remote owner/repo resolver are injectable through `deps`).
function setRemoteHead(branch: string): void {
  git(["update-ref", `refs/remotes/origin/${branch}`, "HEAD"]);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`]);
}

beforeEach(() => {
  forcedEffect = undefined;
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-issue-intake-")));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@keiko.example"]);
  git(["config", "user.name", "Keiko Test"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
  setRemoteHead("main");
});

const cleanups: (() => void)[] = [];

afterEach(() => {
  forcedEffect = undefined;
  for (const cleanup of cleanups.splice(0)) cleanup();
  rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly deps: GitHubIssueResolutionDeps;
  readonly readJson: Mock<(argv: readonly string[]) => Promise<unknown>>;
  readonly logged: ServerLogEvent[];
}

function fixture(overrides?: { readonly title?: string; readonly body?: string }): Fixture {
  const store = createInMemoryUiStore();
  cleanups.push(() => {
    store.close();
  });
  store.createProject(root, "selected");
  store.updateGitHubIssueReaderAuthorization(deriveRepositoryId(root), true, 0);
  const object = {
    id: "123",
    nodeId: "I_test",
    state: "open",
    isPullRequest: false,
    title: overrides?.title ?? "Issue context attachment",
    body: overrides?.body ?? "Body",
    url: "https://github.com/owner/repo/issues/42",
  };
  const readJson = vi.fn((argv: readonly string[]): Promise<unknown> =>
    Promise.resolve(argv[1]?.includes("comments?") ? [] : object),
  );
  const logged: ServerLogEvent[] = [];
  const deps: GitHubIssueResolutionDeps = {
    store,
    // The real `git rev-parse` spawn (readGitDefaultBranch) needs the actual PATH to find `git`.
    env: { PATH: process.env.PATH ?? "" },
    codingContextGitHubPort: { readJson },
    codingContextGitHubRemoteResolver: () => Promise.resolve("Owner/Repo"),
    activityLog: {
      write: (event) => {
        logged.push(event);
      },
    },
  };
  return { deps, readJson, logged };
}

describe("production coding-runtime issue-context attachment (epic #3384 correction 7)", () => {
  it.each(["governed-assist", "supervised-coding", "autonomous-delivery"] as const)(
    "attaches issue context in %s with a valid checkout grant",
    async (effectiveMode) => {
      const f = fixture();
      const intake = createProductionCodingRuntimeIssueIntake(f.deps);
      const resolved = await intake.resolve({
        repositoryRoot: root,
        issueRef: "#42",
        correlationId: "run-1",
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      const attached = await intake.buildContext({
        runId: "run-1",
        repositoryRoot: root,
        binding: resolved.binding,
        effectiveMode,
        correlationId: "run-1",
      });
      expect(attached.ok).toBe(true);
      if (!attached.ok) return;
      expect(attached.attachment.issueNumber).toBe(42);
      expect(attached.attachment.itemCount).toBe(1);
      expect(f.logged.some((event) => event.op === "coding-context.pack")).toBe(false);
    },
  );

  it("refuses issue-context attachment with authority-denied when the connector-read effect is denied", async () => {
    const f = fixture();
    const intake = createProductionCodingRuntimeIssueIntake(f.deps);
    const resolved = await intake.resolve({
      repositoryRoot: root,
      issueRef: "#42",
      correlationId: "run-1",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    forcedEffect = "denied";
    const denied = await intake.buildContext({
      runId: "run-1",
      repositoryRoot: root,
      binding: resolved.binding,
      effectiveMode: "supervised-coding",
      correlationId: "run-denied",
    });
    expect(denied).toEqual({ ok: false, failure: "authority-denied" });

    const line = f.logged.find((event) => event.op === "coding-context.pack");
    expect(line).toBeDefined();
    expect(line?.category).toBe("security");
    expect(line?.correlationId).toBe("run-denied");
    expect(line?.extra?.status).toBe("blocked");
    expect(line?.extra?.blockedReasons).toEqual(["missing-scope"]);
    // Body-free: never the issue title, body, or URL.
    expect(JSON.stringify(line)).not.toContain("Issue context attachment");
  });

  // Review 3941762925: `buildCodeContextPack`'s sanitisation evidence
  // (`codeContextConnector.ts:319`, `emitSanitizationEvidence`) only reaches the log when a caller
  // injects `activityLog`/`correlationId` into its deps. This production caller had the fixture's
  // `activityLog` in scope (see `logPackBlocked` above) but never threaded it, or the request's own
  // correlation id, into `buildPack`'s call to `buildCodeContextPack` — so a hostile issue body was
  // silently sanitised with no trace in a customer's log. Pins the fix at
  // `codingRuntimeIssueIntake.ts`'s `buildPack`.
  it("logs sanitisation evidence with the request correlationId when a hostile issue body is packed", async () => {
    const hostileTitle = "\u202Emalicious title\u200B";
    const hostileBody = "clean prefix\u202E hostile suffix";
    const f = fixture({ title: hostileTitle, body: hostileBody });
    const intake = createProductionCodingRuntimeIssueIntake(f.deps);
    const resolved = await intake.resolve({
      repositoryRoot: root,
      issueRef: "#42",
      correlationId: "run-hostile",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const attached = await intake.buildContext({
      runId: "run-hostile",
      repositoryRoot: root,
      binding: resolved.binding,
      effectiveMode: "supervised-coding",
      correlationId: "run-hostile-correlation",
    });
    expect(attached.ok).toBe(true);

    const line = f.logged.find(
      (event) => event.op === "coding-context.pack" && event.extra?.outcome === "sanitized",
    );
    expect(line).toBeDefined();
    if (line === undefined) return;
    expect(line.category).toBe("security");
    expect(line.correlationId).toBe("run-hostile-correlation");
    const extra = line.extra as Record<string, unknown>;
    expect(extra.sanitizedItemCount).toBe(1);
    expect(extra.sanitizedObjectIds).toEqual(["42"]);
    expect(extra.sanitizedTitleBytesRemoved).toBeGreaterThan(0);
    expect(extra.sanitizedBodyBytesRemoved).toBeGreaterThan(0);

    // Body-free: never the raw or sanitised issue title/body.
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain("malicious title");
    expect(serialized).not.toContain("hostile suffix");
  });
});

// Zero-coverage finding on PR #3452: the linked-issue parser, resolver and skip-logging had no
// tests at all. `#42` is the bound issue throughout `fixture()`'s repository.

describe("linkedIssueNumbers (the bound issue's same-repository #n references)", () => {
  it("includes a plain #n reference", () => {
    expect(linkedIssueNumbers("See #12 for the missing piece.", 1)).toEqual([12]);
  });

  it("excludes another repository's #n and a heading's ##n while keeping a bare reference", () => {
    expect(linkedIssueNumbers("owner/repo#12 ##34 but #56 counts", 1)).toEqual([56]);
  });

  it("excludes a self-reference to the bound issue", () => {
    expect(linkedIssueNumbers("Closes #42 and relates to #7", 42)).toEqual([7]);
  });

  it("collapses duplicate references to one number", () => {
    expect(linkedIssueNumbers("#7 again, #7, and once more #7", 1)).toEqual([7]);
  });

  it("stops at MAX_LINKED_ISSUES, dropping references past the bound", () => {
    const numbers = Array.from({ length: MAX_LINKED_ISSUES + 1 }, (_, index) => index + 1);
    const body = numbers.map((issueNumber) => `#${String(issueNumber)}`).join(" ");
    const result = linkedIssueNumbers(body, 0);
    expect(result).toHaveLength(MAX_LINKED_ISSUES);
    expect(result).toEqual(numbers.slice(0, MAX_LINKED_ISSUES));
  });

  // CodeRabbit (PR #3452): the parser had no empty-body or malformed-reference cases. Each must
  // yield no issue number AND start no resolution work -- proven by asserting the GitHub reader
  // mock behind `resolvedLinkedIssueNumbers` is never called.
  it.each([
    ["an empty body", ""],
    ["a bare hash with no digits", "#"],
    ["a zero-numbered reference", "#0"],
    ["a reference far beyond any issue number the parser accepts", "#12345678901234567890"],
  ])("finds no linked issue number and starts no resolution work for %s", async (_label, body) => {
    expect(linkedIssueNumbers(body, 42)).toEqual([]);
    const f = fixture();
    const numbers = await resolvedLinkedIssueNumbers(f.deps, {
      repositoryRoot: root,
      body,
      boundIssue: 42,
      correlationId: "run-malformed",
      runId: "run-malformed",
    });
    expect(numbers).toEqual([]);
    expect(f.readJson).not.toHaveBeenCalled();
  });
});

// A per-issue-number GitHub answer, so one reference can be made to fail independently of the
// others instead of every reference sharing the single fixed object `fixture()` returns for #42.
function multiIssueReadJson(options: {
  readonly boundIssueNumber: number;
  readonly boundBody: string;
  readonly failFor: ReadonlySet<number>;
}): Mock<(argv: readonly string[]) => Promise<unknown>> {
  return vi.fn((argv: readonly string[]): Promise<unknown> => {
    const path = argv[1] ?? "";
    if (path.includes("comments?")) return Promise.resolve([]);
    const match = /\/issues\/(\d+)$/u.exec(path);
    const issueNumber = match?.[1] === undefined ? options.boundIssueNumber : Number(match[1]);
    if (options.failFor.has(issueNumber))
      return Promise.reject(new Error(`fixture: issue ${String(issueNumber)} unavailable`));
    return Promise.resolve({
      id: String(issueNumber),
      nodeId: `I_${String(issueNumber)}`,
      state: "open",
      isPullRequest: false,
      title:
        issueNumber === options.boundIssueNumber ? "Epic" : `Linked issue ${String(issueNumber)}`,
      body: issueNumber === options.boundIssueNumber ? options.boundBody : "",
      url: `https://github.com/owner/repo/issues/${String(issueNumber)}`,
    });
  });
}

describe("resolvedLinkedIssueNumbers (epic children resolved through the authorized reader)", () => {
  it("resolves a reference that reads successfully and skips + logs one that fails, under its own op", async () => {
    const f = fixture();
    const readJson = multiIssueReadJson({
      boundIssueNumber: 42,
      boundBody: "See #43 and #44",
      failFor: new Set([44]),
    });
    const deps: GitHubIssueResolutionDeps = { ...f.deps, codingContextGitHubPort: { readJson } };
    const numbers = await resolvedLinkedIssueNumbers(deps, {
      repositoryRoot: root,
      body: "See #43 and #44",
      boundIssue: 42,
      correlationId: "run-linked",
      runId: "run-linked",
    });
    expect(numbers).toEqual([43]);

    const skip = f.logged.find((event) => event.op === "coding-context.linked-issue-skipped");
    expect(skip).toBeDefined();
    expect(skip?.correlationId).toBe("run-linked");
    expect(skip?.extra?.runId).toBe("run-linked");
    expect(skip?.extra?.issueNumber).toBe(44);
    expect(skip?.extra?.failure).toBe("issue-unavailable");
    // Body-free: never the issue title or body text.
    expect(JSON.stringify(skip)).not.toContain("Epic");
  });
});
