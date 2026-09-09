import { expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { mintLauncherPairingAttestation } from "@oscharko-dev/keiko-server";

export async function openCodingIssueWorkbench(
  page: Page,
  input: {
    readonly repository: string;
    readonly windowId: string;
    readonly launcherSecret: string;
  },
): Promise<void> {
  const { repository, windowId, launcherSecret } = input;
  await page.addInitScript({ path: createRequire(import.meta.url).resolve("axe-core/axe.min.js") });
  await page.addInitScript(
    ({ root, windowId }) => {
      localStorage.setItem("keiko.theme", "dark");
      localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: windowId,
            type: "coding",
            x: 40,
            y: 48,
            w: 1120,
            h: 900,
            z: 10,
            zoom: 1,
            cfg: { repositoryPath: root },
            max: false,
          },
        ]),
      );
    },
    { root: repository, windowId: windowId },
  );
  const fragment = encodeCodingAppSessionPairingFragment(
    mintLauncherPairingAttestation({
      secret: launcherSecret,
      requestId: `commit-proof-${String(Date.now())}`,
      issuedAtMs: Date.now(),
    }),
  );
  await page.goto(`/${fragment}`);
  await expect.poll(() => page.url()).not.toContain("keiko-app-session");
  await expect(page.locator('section[aria-label="Coding Workbench"][data-state]')).toBeVisible();
}
export async function selectCodingIssueMode(page: Page, mode: CodingWorkbenchMode): Promise<void> {
  const names = {
    "governed-assist": /Ask for approval/u,
    "supervised-coding": /Supervised workspace/u,
    "autonomous-delivery": /Full access/u,
  };
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("region", { name: /^Settings/u })
    .getByRole("button", { name: "Security", exact: true })
    .click();
  await page.getByRole("radio", { name: names[mode] }).click();
  await expect(page.getByRole("radio", { name: names[mode] })).toBeChecked();
  await page.getByRole("button", { name: "Close Settings window", exact: true }).click();
}
