import { test as base } from "@playwright/test";
import type { UpdatePreflightReport } from "@oscharko-dev/keiko-contracts";

type StartupUpdate = "current" | "available";

function startupReport(state: StartupUpdate): UpdatePreflightReport {
  const available = state === "available";
  return {
    schemaVersion: 1,
    checkedAt: "2026-06-30T12:00:00.000Z",
    currentVersion: "1.2.0",
    ...(available ? { targetVersion: "1.2.1" } : {}),
    updateAvailable: available,
    status: available ? "update-available" : "current",
    availabilityState: available ? "update-available" : "current",
    severity: available ? "normal" : "none",
    registryStatus: "ok",
    releaseMetadataStatus: "live",
    userActionRequired: available,
    affectedStateStores: [],
    blockers: [],
    manualUpdateRequired: available,
    oneClickEligible: false,
    warnings: [],
  };
}

// Ordinary smoke journeys must not depend on the release published when they run. Context
// routing also covers secondary pages; a test's own routes can still override this fixture.
// Dedicated updater and real-BFF outage suites retain their own unmodified test entry point.
export const test = base.extend<{ startupUpdate: StartupUpdate }>({
  startupUpdate: ["current", { option: true }],
  context: async ({ context, startupUpdate }, use): Promise<void> => {
    await context.route("**/api/update/preflight", async (route): Promise<void> => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({ json: startupReport(startupUpdate) });
    });
    await use(context);
  },
});
