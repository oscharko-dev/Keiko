// Supported Jira UI administration for fixture configuration absent from its public REST API.
import { chromium, expect } from "@playwright/test";
import { join } from "node:path";
import { readPrivateFile } from "./lab-client.mjs";

export async function withLabAdmin(session, run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(30_000);
    const password = readPrivateFile(join(session.directory, "secrets", "admin-password"));
    await page.goto(`${session.origin}/secure/admin/ViewFieldLayouts.jspa`, {
      waitUntil: "domcontentloaded",
    });
    // The authentication plugin's login page and the classic one that legacy mode serves (the
    // laboratory compose file selects it) use different field identifiers.
    await page.locator("#username-field, #login-form-username").fill("keiko-admin");
    await page.locator("#password-field, #login-form-password").fill(password);
    await page.locator("#login-form-submit, button:text-is('Log in')").first().click();
    await page.waitForURL((url) => url.pathname !== "/login.jsp");
    await page.waitForLoadState("domcontentloaded");
    if (await page.locator("input[name=webSudoPassword]").count()) {
      await page.locator("input[name=webSudoPassword]").fill(password);
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await page
        .getByRole("heading", { name: "Administrator Access", exact: true })
        .waitFor({ state: "hidden" });
    }
    return await run(page);
  } catch {
    // Playwright error details may contain filled values or CSRF-bearing URLs.
    throw new TypeError("Synthetic Jira administration failed");
  } finally {
    await browser.close();
  }
}

export async function setFixtureFieldRequirement(page, session, required) {
  await page.goto(`${session.origin}/secure/admin/ViewFieldLayouts.jspa`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("link", { name: "Configure", exact: true }).click();
  await page.getByPlaceholder("Find fields by name or screen").fill("Keiko required text");
  const input = page
    .locator("tr")
    .filter({ hasText: "Keiko required text" })
    .locator("input[name=required]");
  await input.waitFor();
  if ((await input.isChecked()) !== required) {
    // Jira's decorative icon covers the native input. Use its supported keyboard interaction.
    await input.focus();
    await input.press("Space");
  }
  await expect(input).toBeChecked({ checked: required });
  console.log(JSON.stringify({ operation: "jira-lab-admin", case: "required-field", required }));
}

export async function configureFixtureTransition(page, session) {
  await page.goto(`${session.origin}/secure/admin/workflows/ListWorkflows.jspa`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .locator("tr")
    .filter({ hasText: "KEIKO: Simple Issue Tracking Workflow" })
    .getByRole("link", { name: "Edit", exact: true })
    .click();
  await page.waitForLoadState("domcontentloaded");
  const text = page.getByRole("link", { name: "Text", exact: true });
  if (await text.count()) await text.click();
  await page.getByRole("link", { name: "Done", exact: true }).first().click();
  await page.getByRole("link", { name: "Edit", exact: true }).first().click();
  await page.locator("select[name=view]").selectOption({ label: "Resolve Issue Screen" });
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await page.getByRole("heading", { name: "Transition: Done", exact: true }).waitFor();
  const publish = page.getByRole("link", { name: "Publish", exact: true });
  // Fresh Jira installations show onboarding overlays above this link; use its keyboard action.
  await publish.focus();
  await publish.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.locator("label[for=publish-workflow-false]").click();
  await dialog.locator("#publish-workflow-submit").click();
  await dialog.waitFor({ state: "hidden" });
  console.log(
    JSON.stringify({ operation: "jira-lab-admin", case: "transition-screen", configured: true }),
  );
}
