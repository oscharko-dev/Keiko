// Drives Jira's normal first-run forms with private synthetic credentials. No licensing shortcuts.
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { URL, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { loadSession, readPrivateFile, requireLicense } from "./lab-client.mjs";

function setupStage(stage) {
  console.log(JSON.stringify({ operation: "jira-lab-setup", stage }));
}

async function setupState(session) {
  try {
    const response = await globalThis.fetch(`${session.origin}/status`, {
      signal: globalThis.AbortSignal.timeout(5000),
    });
    if (response.status !== 200) return undefined;
    return (await response.json())?.state;
  } catch {
    return undefined;
  }
}

async function waitForFirstRun(session) {
  setupStage("waiting-for-first-run");
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const state = await setupState(session);
    if (state === "FIRST_RUN") return;
    if (state === "RUNNING") throw new TypeError("Laboratory setup is already complete");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 2000));
  }
  throw new TypeError("Laboratory first-run readiness timed out");
}

async function submitSetup(page, session, action, fields, expectedRedirect) {
  const csrf = await page.locator("input[name=atl_token]").first().inputValue();
  const response = await page.request.post(`${session.origin}/secure/${action}.jspa`, {
    form: { ...fields, atl_token: csrf },
    maxRedirects: 0,
    timeout: 30_000,
  });
  const location = new URL(response.headers().location ?? "", page.url());
  const expected =
    response.status() === 302 &&
    location.origin === session.origin &&
    location.pathname === `/secure/${expectedRedirect}.jspa`;
  console.log(
    JSON.stringify({
      operation: "jira-lab-setup-response",
      stage: action,
      status: response.status(),
      expectedRedirect: expected,
    }),
  );
  if (!expected)
    throw new TypeError("Unexpected laboratory setup result; reconcile before retrying");
  await page.goto(location.href, { waitUntil: "domcontentloaded", timeout: 180_000 });
}

export async function licenseSetup(page, session, license) {
  await submitSetup(
    page,
    session,
    "SetupLicense",
    { setupLicenseKey: license, next: "" },
    "SetupAdminAccount!default",
  );
}

export async function applicationProperties(page, session) {
  // FIRST_RUN can precede database initialization. Jira's normal entry point completes
  // that setup before presenting this form; direct legacy form URLs bypass that wait.
  await page.goto(`${session.origin}/`, {
    waitUntil: "domcontentloaded",
    timeout: 180_000,
  });
  const initial = new URL(page.url());
  if (
    initial.origin === session.origin &&
    initial.pathname === "/secure/SetupDatabase!default.jspa"
  ) {
    setupStage("database-readiness");
    await page.waitForURL(
      (url) =>
        url.origin === session.origin &&
        url.pathname === "/secure/SetupApplicationProperties!default.jspa",
      { timeout: 180_000 },
    );
  }
  const current = new URL(page.url());
  if (
    current.origin !== session.origin ||
    current.pathname !== "/secure/SetupApplicationProperties!default.jspa"
  )
    throw new TypeError("Unexpected laboratory setup phase; reconcile before retrying");
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

function loadTestLicense(path) {
  const value = readPrivateFile(path);
  if (value.length < 128 || value.length > 4096) throw new TypeError("Invalid test license file");
  return value;
}

async function main() {
  const [directory, licensePath] = process.argv.slice(2);
  if (!directory || !licensePath)
    throw new TypeError("Usage: setup.mjs <private-state-directory> <private-test-license-file>");
  const session = loadSession(directory);
  const license = loadTestLicense(licensePath);
  await waitForFirstRun(session);
  const pending = join(session.directory, "setup-pending");
  writeFileSync(pending, "Reconcile setup before retrying.\n", { mode: 0o600, flag: "wx" });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    setupStage("application-properties");
    await applicationProperties(page, session);
    setupStage("license");
    // Jira's fallback visible license form does not populate the wizard's setupLicenseKey.
    // Submit the existing wizard form endpoint with its CSRF token, as the normal JS UI does.
    await licenseSetup(page, session, license);
    setupStage("administrator");
    await administrator(page, session);
    setupStage("mail");
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    // Browser failures can embed filled values or CSRF-bearing URLs. Keep diagnostics body-free.
    console.error(
      JSON.stringify({
        operation: "jira-lab-setup",
        passed: false,
        errorType: error instanceof Error ? error.name : "unknown",
        sourceLine:
          error instanceof Error ? Number(error.stack?.match(/setup\.mjs:(\d+)/)?.[1] ?? 0) : 0,
      }),
    );
    console.error("jira-lab-setup: failed; reconcile the private pending marker before retrying");
    process.exitCode = 1;
  });
}
