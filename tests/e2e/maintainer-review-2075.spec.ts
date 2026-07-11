import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { expect, test, type Page, type Route } from "@playwright/test";
import { installAxe, runAxe, seriousOrCritical } from "./support/axe.js";

const evidence = resolve("docs/design-system/evidence/2075");
const assetRoot = resolve("packages/keiko-feedback-intake/assets");
const servedAssets = [
  "keiko-tokens.css",
  "keiko-semantic-tokens.css",
  "maintainer-ui.css",
  "maintainer-ui.html",
  "maintainer-ui.js",
  "maintainer-ui-copy.js",
  "maintainer-ui-dom.js",
] as const;
const axeProofs: { name: string; axeViolations: number }[] = [];
const externalRequests = new WeakMap<Page, string[]>();
const item = {
  itemId: "11111111-1111-4111-8111-111111111111",
  reviewGroupId: "review-group-1",
  groupCount: 2,
  payloadDigest: "a".repeat(64),
  state: "pending",
  version: 1,
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
  category: "defect",
  featureArea: "review",
  impact: "blocking",
};

const session = {
  permissions: ["feedback.review", "feedback.security", "feedback.legal-hold", "feedback.audit"],
  csrfToken: "csrf-token",
  absoluteExpiresAt: "2026-07-11T00:15:00.000Z",
  legalHoldPolicyKeys: ["retention-review"],
};

function reply(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function capture(page: Page, name: string): Promise<{ name: string; axeViolations: number }> {
  const applicationViolations = await page.evaluate(
    () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
  );
  expect(applicationViolations, `${name} application CSP`).toEqual([]);
  const violations = await runAxe(page, "#mq-main");
  await page.evaluate(() => {
    (window as unknown as { __cspViolations?: string[] }).__cspViolations = [];
  });
  expect(seriousOrCritical(violations), name).toEqual([]);
  await page.screenshot({ path: resolve(evidence, `${name}.png`), animations: "disabled" });
  const proof = { name, axeViolations: violations.length };
  axeProofs.push(proof);
  return proof;
}

async function assertSecurityBoundary(page: Page): Promise<void> {
  const result = await page.evaluate(() => ({
    violations: (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
    resources: performance.getEntriesByType("resource").map((entry) => entry.name),
  }));
  expect(result.violations).toEqual([]);
  const origin = new URL(page.url()).origin;
  expect(result.resources.every((url) => new URL(url).origin === origin)).toBe(true);
  expect(externalRequests.get(page) ?? []).toEqual([]);
}

async function submitDuplicate(page: Page, actions: string[]): Promise<void> {
  let releaseAction: (() => void) | undefined;
  const actionGate = new Promise<void>((resolve) => {
    releaseAction = resolve;
  });
  await page.route("**/v1/maintainer/reviews/*/actions", async (route) => {
    await actionGate;
    await reply(route, { itemId: item.itemId, state: "duplicate", version: 2 });
  });
  await page.getByLabel("Target item identifier").fill("22222222-2222-4222-8222-222222222222");
  await page.getByLabel("Target item identifier").press("Enter");
  await expect.poll(() => actions.length).toBe(1);
  await expect(
    page.locator(".mq-action input:disabled, .mq-action select:disabled"),
  ).not.toHaveCount(0);
  await capture(page, "17-submitting-busy");
  releaseAction?.();
  await expect(page.getByRole("heading", { name: "Review queue" })).toBeFocused();
  await expect(page.getByText("Action saved. The queue has been refreshed.")).toBeVisible();
  expect(JSON.parse(actions[0] ?? "{}") as { action?: string }).toMatchObject({
    action: "mark-duplicate",
  });
}

async function captureCanonicalModes(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await capture(page, "02-light-desktop-success");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.hc = "more";
  });
  await capture(page, "03-dark-high-contrast");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await capture(page, "04-light-high-contrast");
  await page.evaluate(() => {
    delete document.documentElement.dataset.hc;
    document.documentElement.dataset.theme = "dark";
  });
  await page.emulateMedia({ forcedColors: "active" });
  await capture(page, "05-forced-colors");
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
  await capture(page, "06-reduced-motion");
}

async function fixture(
  page: Page,
  mode: "normal" | "empty" | "unauthenticated" = "normal",
): Promise<void> {
  await page.route("**/v1/maintainer/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/auth/session")) {
      await reply(
        route,
        mode === "unauthenticated" ? { error: "request-rejected" } : session,
        mode === "unauthenticated" ? 401 : 200,
      );
      return;
    }
    if (url.pathname.endsWith("/reviews")) {
      await reply(route, { items: mode === "empty" ? [] : [item] });
      return;
    }
    if (url.pathname.endsWith(`/reviews/${item.itemId}`)) {
      await reply(route, {
        ...item,
        legalHold: { status: "none" },
        canonicalPayload:
          '<img src="https://tracker.invalid/x"><a href="https://tracker.invalid">x</a><script>window.__xss=1</script>',
      });
      return;
    }
    if (url.pathname.endsWith("/actions")) {
      await reply(route, { itemId: item.itemId, state: "archived", version: 2 });
      return;
    }
    if (url.pathname.endsWith("/audit")) {
      await reply(route, { events: [] });
      return;
    }
    await reply(route, { error: "not-found" }, 404);
  });
}

