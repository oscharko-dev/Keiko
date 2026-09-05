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
            w: 1200,
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
