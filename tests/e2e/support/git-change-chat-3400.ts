// Issue #3400 (epic #3384) — fixture and seeding helpers for the "Connect a Git change to Chat"
// journey. Kept separate from the spec so the real-git-repository builder and the window-seeding
// helpers read as one unit, mirroring the existing coding-issue-* support modules.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

export const GIT_CHANGE_CHAT_REPOSITORY = "fixture/git-change-chat-fork";
export const GIT_CHANGE_CHAT_MODEL_ID = "functional-model";

// A REAL git repository with exactly one comparison: `main` (the base) with one commit ahead of
// it on `feature/x` (the head, and the branch left checked out — GitClientWindow's own "current
// branch" read). The server resolves this comparison for real; only `/api/projects` is faked (see
// the spec) so the window's picker treats the fixture as an available, trusted repository. A
// `remote.origin.url` is required — the connect route's remoteDigest is derived from it
// (gitChangeSnapshotService.ts) — but it is never fetched.
export function buildGitChangeChatFixture(): GitChangeChatFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-e2e-git-change-chat-3400-")));
  git(["init", "-q", "-b", "main"], root);
  git(["config", "user.email", "test@keiko.example"], root);
  git(["config", "user.name", "Keiko Test"], root);
  git(["config", "commit.gpgsign", "false"], root);
  // Deliberately register a different GitHub remote first. The Chat description routes must derive
  // their target from the checkout's server-owned `origin`, never whichever remote a browser lists
  // first (the fork/upstream mismatch from PR review thread fjQcs).
  git(["remote", "add", "aaa-upstream", "https://github.com/fixture/git-change-chat.git"], root);
  git(["remote", "add", "origin", `https://github.com/${GIT_CHANGE_CHAT_REPOSITORY}.git`], root);

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

// T25 — advances the fixture's already-checked-out `feature/x` head by one commit so a
// subsequent Refresh has a genuinely moved comparison to detect, proving the production
// stale-detection path (gitChangeRoutes.ts's `persistStaleScope`) rather than only the
// unchanged-comparison case the original journey covered.
export function advanceGitChangeChatFixtureHead(fixture: GitChangeChatFixture): void {
  writeFileSync(
    join(fixture.root, "src.txt"),
    "export const feature = true;\nexport const moved = true;\n",
    "utf8",
  );
  git(["commit", "-am", "feat: move feature/x head"], fixture.root);
}

interface ChatListEntry {
  readonly id: string;
  readonly gitChangeScopes?: readonly GitChangeChatScope[];
}

export interface GitChangeChatScope {
  readonly relationshipId: string;
  readonly comparisonLabel: string;
  readonly pullRequestNumber?: number;
  readonly descriptionProposalId?: string;
}

// T25 — reads the chat's `gitChangeScopes` back through the REAL GET /api/chats?projectPath=...
// route (the same route the desktop client itself uses to hydrate the chat list) so a Disconnect
// click can be proven to have actually PATCHed the server, not merely repainted the pill locally.
export async function fetchGitChangeScopes(
  request: APIRequestContext,
  projectPath: string,
  chatId: string,
): Promise<readonly GitChangeChatScope[] | undefined> {
  const res = await request.get(`/api/chats?projectPath=${encodeURIComponent(projectPath)}`);
  if (!res.ok()) {
    throw new Error(`Chat list failed (${String(res.status())}): ${await res.text()}`);
  }
  const body = (await res.json()) as { readonly chats: readonly ChatListEntry[] };
  const chat = body.chats.find((entry) => entry.id === chatId);
  if (chat === undefined) throw new Error(`Chat ${chatId} missing from /api/chats list`);
  return chat.gitChangeScopes;
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
      selectedModel: GIT_CHANGE_CHAT_MODEL_ID,
    },
  });
  if (response.status() !== 201) {
    throw new Error(`Chat setup failed (${String(response.status())}): ${await response.text()}`);
  }
  const created = (await response.json()) as { chat: CreatedChat };
  return created.chat;
}

