// Issue #3400 (epic #3384) — fixture and seeding helpers for the "Connect a Git change to Chat"
// journey. Kept separate from the spec so the real-git-repository builder and the window-seeding
// helpers read as one unit, mirroring the existing coding-issue-* support modules.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";

export const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };

function git(args: readonly string[], cwd: string): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

function gitOutput(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export interface GitChangeChatFixture {
  readonly root: string;
  readonly baseRef: string;
  readonly headRef: string;
}

// A REAL git repository with exactly one comparison: `main` (the base) with one commit ahead of
// it on `feature/x` (the head, and the branch left checked out — GitClientWindow's own "current
// branch" read). The server resolves this comparison for real; only `/api/projects` is faked (see
// the spec) so the window's picker treats the fixture as an available, trusted repository. A
// `remote.origin.url` is required — the connect route's remoteDigest is derived from it
// (gitChangeSnapshotService.ts) — but it is never fetched.
export function buildGitChangeChatFixture(): GitChangeChatFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-e2e-git-change-chat-3400-")));
  git(["init", "-q"], root);
  git(["config", "user.email", "test@keiko.example"], root);
  git(["config", "user.name", "Keiko Test"], root);
  git(["config", "commit.gpgsign", "false"], root);
  git(["remote", "add", "origin", "https://github.com/keiko-e2e/git-change-chat-3400.git"], root);

  writeFileSync(join(root, "README.md"), "# git-change-chat-3400 fixture\n", "utf8");
  git(["add", "."], root);
  git(["commit", "-m", "chore: initial commit"], root);
  // git init may name the default branch `main` or `master` depending on the environment —
  // resolve it explicitly rather than assuming.
  const baseRef = gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], root);

  git(["checkout", "-b", "feature/x"], root);
  writeFileSync(join(root, "src.txt"), "export const feature = true;\n", "utf8");
  git(["add", "src.txt"], root);
  git(["commit", "-m", "feat: add feature/x"], root);

  return { root, baseRef, headRef: "feature/x" };
}

export function removeGitChangeChatFixture(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

interface CreatedChat {
  readonly id: string;
  readonly title: string;
}

export async function createChatForFixture(
  request: APIRequestContext,
  projectPath: string,
): Promise<CreatedChat> {
  const projectResponse = await request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: projectPath, name: "git-change-chat-3400" },
  });
  if (!projectResponse.ok()) {
    throw new Error(
      `Project setup failed (${String(projectResponse.status())}): ${await projectResponse.text()}`,
    );
  }
  const response = await request.post("/api/chats", {
    headers: MUTATION_HEADERS,
    data: {
      projectPath,
      title: "External change review",
      selectedModel: "e2e-chat-model",
    },
  });
  if (response.status() !== 201) {
    throw new Error(`Chat setup failed (${String(response.status())}): ${await response.text()}`);
  }
  const created = (await response.json()) as { chat: CreatedChat };
  return created.chat;
}

// Seeds the REAL app.workspace persistence key with a governedGit window bound to the fixture
// repository and a chat window bound to the created chat — the same key + shape the real
// WindowsRegistry reads, so both windows render through the real product code, not a stub.
export async function seedWorkspace(
  page: Page,
  fixtureRoot: string,
  chat: CreatedChat,
): Promise<void> {
  await page.addInitScript(
    ({ projectPath, chatId, title }) => {
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "issue-3400-git-window",
            type: "governedGit",
            x: 24,
            y: 24,
            w: 650,
            h: 820,
            z: 20,
            cfg: { projectPath },
            max: false,
          },
          {
            id: "issue-3400-chat-window",
            type: "chat",
            x: 700,
            y: 24,
            w: 760,
            h: 820,
            z: 10,
            cfg: { chatId, title },
            max: false,
          },
        ]),
      );
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { projectPath: fixtureRoot, chatId: chat.id, title: chat.title },
  );
}

// The Git window's own toolbar-and-picker gating (BoundRootSurface) reads `/api/projects`, a
// concept entirely separate from the git-change server route's repository-membership check (which
// reads the real filesystem directly). Faking only this list — never the git read/write routes —
// mirrors the proven recipe in git-changes-view-1575.spec.ts and lets the rest of the journey run
// end-to-end against the real repository and the real server.
export async function interceptProjectList(page: Page, fixtureRoot: string): Promise<void> {
  await page.route("**/api/projects**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        projects: [
          {
            path: fixtureRoot,
            name: "git-change-chat-3400",
            favorite: false,
            createdAt: Date.now(),
            lastOpenedAt: Date.now(),
            available: true,
            workspaceAvailable: true,
          },
        ],
      }),
    });
  });
}

