import { expect, test, type Page, type Route } from "@playwright/test";

// Issue #446 (Epic #443) — browser evidence that a bound Studio surface targets the ACTIVE task
// workspace in the REAL packaged app, and that an operator switch re-targets it atomically with no
// stale context surviving (AC1/AC2/AC5 + Stop Conditions SC1/SC3). This drives the REAL packaged CLI
// UI (page.goto("/")) and the REAL window registry: a Files window is seeded into the app's own
// keiko.workspace.v4 persistence key, so widgets/index.tsx resolves its root through the real
// resolveBoundRoot choke point. The task-workspace + files routes are intercepted for determinism (no
// real git worktree); the load-bearing proof is that the Files surface issues its /api/files request
// against the ACTIVE root (overriding the seeded cfg root) and re-issues it against the NEW active
// root after a switch — there is no surface left pointing at the previous workspace.

const PROJECT_ROOT = "/repo-446";
const ALPHA_ROOT = "/wt/alpha";
const BETA_ROOT = "/wt/beta";

interface Inst {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly managedWorktreePath: string;
}

function instance(i: Inst): Record<string, unknown> {
  return {
    schemaVersion: "1",
    workspaceId: i.workspaceId,
    taskId: i.taskId,
    repositoryId: "repo-446-id",
    repositoryRoot: PROJECT_ROOT,
    baseBranch: "main",
    taskBranch: `keiko/task/${i.taskId}`,
    managedWorktreePath: i.managedWorktreePath,
    gitdirIdentity: "gitdir-hash",
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: i.workspaceId,
  };
}

function binding(i: Inst): Record<string, unknown> {
  return {
    schemaVersion: "1",
    workspaceId: i.workspaceId,
    taskId: i.taskId,
    activeRoot: i.managedWorktreePath,
    boundSurfaces: [
      "chat",
      "files",
      "terminal",
      "browser",
      "editor",
      "runtime",
      "git-delivery",
      "review",
    ],
    gitDeliveryRoot: i.managedWorktreePath,
    editorProjectRoot: i.managedWorktreePath,
  };
}

function view(i: Inst): Record<string, unknown> {
  return {
    instance: instance(i),
    binding: binding(i),
    pointer: {
      workspaceId: i.workspaceId,
      setBy: "studio-operator",
      setAt: "2026-06-26T00:00:00.000Z",
      updatedAt: "2026-06-26T00:00:00.000Z",
    },
  };
}

const ALPHA: Inst = {
  workspaceId: "ws-alpha",
  taskId: "alpha-446",
  managedWorktreePath: ALPHA_ROOT,
};
const BETA: Inst = { workspaceId: "ws-beta", taskId: "beta-446", managedWorktreePath: BETA_ROOT };

async function fulfilJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

interface BindingServer {
  activeId: string;
  readonly filesRoots: string[];
}

// Wire the deterministic task-workspace + files surface. `state.activeId` flips on a switch POST so a
// subsequent GET /active reflects the new binding (the state machine reloads after every mutation).
async function installRoutes(page: Page, state: BindingServer): Promise<void> {
  // Seed a launched project so session.activeProject is set and the switcher inventory loads.
  await page.route("**/api/projects", async (route) => {
    await fulfilJson(route, {
      projects: [
        {
          path: PROJECT_ROOT,
          name: "repo-446",
          favorite: false,
          createdAt: 0,
          lastOpenedAt: 0,
          available: true,
        },
      ],
    });
  });

  await page.route("**/api/task-workspaces/active", async (route) => {
    if (route.request().method() === "GET") {
      await fulfilJson(route, {
        active: view(state.activeId === ALPHA.workspaceId ? ALPHA : BETA),
      });
      return;
    }
    // POST switch — flip the active pointer to the requested workspace, return its binding.
    const raw = route.request().postData();
    const body = raw === null ? {} : (JSON.parse(raw) as { workspaceId?: string });
    if (body.workspaceId === BETA.workspaceId) state.activeId = BETA.workspaceId;
    else if (body.workspaceId === ALPHA.workspaceId) state.activeId = ALPHA.workspaceId;
    const current = state.activeId === ALPHA.workspaceId ? ALPHA : BETA;
    await fulfilJson(route, { instance: instance(current), binding: binding(current) });
  });

  await page.route("**/api/task-workspaces?*", async (route) => {
    await fulfilJson(route, { instances: [instance(ALPHA), instance(BETA)] });
  });

  // Record the root every Files-surface request carries, and answer with an empty-but-valid listing.
  await page.route("**/api/files/**", async (route) => {
    const url = new URL(route.request().url());
    const root = url.searchParams.get("root");
    if (root !== null) state.filesRoots.push(root);
    await fulfilJson(route, {
      root: root ?? "",
      path: "",
      directories: [],
      files: [],
      entries: [],
    });
  });
}

async function seedFilesWindow(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-446-files",
          type: "files",
          x: 24,
          y: 24,
          w: 520,
          h: 640,
          z: 20,
          // A seeded cfg root the active binding must OVERRIDE — if the override regresses, the Files
          // surface would request this instead of the active root and the assertions fail.
          cfg: { root: "/seed/cfg/root" },
          max: true,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
  });
}

test("active task-workspace binding targets and re-targets the Files surface in the real app", async ({
  page,
}) => {
  const state: BindingServer = { activeId: ALPHA.workspaceId, filesRoots: [] };
  await installRoutes(page, state);
  await seedFilesWindow(page);
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();

  // AC5 — the switcher surfaces the active task identity in the top chrome.
  await expect(page.getByRole("button", { name: /alpha-446/u })).toBeVisible();

  // AC1 / SC1 — once the active binding resolves it OVERRIDES the seeded cfg root: the Files surface
  // settles on the active workspace root (a pre-binding request may use the cfg root briefly, but the
  // surface must not remain there).
  await expect.poll(() => state.filesRoots.at(-1)).toBe(ALPHA_ROOT);

  // Open the switcher and switch to the second workspace.
  await page.getByRole("button", { name: /alpha-446/u }).click();
  const list = page.getByRole("list", { name: /task workspaces/iu });
  await expect(list).toBeVisible();
  await list.getByRole("button", { name: "Switch" }).first().click();

  // AC2 / SC3 — after the atomic switch, the switcher shows the new task and the Files surface
  // re-issued its request against the NEW active root, leaving no surface on the previous workspace.
  await expect(page.getByRole("button", { name: /beta-446/u })).toBeVisible();
  await expect.poll(() => state.filesRoots.at(-1)).toBe(BETA_ROOT);
});