export async function authorizeGitHubForFixture(
  request: APIRequestContext,
  repositoryPath: string,
): Promise<void> {
  const query = new URLSearchParams({ repositoryPath });
  const current = await request.get(
    `/api/coding-workbench/github-authorization?${query.toString()}`,
  );
  if (!current.ok()) throw new Error(`Authorization read failed (${String(current.status())})`);
  const revision = ((await current.json()) as { readonly revision: number }).revision;
  const updated = await request.put("/api/coding-workbench/github-authorization", {
    headers: MUTATION_HEADERS,
    data: { repositoryPath, authorized: true, expectedRevision: revision },
  });
  if (!updated.ok()) throw new Error(`Authorization update failed (${String(updated.status())})`);
}

export interface GitChangeChatProviderState {
  readonly body: string;
  readonly updatedAt: string;
  readonly updates: number;
}

export function readGitChangeChatProviderState(): GitChangeChatProviderState {
  const path = process.env.KEIKO_GIT_CHANGE_CHAT_PROVIDER_STATE;
  if (path === undefined || path.length === 0) throw new Error("provider state path missing");
  return JSON.parse(readFileSync(path, "utf8")) as GitChangeChatProviderState;
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

export async function seedGovernedPrDescriptionWindow(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-3389-governed-pr-window",
          type: "governedPullRequest",
          x: 24,
          y: 24,
          w: 760,
          h: 900,
          z: 20,
          cfg: { projectPath: "issue-3389-governed-project", headBranchName: "feature/x" },
          max: false,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
  });
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

export interface PrDescriptionLifecycleObservation {
  readonly calls: { review: number; approve: number; apply: number };
  readonly finalBody: string;
}

function assertGovernedDescriptionTarget(request: Record<string, unknown>): void {
  if (
    request.schemaVersion !== "1" ||
    typeof request.projectId !== "string" ||
    request.projectId.length === 0 ||
    request.ownerAndRepo !== "keiko-e2e/git-change-chat-3400" ||
    request.prNumber !== 42
  ) {
    throw new Error("governed PR description request lost its exact target");
  }
}

async function installGovernedDescriptionReview(
  page: Page,
  calls: PrDescriptionLifecycleObservation["calls"],
  finalBody: string,
): Promise<void> {
  const previewStatus = prDescriptionApplicationStatusFixture("approval-required");
  await page.route("**/api/git-delivery/pr-description/preview", async (route) => {
    assertGovernedDescriptionTarget(route.request().postDataJSON() as Record<string, unknown>);
    calls.review += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: "preview",
        preview: {
          proposalId: "e2e-pr-card-proposal",
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          status: previewStatus,
          finalBody,
          managedRegion: "## Summary\n\nGenerated by Keiko from bounded fixture evidence.",
          concurrencyLimitation: "GitHub cannot lock the PR body during this update.",
        },
      }),
    });
  });
}

async function installGovernedDescriptionApproval(
  page: Page,
  calls: PrDescriptionLifecycleObservation["calls"],
): Promise<void> {
  await page.route("**/api/git-delivery/pr-description/approve", async (route) => {
    assertGovernedDescriptionTarget(route.request().postDataJSON() as Record<string, unknown>);
    calls.approve += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1",
        proposalId: "e2e-pr-card-proposal",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    });
  });
}

async function installGovernedDescriptionApply(
  page: Page,
  calls: PrDescriptionLifecycleObservation["calls"],
): Promise<void> {
  const appliedStatus = prDescriptionApplicationStatusFixture("applied");
  await page.route("**/api/git-delivery/pr-description/apply", async (route) => {
    assertGovernedDescriptionTarget(route.request().postDataJSON() as Record<string, unknown>);
    calls.apply += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ outcome: "observed", status: appliedStatus }),
    });
  });
}

export async function interceptGovernedPrDescriptionLifecycle(
  page: Page,
): Promise<PrDescriptionLifecycleObservation> {
  const calls = { review: 0, approve: 0, apply: 0 };
  const finalBody =
    "# Fixture pull request\n\nHuman context before the managed region.\n\n" +
    "<!-- keiko:managed:v1:start -->\n## Summary\n\nGenerated by Keiko from bounded fixture evidence.\n<!-- keiko:managed:v1:end -->\n\n" +
    "Human footer after the managed region.";
  await installGovernedDescriptionReview(page, calls, finalBody);
  await installGovernedDescriptionApproval(page, calls);
  await installGovernedDescriptionApply(page, calls);
  return { calls, finalBody };
}