// ─── #3400 final-audit F5 — chat's apply action (Preview -> Approve -> Apply to PR) ─────────────
//
// A REAL "pull-request" mode connect needs the trusted checkout's GitHub-reader grant plus a live
// GitHub API read (`resolvePullRequestByHead`, gitChangeRoutes.ts) to find an open PR for the
// fixture's local branch — no such PR or network access exists in this hermetic journey. Likewise
// a real preview/apply needs a live Model Gateway call and a real GitHub PATCH. These three routes
// are scripted instead, each answering in the EXACT wire shape the real route does (the same
// `ChatGitChangeScope` / `PrDescriptionApplicationStatus` contracts api.ts's own client validates
// against) so the journey still proves the browser's real request/response wiring end to end —
// every OTHER route in this file (connect in comparison mode, refresh, chat CRUD) stays real.

export interface GitChangePullRequestScopeFixture {
  readonly relationshipId: string;
  readonly comparisonLabel: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly pullRequestNumber: number;
}

export async function interceptGitChangePullRequestConnect(
  page: Page,
  scope: GitChangePullRequestScopeFixture,
): Promise<void> {
  await page.route("**/api/git-change/connect", async (route) => {
    const body = route.request().postDataJSON() as { readonly mode?: string };
    if (body.mode !== "pull-request") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "connected",
        scope: {
          kind: "git-change",
          relationshipId: scope.relationshipId,
          remoteDigest: "d".repeat(64),
          comparisonLabel: scope.comparisonLabel,
          baseRef: scope.baseRef,
          headRef: scope.headRef,
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          mergeBaseSha: "a".repeat(40),
          snapshotDigest: "c".repeat(64),
          pullRequestNumber: scope.pullRequestNumber,
          descriptionProposalId: "e2e-proposal-1",
          fileCount: 1,
          totalFiles: 1,
          omittedFiles: 0,
          truncatedFiles: 0,
          descriptionStatus: "current",
          connectedAtMs: Date.now(),
        },
      }),
    });
  });
}

function prDescriptionApplicationStatusFixture(
  reason: "approval-required" | "applied",
): Record<string, unknown> {
  return {
    schemaVersion: "1",
    state: reason === "applied" ? "current" : "blocked",
    reason,
    binding: {
      repositoryId: "repo-1",
      remoteDigest: "d".repeat(64),
      repository: "keiko-e2e/git-change-chat-3400",
      prNumber: 42,
      prExternalId: "42",
      baseRef: "main",
      baseSha: "a".repeat(40),
      headRepository: "keiko-e2e/git-change-chat-3400",
      headRef: "feature/x",
      headSha: "b".repeat(40),
      isDraft: false,
      snapshotDigest: "c".repeat(64),
      draftDigest: "e".repeat(64),
      renderingVersion: "1",
      expectedBodyDigest: "f".repeat(64),
      outsideRegionDigest: "0".repeat(64),
      finalBodyDigest: "1".repeat(64),
      providerUpdatedAt: new Date().toISOString(),
    },
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    completeness: "complete",
    effect: reason === "applied" ? "confirmed" : "none",
    concurrency: "read-check-write-verify",
  };
}

const CHAT_DESCRIPTION_REQUEST_KEYS = new Set([
  "schemaVersion",
  "chatId",
  "relationshipId",
  "proposalId",
]);

function assertChatDescriptionRequest(request: Record<string, unknown>): void {
  if (
    request.schemaVersion !== "1" ||
    typeof request.chatId !== "string" ||
    request.chatId.length === 0 ||
    request.relationshipId !== "e2e-pr-scope-1" ||
    request.proposalId !== "e2e-proposal-1" ||
    Object.keys(request).some((key) => !CHAT_DESCRIPTION_REQUEST_KEYS.has(key))
  ) {
    throw new Error("description request did not preserve the server-held Chat binding");
  }
}

export async function interceptPrDescriptionLifecycle(page: Page): Promise<void> {
  const previewStatus = prDescriptionApplicationStatusFixture("approval-required");
  const appliedStatus = prDescriptionApplicationStatusFixture("applied");
  await page.route("**/api/git-change/review-description", async (route) => {
    const request = route.request().postDataJSON() as Record<string, unknown>;
    assertChatDescriptionRequest(request);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: "preview",
        preview: {
          proposalId: "e2e-proposal-1",
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          status: previewStatus,
          finalBody:
            "<!-- keiko:managed:v1:start -->refined over chat<!-- keiko:managed:v1:end -->",
          managedRegion: "refined over chat",
          concurrencyLimitation: "GitHub cannot lock the PR body during this update.",
        },
      }),
    });
  });
  await page.route("**/api/git-change/approve-description", async (route) => {
    assertChatDescriptionRequest(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1",
        proposalId: "e2e-proposal-1",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    });
  });
  await page.route("**/api/git-change/apply-description", async (route) => {
    assertChatDescriptionRequest(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ outcome: "observed", status: appliedStatus }),
    });
  });
}
