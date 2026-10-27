// Drives Jira's normal first-run forms with private synthetic credentials. No licensing shortcuts.
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";
import { chromium } from "playwright";
import { loadSession, readPrivateFile, requireLicense } from "./lab-client.mjs";

async function submitSetup(page, session, action, fields, expectedRedirect) {
  const csrf = await page.locator("input[name=atl_token]").first().inputValue();
  const response = await page.request.post(`${session.origin}/secure/${action}.jspa`, {
    form: { ...fields, atl_token: csrf },
    maxRedirects: 0,
    timeout: 30_000,
  });
  const location = new URL(response.headers().location ?? "", page.url());
  if (response.status() !== 302 || location.pathname !== `/secure/${expectedRedirect}.jspa`)
    throw new TypeError("Unexpected laboratory setup result; reconcile before retrying");
  await page.goto(location.href, { waitUntil: "domcontentloaded" });
}

async function applicationProperties(page, session) {
  await page.goto(`${session.origin}/secure/SetupApplicationProperties!default.jspa`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("input[name=title]").fill("Keiko synthetic laboratory");
  await page.locator("#jira-setupwizard-mode-private").check();
  // Administration stays on its loopback origin; product qualification separately uses trusted HTTPS.
  await page.locator("input[name=baseURL]").fill(session.origin);
  await page.locator("#jira-setupwizard-submit").click();
  await page.locator("#licenseKey").first().waitFor();
}

async function administrator(page, session) {
  const password = readPrivateFile(join(session.directory, "secrets", "admin-password"));
  for (const [name, value] of Object.entries({
    fullname: "Keiko laboratory administrator",
    email: "keiko-admin@example.invalid",
    username: "keiko-admin",
    password,
    confirm: password,
  }))
    await page.locator(`input[name=${name}]`).fill(value);
  await page.locator("#jira-setupwizard-submit").click();
  await page.locator("#jira-setupwizard-email-notifications-disabled").waitFor();
}

async function main() {
  const [directory, licensePath] = process.argv.slice(2);
  if (!directory || !licensePath)
    throw new TypeError("Usage: setup.mjs <private-state-directory> <private-test-license-file>");
  const session = loadSession(directory);
  const license = readPrivateFile(licensePath);
  if (license.length < 128 || license.length > 4096)
    throw new TypeError("Invalid test license file");
  const pending = join(session.directory, "setup-pending");
  writeFileSync(pending, "Reconcile setup before retrying.\n", { mode: 0o600, flag: "wx" });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    await applicationProperties(page, session);
    // Jira's fallback visible license form does not populate the wizard's setupLicenseKey.
    // Submit the existing wizard form endpoint with its CSRF token, as the normal JS UI does.
    await submitSetup(
      page,
      session,
      "SetupLicense",
      { setupLicenseKey: license },
      "SetupAdminAccount!default",
    );
    await administrator(page, session);
    await submitSetup(
      page,
      session,
      "SetupMailNotifications",
      { noemail: "true", finish: "Finish" },
      "WelcomeToJIRA",
    );
    await requireLicense(session);
    writeFileSync(
      join(session.directory, "setup-completed.json"),
      JSON.stringify({
        schemaVersion: 1,
        completedAt: new Date().toISOString(),
        syntheticOnly: true,
      }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    unlinkSync(pending);
    console.log(JSON.stringify({ operation: "jira-lab-setup", passed: true }));
  } finally {
    await browser.close();
  }
}

await main().catch(() => {
  // Browser failures can embed filled values or CSRF-bearing URLs. Keep diagnostics body-free.
  console.error("jira-lab-setup: failed; reconcile the private pending marker before retrying");
  process.exitCode = 1;
});