test.beforeAll(() => {
  mkdirSync(evidence, { recursive: true });
  for (const name of readdirSync(evidence)) {
    if (name.endsWith(".png") || name.endsWith("-proof.json") || name.endsWith("-results.json"))
      unlinkSync(resolve(evidence, name));
  }
});
test.afterAll(() => {
  const assets = Object.fromEntries(
    servedAssets.map((name) => {
      const bytes = readFileSync(resolve(assetRoot, name));
      return [
        name,
        {
          identityBytes: bytes.byteLength,
          gzipBytes: gzipSync(bytes).byteLength,
          brotliBytes: brotliCompressSync(bytes).byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ];
    }),
  );
  const screenshots = readdirSync(evidence)
    .filter((name) => name.endsWith(".png"))
    .sort();
  const declaredStates = screenshots.map((name) => name.replace(/\.png$/u, ""));
  const screenshotSha256 = Object.fromEntries(
    screenshots.map((name) => {
      const bytes = readFileSync(resolve(evidence, name));
      return [name, createHash("sha256").update(bytes).digest("hex")];
    }),
  );
  writeFileSync(
    resolve(evidence, "fidelity-results.json"),
    JSON.stringify(
      { issue: 2075, assets, screenshots, screenshotSha256, declaredStates, cspBypassed: false },
      null,
      2,
    ),
  );
  writeFileSync(
    resolve(evidence, "a11y-results.json"),
    JSON.stringify({ issue: 2075, modes: axeProofs, seriousOrCritical: 0 }, null, 2),
  );
});
test.beforeEach(async ({ context, page }) => {
  const external: string[] = [];
  externalRequests.set(page, external);
  page.on("request", (request) => {
    const target = new URL(request.url());
    if (target.origin !== "http://127.0.0.1:4215") external.push(request.url());
  });
  await installAxe(context);
  await page.addInitScript(() => {
    window.addEventListener("securitypolicyviolation", (event) => {
      const record = window as unknown as { __cspViolations?: string[] };
      record.__cspViolations ??= [];
      record.__cspViolations.push(event.violatedDirective);
    });
  });
});

test("maintainer queue uses production assets, inert payload rendering, keyboard actions, and axe", async ({
  page,
}) => {
  const actions: string[] = [];
  await fixture(page);
  page.on("request", (request) => {
    if (request.url().includes("/actions")) actions.push(request.postData() ?? "");
  });
  await page.goto("/maintainer/");
  await expect(page.getByRole("heading", { name: "Review queue" })).toBeVisible();
  await page.getByRole("button", { name: item.itemId }).click();
  await expect(page.getByRole("heading", { name: "Review detail" })).toBeFocused();
  const payload = page.locator("pre.mq-payload");
  await expect(payload).toContainText("<script>");
  await expect(page.locator("pre img, pre a, pre script")).toHaveCount(0);
  await capture(page, "01-dark-desktop-detail-xss");
  await page.getByRole("button", { name: "Mark duplicate" }).click();
  await expect(page.getByText("Validation error: complete the required fields.")).toBeVisible();
  await page.keyboard.press("Escape");
  await capture(page, "16-native-validation-error");
  await submitDuplicate(page, actions);
  await captureCanonicalModes(page);
  await assertSecurityBoundary(page);
});

test("localized, empty, unauthenticated, responsive, forced-colors, and reduced-motion states", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "forced-colors evidence requires Chromium");
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, "empty");
  await page.addInitScript(() => Object.defineProperty(navigator, "language", { value: "de-DE" }));
  await page.goto("/maintainer/");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.getByRole("heading", { name: "Prüfwarteschlange" })).toBeVisible();
  await expect(page.getByText("Keine Einträge entsprechen diesem Filter.")).toBeVisible();
  await capture(page, "07-de-mobile-empty-forced-colors");

  await fixture(page, "unauthenticated");
  await page.reload();
  await expect(page.getByRole("button", { name: "Anmelden" })).toBeVisible();
  await capture(page, "08-de-unauthenticated");
  await assertSecurityBoundary(page);
});

