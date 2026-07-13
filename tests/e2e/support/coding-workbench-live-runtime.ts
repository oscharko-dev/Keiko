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
  "connected" | "missing" | "expired"
>;

export interface LiveRuntimeFixtureOptions {
  readonly initialState?: CodingWorkbenchRuntimeStateName;
  readonly deploymentCeiling?: CodingWorkbenchMode;
  readonly eventCount?: number;
  readonly authStatus?: FixtureAuthStatus;
  readonly runtimeAvailable?: boolean;
  readonly disconnectStreamOnce?: boolean;
}

export interface LiveRuntimeFixture {
  readonly open: () => Promise<void>;
  readonly workbench: ReturnType<Page["locator"]>;
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
    workbench: page.locator('section[aria-label="Coding Workbench"][data-state]'),
    streamConnectionCount: () => fixture.streamConnections,
    assertValidRequests: (): void => {
      expect(fixture.validationErrors).toEqual([]);
    },
  };
}
