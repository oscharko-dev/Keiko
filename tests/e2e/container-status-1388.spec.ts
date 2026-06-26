import { expect, test, type Page } from "@playwright/test";

// Issue #1388 (ADR-0070) — browser smoke for the container status surface. Drives the real Studio
// shell in Chromium; the /api/containers/* BFF is mocked at the network boundary (same approach as
// command-runner-1387.spec.ts) so the test is deterministic and never spawns a real container. This
// asserts AC1: with NO engine on the CI host, the container surface shows the structured unavailable
// state AND the rest of Keiko stays fully usable (the surface never blocks, never error-boundaries).

const TAG = "@container-status-1388";

async function seedContainerWindow(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "issue-1388-containers",
          type: "containerStatus",
          x: 64,
          y: 56,
          w: 620,
          h: 480,
          z: 10,
          cfg: {},
          max: false,
        },
        // A sibling Tasks window proves the rest of Keiko stays usable next to the unavailable card.
        {
          id: "issue-1388-tasks",
          type: "commands",
          x: 720,
          y: 56,
          w: 480,
          h: 360,
          z: 9,
          cfg: {},
          max: false,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
  });
}

// The CI host has no container engine: the capability route reports both engines unavailable.
async function routeUnavailableContainerBff(page: Page): Promise<void> {
  await page.route("**/api/containers/capability**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1",
        generatedAtMs: 1,
        deadlineMs: 4000,
        anyAvailable: false,
        engines: [
          {
            engine: "docker",
            state: "missing",
            unavailableReason: "executable-not-found",
            remediationHint:
              "Install Docker Desktop or the docker CLI to enable container diagnostics.",
          },
          {
            engine: "podman",
            state: "missing",
            unavailableReason: "executable-not-found",
            remediationHint: "Install podman to enable container diagnostics.",
          },
        ],
      }),
    });
  });

  // With no engine the catalog route 503s by contract; the UI must never call it, but route it
  // defensively so a regression that does call it fails loudly rather than hanging.
  await page.route("**/api/containers/catalog**", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "CONTAINER_ENGINE_UNAVAILABLE",
          message: "No container engine is available.",
        },
      }),
    });
  });
}

test(`Container surface degrades gracefully with no engine ${TAG}`, async ({ page }) => {
  await seedContainerWindow(page);
  await routeUnavailableContainerBff(page);

  await page.goto("/");

  const containerWindow = page.getByRole("region", { name: /^Containers/u });
  await expect(containerWindow).toBeVisible();

  // AC1: the structured unavailable state is shown (state label + remediation hint), as a status.
  await expect(containerWindow.getByText(/not installed/i).first()).toBeVisible();
  await expect(
    containerWindow.getByText(/install docker desktop or the docker cli/i),
  ).toBeVisible();

  // AC2: no run control is offered when no engine is available.
  await expect(containerWindow.getByRole("button", { name: /run diagnostic/i })).toHaveCount(0);

  // The rest of Keiko stays fully usable: the sibling Tasks window renders and is interactive.
  const tasksWindow = page.getByRole("region", { name: /^Tasks/u });
  await expect(tasksWindow).toBeVisible();
  await expect(tasksWindow.getByLabel(/project path/i)).toBeEditable();
});