test("captures loading, filtered-empty, stale detail, and private-security item states", async ({
  page,
}) => {
  await fixture(page);
  let releaseList: (() => void) | undefined;
  const listGate = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  await page.route("**/v1/maintainer/reviews?*", async (route) => {
    await listGate;
    await reply(route, { items: [item] });
  });
  await page.goto("/maintainer/");
  await expect(page.getByText("Loading review queue")).toBeVisible();
  await capture(page, "18-loading");
  releaseList?.();
  await expect(page.getByRole("heading", { name: "Review queue" })).toBeVisible();

  await page.unroute("**/v1/maintainer/reviews?*");
  await page.route("**/v1/maintainer/reviews?*", (route) => {
    const filtered = new URL(route.request().url()).searchParams.has("state");
    return reply(route, { items: filtered ? [] : [item] });
  });
  await page.getByLabel("Filter by state").selectOption("archived");
  await expect(page.getByText("No items match this filter.")).toBeVisible();
  await capture(page, "19-filtered-empty");

  await page.getByLabel("Filter by state").selectOption("");
  await page.route(`**/v1/maintainer/reviews/${item.itemId}`, (route) =>
    reply(route, { error: "not-found" }, 404),
  );
  await page.getByRole("button", { name: item.itemId }).click();
  await expect(page.getByText("This item changed or is no longer available.")).toBeVisible();
  await capture(page, "20-stale-detail-not-found");

  await page.unroute("**/v1/maintainer/reviews?*");
  await page.route("**/v1/maintainer/reviews?*", (route) =>
    reply(route, { items: [{ ...item, state: "private-security" }] }),
  );
  await page.reload();
  await expect(page.locator(".mq-badge", { hasText: "private security" })).toBeVisible();
  await capture(page, "21-private-security-item");
  await assertSecurityBoundary(page);
});

test("error recovery and permission-gated review states remain explicit", async ({ page }) => {
  await fixture(page);
  await page.route("**/v1/maintainer/reviews?*", (route) =>
    reply(route, { error: "request-rejected" }, 403),
  );
  await page.goto("/maintainer/");
  await expect(page.getByText("You do not have permission for this action.")).toBeVisible();
  await capture(page, "09-forbidden-error");

  await page.unroute("**/v1/maintainer/reviews?*");
  await page.route("**/v1/maintainer/reviews?*", (route) =>
    reply(route, { error: "conflict" }, 409),
  );
  await page.reload();
  await expect(page.getByText("Conflict: another review changed this item.")).toBeVisible();
  await expect(page.locator(".mq-notice--warning .mq-notice-glyph")).toHaveText("△");
  await capture(page, "10-cas-conflict-warning");

  await page.unroute("**/v1/maintainer/reviews?*");
  await page.route("**/v1/maintainer/reviews?*", (route) =>
    reply(route, { error: "rate-limited" }, 429),
  );
  await page.reload();
  await expect(page.getByText("Too many requests. Wait briefly and try again.")).toBeVisible();
  await capture(page, "11-rate-limited");

  await page.unroute("**/v1/maintainer/reviews?*");
  await page.route("**/v1/maintainer/reviews?*", (route) =>
    reply(route, { error: "temporarily-unavailable" }, 503),
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await capture(page, "12-dependency-unavailable");
  await assertSecurityBoundary(page);
});

test("security, audit, and legal-hold controls follow the server permission and hold state", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/maintainer/");
  await expect(page.getByRole("button", { name: "View audit" })).toBeVisible();
  await page.getByRole("button", { name: "View audit" }).click();
  await expect(page.getByRole("heading", { name: "Audit" })).toBeFocused();
  await capture(page, "13-audit");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: "View audit" })).toBeFocused();

  await page.goto("/maintainer/");
  await page.route(`**/v1/maintainer/reviews/${item.itemId}`, (route) =>
    reply(route, {
      ...item,
      canonicalPayload: "synthetic payload",
      legalHold: {
        status: "active",
        policyKey: "retention-review",
        reviewAt: "2026-07-11T01:00:00.000Z",
        expiresAt: "2026-07-12T01:00:00.000Z",
      },
    }),
  );
  await page.getByRole("button", { name: item.itemId }).click();
  await expect(page.getByRole("button", { name: "Release legal hold" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Place legal hold" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Route private security" })).toBeVisible();
  await capture(page, "14-private-security-active-hold");

  await page.unroute(`**/v1/maintainer/reviews/${item.itemId}`);
  await page.route(`**/v1/maintainer/reviews/${item.itemId}`, (route) =>
    reply(route, {
      ...item,
      canonicalPayload: "synthetic payload",
      legalHold: {
        status: "expired",
        policyKey: "retention-review",
        reviewAt: "2026-07-10T01:00:00.000Z",
        expiresAt: "2026-07-10T02:00:00.000Z",
      },
    }),
  );
  await page.getByRole("button", { name: "Back to queue" }).click();
  await page.getByRole("button", { name: item.itemId }).click();
  await expect(page.getByRole("button", { name: "Expire legal hold" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Release legal hold" })).toHaveCount(0);
  await capture(page, "15-expired-hold-cleanup");
  await assertSecurityBoundary(page);
});
