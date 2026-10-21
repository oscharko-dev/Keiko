import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLiveCodingWorkbenchRuntime } from "./support/coding-workbench-live-runtime.js";

const MODES = [
  {
    locale: "en",
    width: 1280,
    height: 720,
    connect: "Connect browser",
    choose: "Choose coding repository",
    attention: "Workbench is not paired.",
  },
  {
    locale: "de",
    width: 390,
    height: 860,
    connect: "Browser verbinden",
    choose: "Coding-Repository auswählen",
    attention: "Workbench nicht gekoppelt.",
  },
] as const;

async function installRepositoryCatalog(page: Page): Promise<void> {
  await page.route("**/api/projects**", (route) =>
    route.fulfill({
      json: {
        projects: [
          {
            path: "/e2e/fixture-repo",
            name: "fixture-repo",
            favorite: false,
            createdAt: 1,
            lastOpenedAt: 1,
            available: true,
            workspaceAvailable: true,
          },
        ],
      },
    }),
  );
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function holdRealPairingResponse(page: Page): Promise<{
  readonly held: Promise<void>;
  readonly release: () => void;
}> {
  const gate = deferred();
  const held = deferred();
  await page.route("**/api/coding-workbench/app-session/browser", async (route) => {
    const response = await route.fetch();
    held.resolve();
    await gate.promise;
    await route.fulfill({ response });
  });
  return { held: held.promise, release: gate.resolve };
}

for (const mode of MODES) {
  test(`active narrow transcript remains visible with expanded readiness ${mode.locale} @smoke`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 860 });
    await page.addInitScript((locale) => {
      localStorage.setItem("keiko.locale", locale);
    }, mode.locale);
    const fixture = await installLiveCodingWorkbenchRuntime(page, {
      initialState: "running",
      eventCount: 100,
      runtimeAvailable: false,
    });
    await fixture.open();
    await expect(fixture.workbench).toHaveAttribute("data-state", "running");
    const log = fixture.workbench.getByRole("log");
    // Settle the fixture's channels before measuring keyboard scrolling of the bounded pane.
    await expect(fixture.workbench.getByTestId("coding-workbench-questions")).toHaveAttribute(
      "data-question-state",
      "unpaired",
    );
    await expect(log.locator("[data-activity-state]")).toHaveAttribute(
      "data-activity-state",
      "unavailable",
    );
    await expect(log.getByRole("note")).toHaveCount(1);
    await expect(
      log.getByText(mode.locale === "en" ? "Changes" : "Änderungen", { exact: true }),
    ).toBeAttached();
    const details = fixture.workbench.locator("details").filter({
      has: page.getByTestId("coding-runtime-readiness"),
    });
    await details.locator("summary").click();
    await expect(details).toHaveAttribute("open", "");
    await expect(log).toBeInViewport({ ratio: 1 });
    expect((await log.boundingBox())?.height).toBeGreaterThanOrEqual(48);
    await page.keyboard.press("Tab");
    await expect(log).toBeFocused();
    // Native focus can scroll nested panes; observe their visibility before navigation.
    await expect(log).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("Home");
    await expect.poll(() => log.evaluate((node) => node.scrollTop)).toBe(0);
    await page.keyboard.press("End");
    await expect.poll(() => log.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await expect(log).toBeInViewport({ ratio: 1 });
    expect(await log.evaluate((node) => node.parentElement?.scrollTop)).toBe(0);
    const evidencePath = info.outputPath("body-free-transcript-layout.json");
    await writeFile(
      evidencePath,
      JSON.stringify({
        frame: await fixture.workbench.boundingBox(),
        log: await log.boundingBox(),
        status: await fixture.workbench.getByTestId("coding-runtime-status").boundingBox(),
      }),
    );
    await info.attach("body-free-transcript-layout", {
      path: evidencePath,
      contentType: "application/json",
    });
    fixture.assertValidRequests();
  });
  for (const timing of ["during-press", "settled-control"] as const) {
    test(`repository gesture survives real readiness reflow ${mode.locale} ${timing} @smoke`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width: mode.width, height: mode.height });
      await page.addInitScript((locale) => {
        localStorage.setItem("keiko.locale", locale);
      }, mode.locale);
      await installRepositoryCatalog(page);
      await page.goto("/");
      await expect(page.getByRole("button", { name: mode.connect, exact: true })).toBeVisible();
      const pairing = await holdRealPairingResponse(page);
      try {
        await page.getByRole("button", { name: "Coding Workbench", exact: true }).click();
        const region = page.getByRole("region", { name: "Coding Workbench", exact: true });
        const trigger = region.getByRole("combobox", { name: mode.choose });
        await expect(trigger).toBeVisible();
        await expect(trigger).toBeEnabled();
        await pairing.held;
        const announcement = region.getByTestId("coding-runtime-announcement");
        if (timing === "settled-control") {
          pairing.release();
          await expect(announcement).toContainText(mode.attention);
        }
        const before = await trigger.boundingBox();
        if (before === null) throw new Error("Repository trigger has no geometry");
        await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
        await page.mouse.down();
        if (timing === "during-press") {
          pairing.release();
          await expect(announcement).toContainText(mode.attention);
        }
        const after = await trigger.boundingBox();
        await page.mouse.up();
        const frame = await region.boundingBox();
        const evidencePath = info.outputPath("body-free-readiness-layout.json");
        await writeFile(
          evidencePath,
          JSON.stringify({
            before,
            after,
            frame,
            status: await region.getByTestId("coding-runtime-status").boundingBox(),
          }),
        );
        await info.attach("body-free-readiness-layout", {
          path: evidencePath,
          contentType: "application/json",
        });
        if (mode.locale === "de") {
          expect(frame?.width).toBeLessThanOrEqual(mode.width);
          expect(frame?.x).toBeGreaterThanOrEqual(0);
        }
        expect(after).toEqual(before);
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        const menu = page.getByRole("listbox", { name: mode.choose });
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("option", { name: "fixture-repo" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
      } finally {
        pairing.release();
      }
    });
  }
}
