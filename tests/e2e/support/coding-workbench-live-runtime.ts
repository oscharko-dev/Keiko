import { expect, type Page } from "@playwright/test";
import type {
  CodingWorkbenchCodexAuthStatus,
  CodingWorkbenchMode,
  CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import { createRuntimeFixture } from "./coding-workbench-live-runtime-fixtures.js";
import { installRuntimeRoutes } from "./coding-workbench-live-runtime-routes.js";

type FixtureAuthStatus = Extract<
  CodingWorkbenchCodexAuthStatus,
  "connected" | "missing" | "expired" | "redistribution-unapproved"
>;

export interface LiveRuntimeFixtureOptions {
  readonly initialState?: CodingWorkbenchRuntimeStateName;
  readonly deploymentCeiling?: CodingWorkbenchMode;
  readonly requestedMode?: CodingWorkbenchMode;
  readonly eventCount?: number;
  readonly authStatus?: FixtureAuthStatus;
  readonly runtimeAvailable?: boolean;
  readonly disconnectStreamOnce?: boolean;
}

export interface LiveRuntimeFixture {
  readonly open: () => Promise<void>;
  readonly requestMode: (label: RegExp) => Promise<void>;
  readonly workbench: ReturnType<Page["locator"]>;
  readonly autonomySettings: ReturnType<Page["locator"]>;
  readonly streamConnectionCount: () => number;
  readonly assertValidRequests: () => void;
}

export async function installLiveCodingWorkbenchRuntime(
  page: Page,
  options: LiveRuntimeFixtureOptions = {},
): Promise<LiveRuntimeFixture> {
  const fixture = createRuntimeFixture(options);
  await installRuntimeRoutes(page, options, fixture);
  return {
    open: async (): Promise<void> => {
      await page.goto("/");
      await page.getByRole("button", { name: "Coding Workbench" }).click();
      await expect(page.getByRole("heading", { name: "Coding Workbench" })).toBeVisible();
    },
    // #2644 moved the product-wide autonomy modes out of the Workbench into Settings → Security.
    // A request made here must still be answered by the server's clamp, never by the surface that
    // made it, so the tests drive the real control instead of projecting a mode locally.
    // The radio is server-controlled: it only flips once the policy channel confirms the request,
    // so this clicks and lets the caller assert the settled state instead of using check(), which
    // demands an immediate local state change and would mask a projected selection.
    requestMode: async (label: RegExp): Promise<void> => {
      await page.getByRole("button", { name: "Settings" }).click();
      const settings = page.getByRole("region", { name: /^Settings/u });
      await settings.getByRole("button", { name: "Security" }).click();
      await page.getByRole("radio", { name: label }).click();
      await expect(page.getByRole("radio", { name: label })).toBeChecked();
    },
    autonomySettings: page.locator('section[aria-labelledby="settings-autonomy-title"]'),
    workbench: page.locator('section[aria-label="Coding Workbench"][data-state]'),
    streamConnectionCount: () => fixture.streamConnections,
    assertValidRequests: (): void => {
      expect(fixture.validationErrors).toEqual([]);
    },
  };
}
