import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { installAxe, runAxe, seriousOrCritical } from "./support/axe.js";
import { captureDeterministically } from "./support/deterministic-screenshot.js";

const evidence = resolve("docs/design-system/evidence/2076");
const assets = resolve("packages/keiko-feedback-intake/assets");
const served = [
  "keiko-tokens.css",
  "keiko-semantic-tokens.css",
  "maintainer-ui.css",
  "maintainer-ui.html",
  "maintainer-ui.js",
  "maintainer-ui-copy.js",
  "maintainer-ui-detail.js",
  "maintainer-ui-dom.js",
  "maintainer-ui-publication.js",
] as const;
const item = {
  itemId: "11111111-1111-4111-8111-111111111111",
  reviewGroupId: "group-1",
  groupCount: 1,
  payloadDigest: "a".repeat(64),
  state: "pending",
  version: 7,
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:00.000Z",
  category: "defect",
  featureArea: "review",
  impact: "blocking",
};
const catalog = [
  {
    targetKey: "one-target",
    owner: "keiko",
    repository: "public-feedback",
    labels: ["feedback", "reviewed"],
    targetPolicyVersion: "target-v1",
    projectionPolicyVersion: "github-issue-v1",
  },
];
const prepared = {
  status: "prepared",
  itemId: item.itemId,
  preparationId: "22222222-2222-4222-8222-222222222222",
  recordVersion: 8,
  projectionDigest: "b".repeat(64),
  targetPolicyDigest: "c".repeat(64),
  reconciliationMarker: "never-rendered",
  title: '<img src="https://tracker.invalid/title"> exact <b>title</b>',
  body: '<script>window.__publicationXss = true</script><a href="https://tracker.invalid">exact body</a>',
  targetDisplay: {
    owner: "keiko",
    repository: "public-feedback",
    labels: ["feedback", "reviewed"],
    labelPolicyVersion: "labels-v1",
    targetPolicyVersion: "target-v1",
  },
  expiresAt: "2026-07-12T01:00:00.000Z",
  replayed: false,
};
const proofs: { name: string; axeViolations: number }[] = [];

interface RecordedRequest {
  readonly path: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

interface FixtureState {
  latest: Record<string, unknown>;
}

function reply(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    permissions: ["feedback.review", "feedback.publish"],
    csrfToken: "csrf-token",
    absoluteExpiresAt: "2026-07-12T00:15:00.000Z",
    publicationTargets: catalog,
    ...overrides,
  };
}

async function capture(page: Page, name: string): Promise<void> {
  const violations = await runAxe(page, "#mq-main");
  expect(seriousOrCritical(violations), name).toEqual([]);
  proofs.push({ name, axeViolations: violations.length });
  await captureDeterministically(page, resolve(evidence, `${name}.png`), name);
}

async function installFixture(
  page: Page,
  options: {
    readonly session?: Record<string, unknown>;
    readonly status?: Record<string, unknown>;
  } = {},
): Promise<{ requests: { path: string; body: unknown; headers: Record<string, string> }[] }> {
  const requests: { path: string; body: unknown; headers: Record<string, string> }[] = [];
  const state = { latest: options.status ?? { itemId: item.itemId, status: "none" } };
  await page.route("**/v1/maintainer/**", (route) =>
    fixtureRoute(route, options.session ?? session(), state, requests),
  );
  return { requests };
}

async function fixtureRoute(
  route: Route,
  sessionValue: Record<string, unknown>,
  state: FixtureState,
  requests: RecordedRequest[],
): Promise<void> {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith("/auth/session")) return reply(route, sessionValue);
  if (url.pathname.endsWith("/reviews")) return reply(route, { items: [item] });
  if (url.pathname.endsWith(`/reviews/${item.itemId}`))
    return reply(route, {
      ...item,
      legalHold: { status: "none" },
      canonicalPayload: "private report",
    });
  if (await publicationRoute(route, url, state, requests)) return;
  return reply(route, { error: "not-found" }, 404);
}

function recordRequest(route: Route, url: URL): RecordedRequest {
  return {
    path: url.pathname,
    body: route.request().postDataJSON(),
    headers: route.request().headers(),
  };
}

async function publicationRoute(
  route: Route,
  url: URL,
  state: FixtureState,
  requests: RecordedRequest[],
): Promise<boolean> {
  if (url.pathname.endsWith("/publication/status")) {
    await reply(route, state.latest);
    return true;
  }
  if (url.pathname.endsWith("/publication/preview")) {
    await reply(route, prepared);
    return true;
  }
  if (!url.pathname.includes("/publication/")) return false;
  requests.push(recordRequest(route, url));
  await publicationMutation(route, url.pathname, state);
  return true;
}

async function publicationMutation(route: Route, path: string, state: FixtureState): Promise<void> {
  if (path.endsWith("/publication/prepare")) {
    state.latest = { ...prepared, status: "prepared" };
    await reply(route, prepared);
    return;
  }
  if (path.endsWith("/publication/approve")) {
    state.latest = {
      itemId: item.itemId,
      status: "succeeded",
      preparationId: prepared.preparationId,
      linkage: { issueNumber: 42, issueUrl: "https://github.com/keiko/public-feedback/issues/42" },
    };
    await reply(route, {
      status: "approved",
      itemId: item.itemId,
      preparationId: prepared.preparationId,
      recordVersion: 9,
      outboxId: "never-rendered",
      replayed: false,
    });
    return;
  }
  state.latest = {
    itemId: item.itemId,
    status: "cancelled-private",
    preparationId: prepared.preparationId,
  };
  await reply(route, {
    status: "cancelled-private",
    itemId: item.itemId,
    preparationId: prepared.preparationId,
    recordVersion: 9,
    replayed: false,
  });
}

function objectKeys(value: unknown): string[] {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.keys(value)
    : [];
}

function expectPreparedRequest(request: RecordedRequest | undefined, targetKey: string): void {
  expect(request).toMatchObject({
    path: `/v1/maintainer/reviews/${item.itemId}/publication/prepare`,
  });
  expect(request?.body).toMatchObject({
    action: "prepare-publication",
    expectedVersion: 7,
    targetKey,
  });
  expect(objectKeys(request?.body).sort()).toEqual([
    "action",
    "expectedVersion",
    "idempotencyKey",
    "targetKey",
  ]);
  expect(request?.headers["keiko-feedback-csrf"]).toBe("csrf-token");
}

function expectApprovedRequest(request: RecordedRequest | undefined): void {
  expect(request?.body).toMatchObject({
    action: "approve-publication",
    preparationId: prepared.preparationId,
    expectedProjectionDigest: prepared.projectionDigest,
    expectedTargetPolicyDigest: prepared.targetPolicyDigest,
  });
  expect(objectKeys(request?.body)).toHaveLength(5);
}

async function expectNoContentPersistenceOrExternalRequests(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        local: Object.keys(localStorage),
        session: Object.keys(sessionStorage),
      })),
    )
    .toEqual({ local: [], session: [] });
  const resources = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => entry.name),
  );
  expect(resources.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
}

async function captureCancellationModes(page: Page): Promise<void> {
  await capture(page, "04-dark-cancelled-private");
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "05-mobile-forced-colors-reduced-motion");
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "no-preference" });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.hc = "more";
  });
  await capture(page, "06-light-high-contrast");
}

async function expectMinimumTarget(locator: Locator): Promise<void> {
  const size = await locator.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height };
  });
  expect(size.width).toBeGreaterThanOrEqual(44);
  expect(size.height).toBeGreaterThanOrEqual(44);
}

async function expectSessionRecovery(page: Page): Promise<void> {
  const signIn = page.getByRole("button", { name: "Sign in" });
  await expect(signIn).toBeVisible();
  await expect(signIn).toBeFocused();
  await expect(page.getByRole("button", { name: "Refresh publication state" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Public issue publication" })).toHaveCount(0);
}

async function triggerPublicationAction(page: Page, action: string): Promise<void> {
  if (action === "cancel-route-private") {
    await page.getByLabel(/I understand this cancels/u).check();
    await page.getByRole("button", { name: "Cancel and route private" }).click();
    return;
  }
  const name = action === "approve" ? "Approve public publication" : "Prepare public issue";
  await page.getByRole("button", { name }).click();
}

async function open(page: Page): Promise<void> {
  await page.goto("/maintainer/");
  await page.getByRole("button", { name: item.itemId }).click();
  await expect(page.getByRole("heading", { name: "Public issue publication" })).toBeVisible();
}

test.beforeAll(() => {
  mkdirSync(evidence, { recursive: true });
  for (const name of readdirSync(evidence)) {
    if (name.endsWith(".png") || name.endsWith(".json")) unlinkSync(resolve(evidence, name));
  }
});

test.afterAll(() => {
  const screenshots = readdirSync(evidence)
    .filter((name) => name.endsWith(".png"))
    .sort();
  const assetProof = Object.fromEntries(
    served.map((name) => {
      const bytes = readFileSync(resolve(assets, name));
      return [
        name,
        {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          identityBytes: bytes.length,
          gzipBytes: gzipSync(bytes).length,
          brotliBytes: brotliCompressSync(bytes).length,
        },
      ];
    }),
  );
  writeFileSync(
    resolve(evidence, "fidelity-results.json"),
    JSON.stringify({ issue: 2076, assets: assetProof, screenshots, cspBypassed: false }, null, 2),
  );
  writeFileSync(
    resolve(evidence, "a11y-results.json"),
    JSON.stringify({ issue: 2076, modes: proofs, seriousOrCritical: 0 }, null, 2),
  );
});

test.beforeEach(async ({ context }) => installAxe(context));

test("prepare, exact inert preview, approve, and public link use only the governed contract", async ({
  page,
}) => {
  const ledger = await installFixture(page);
  await open(page);
  await expect(page.getByRole("heading", { name: "Review detail" })).toBeFocused();
  await expect(page.getByText("Checking publication state…")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Prepare public issue" })).toBeVisible();
  await capture(page, "01-dark-desktop-prepare");
  await page.getByRole("button", { name: "Prepare public issue" }).press("Enter");
  await expect(page.getByRole("heading", { name: "Prepared public issue preview" })).toBeVisible();
  await expect(
    page.locator(
      ".mq-publication-preview pre img, .mq-publication-preview pre a, .mq-publication-preview pre script",
    ),
  ).toHaveCount(0);
  await expect(page.locator(".mq-publication-preview pre").first()).toHaveText(prepared.title);
  await expect(page.locator(".mq-publication-preview pre").nth(1)).toHaveText(prepared.body);
  expectPreparedRequest(ledger.requests[0], "one-target");
  await capture(page, "02-dark-preview-inert");
  await page.getByRole("button", { name: "Approve public publication" }).click();
  await expect(page.getByRole("link", { name: "Open public GitHub issue" })).toBeVisible();
  const link = page.getByRole("link", { name: "Open public GitHub issue" });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expectApprovedRequest(ledger.requests[1]);
  await capture(page, "03-light-succeeded");
  const refresh = page.getByRole("button", { name: "Refresh publication state" });
  await refresh.click();
  await expect(refresh).toBeFocused();
  await expectNoContentPersistenceOrExternalRequests(page);
});

const mutationFailures = [
  { action: "prepare", status: 403, message: "You do not have permission to publish this report." },
  {
    action: "approve",
    status: 409,
    message: "Publication changed elsewhere. Refresh before trying again.",
  },
  {
    action: "cancel-route-private",
    status: 429,
    message: "Publication is temporarily rate limited. Try again later.",
  },
  {
    action: "prepare",
    status: 503,
    message: "Publication state is temporarily unavailable. Try again later.",
  },
] as const;

for (const failure of mutationFailures) {
  test(`maps direct ${failure.action} HTTP ${String(failure.status)} without disclosure`, async ({
    page,
  }) => {
    const status = failure.action === "prepare" ? undefined : { ...prepared, status: "prepared" };
    await installFixture(page, status === undefined ? {} : { status });
    await page.route(`**/publication/${failure.action}`, (route) =>
      reply(route, {}, failure.status),
    );
    await open(page);
    if (failure.action === "cancel-route-private") {
      await page.getByLabel(/I understand this cancels/u).check();
      await page.getByRole("button", { name: "Cancel and route private" }).click();
    } else {
      const name =
        failure.action === "approve" ? "Approve public publication" : "Prepare public issue";
      await page.getByRole("button", { name }).click();
    }
    const result = page.locator("#mq-publication-result");
    await expect(result).toContainText(failure.message);
    await expect(result).toBeFocused();
  });
}

test("status HTTP 401 clears detail state and uses expired-session recovery once", async ({
  page,
}) => {
  await installFixture(page);
  let calls = 0;
  await page.route("**/publication/status", (route) => {
    calls += 1;
    return reply(route, {}, 401);
  });
  await page.goto("/maintainer/");
  await page.getByRole("button", { name: item.itemId }).click();
  await expectSessionRecovery(page);
  expect(calls).toBe(1);
});

for (const action of ["prepare", "approve", "cancel-route-private"] as const) {
  test(`${action} HTTP 401 uses expired-session sign-in recovery without retry`, async ({
    page,
  }) => {
    const status = action === "prepare" ? undefined : { ...prepared, status: "prepared" };
    await installFixture(page, status === undefined ? {} : { status });
    let calls = 0;
    await page.route(`**/publication/${action}`, (route) => {
      calls += 1;
      return reply(route, {}, 401);
    });
    await open(page);
    await triggerPublicationAction(page, action);
    await expectSessionRecovery(page);
    expect(calls).toBe(1);
  });
}

test("catalog and permission gates suppress all publication controls and network calls", async ({
  page,
}) => {
  const ledger = await installFixture(page, {
    session: session({ permissions: ["feedback.review"] }),
  });
  await page.goto("/maintainer/");
  await page.getByRole("button", { name: item.itemId }).click();
  await expect(page.getByRole("heading", { name: "Public issue publication" })).toHaveCount(0);
  expect(ledger.requests).toEqual([]);
  let statusCalls = 0;
  await page.unroute("**/v1/maintainer/**");
  await installFixture(page, { session: session({ publicationTargets: undefined }) });
  await page.route("**/publication/status", (route) => {
    statusCalls += 1;
    return reply(route, {});
  });
  await page.reload();
  await page.getByRole("button", { name: item.itemId }).click();
  await expect(page.getByRole("heading", { name: "Public issue publication" })).toHaveCount(0);
  expect(statusCalls).toBe(0);
});

test("leaving a detail aborts a delayed publication state response without UI bleed", async ({
  page,
}) => {
  await installFixture(page);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.unroute("**/v1/maintainer/**");
  await page.route("**/v1/maintainer/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/auth/session")) return reply(route, session());
    if (url.pathname.endsWith("/reviews")) return reply(route, { items: [item] });
    if (url.pathname.endsWith(`/reviews/${item.itemId}`))
      return reply(route, {
        ...item,
        legalHold: { status: "none" },
        canonicalPayload: "private report",
      });
    if (url.pathname.endsWith("/publication/status")) {
      await gate;
      return reply(route, { ...prepared, status: "prepared" });
    }
    if (url.pathname.endsWith("/publication/preview")) return reply(route, prepared);
    return reply(route, { error: "not-found" }, 404);
  });
  await page.goto("/maintainer/");
  await page.getByRole("button", { name: item.itemId }).click();
  await expect(page.getByRole("button", { name: "Back to queue" })).toBeVisible();
  await page.getByRole("button", { name: "Back to queue" }).click();
  release?.();
  await expect(page.getByRole("heading", { name: "Review queue" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Public issue publication" })).toHaveCount(0);
});

test("multiple targets, reload recovery, cancel friction, and modes remain accessible", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "forced-colors evidence requires Chromium");
  const multi = [
    ...catalog,
    {
      ...catalog[0],
      targetKey: "two-target",
      owner: "keiko-two",
      repository: "public-two",
      labels: ["triaged"],
    },
  ];
  const ledger = await installFixture(page, {
    session: session({ publicationTargets: multi }),
  });
  await open(page);
  const target = page.getByLabel("Publication target");
  await expectMinimumTarget(target);
  await target.selectOption("two-target");
  await page.getByRole("button", { name: "Prepare public issue" }).click();
  expect(ledger.requests[0]?.body).toMatchObject({ targetKey: "two-target" });
  await page.reload();
  await open(page);
  await expect(page.locator(".mq-publication-preview pre").nth(1)).toHaveText(prepared.body);
  await expectMinimumTarget(page.getByRole("button", { name: "Approve public publication" }));
  await expectMinimumTarget(page.getByLabel(/I understand this cancels/u));
  await expect(page.getByRole("button", { name: "Cancel and route private" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel and route private" }).click();
  expect(ledger.requests).toHaveLength(1);
  await page.getByLabel(/I understand this cancels/u).check();
  await page.getByRole("button", { name: "Cancel and route private" }).click();
  await expect(
    page.getByText("The public route was cancelled and handled privately."),
  ).toBeVisible();
  expect(ledger.requests[1]?.body).toMatchObject({
    action: "cancel-publication-route-private",
    preparationId: prepared.preparationId,
    expectedProjectionDigest: prepared.projectionDigest,
    expectedTargetPolicyDigest: prepared.targetPolicyDigest,
  });
  await expect(page.getByRole("link", { name: "Open public GitHub issue" })).toHaveCount(0);
  await captureCancellationModes(page);
  await page.evaluate(() => {
    document.documentElement.lang = "de";
  });
});

test("manual remediation retains only the authorized public link and a safe warning", async ({
  page,
}) => {
  await installFixture(page, {
    status: {
      itemId: item.itemId,
      status: "manual-remediation",
      preparationId: prepared.preparationId,
      failureCode: "manual-remediation-required",
      linkage: { issueNumber: 42, issueUrl: "https://github.com/keiko/public-feedback/issues/42" },
    },
  });
  await open(page);
  await expect(
    page.getByText("Publication needs manual remediation. Do not repeat the action.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open public GitHub issue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve public publication" })).toHaveCount(0);
  await capture(page, "07-dark-manual-remediation");
});

test("rejects lookalike GitHub origins and accepts the exact authorized issue URL", async ({
  page,
}) => {
  await installFixture(page, {
    status: {
      itemId: item.itemId,
      status: "succeeded",
      linkage: {
        issueNumber: 42,
        issueUrl: "https://github.com.attacker.test/keiko/repo/issues/42",
      },
    },
  });
  await open(page);
  await expect(page.getByRole("link", { name: "Open public GitHub issue" })).toHaveCount(0);
  await page.unroute("**/v1/maintainer/**");
  await installFixture(page, {
    status: {
      itemId: item.itemId,
      status: "succeeded",
      linkage: { issueNumber: 42, issueUrl: "https://github.com/keiko/public-feedback/issues/42" },
    },
  });
  await page.reload();
  await page.getByRole("button", { name: item.itemId }).click();
  await expect(page.getByRole("link", { name: "Open public GitHub issue" })).toHaveAttribute(
    "href",
    "https://github.com/keiko/public-feedback/issues/42",
  );
});

test("German publication journey and copy keys stay in parity", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "language", { configurable: true, value: "de-DE" }),
  );
  await installFixture(page);
  await page.goto("/maintainer/");
  const keys = await page.evaluate(async (): Promise<{ english: string[]; deutsch: string[] }> => {
    const loaded = (await import("/maintainer/maintainer-ui-copy.js")) as unknown;
    const module = loaded as {
      publicationCopyKeys(): { english: string[]; deutsch: string[] };
    };
    return module.publicationCopyKeys();
  });
  expect(keys.english).toEqual(keys.deutsch);
  await page.getByRole("button", { name: item.itemId }).click();
  await page.getByRole("button", { name: "Öffentliches Issue vorbereiten" }).click();
  await expect(
    page.getByRole("heading", { name: "Vorbereitete öffentliche Issue-Vorschau" }),
  ).toBeVisible();
  await page.getByLabel(/Ich verstehe, dass dies/u).check();
  await page.getByRole("button", { name: "Abbrechen und privat weiterleiten" }).click();
  await expect(
    page.getByText("Der öffentliche Weg wurde abgebrochen und privat behandelt."),
  ).toBeVisible();
});

test("German direct publication error remains safe and focused", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "language", { configurable: true, value: "de-DE" }),
  );
  await installFixture(page);
  await page.route("**/publication/prepare", (route) => reply(route, {}, 403));
  await page.goto("/maintainer/");
  await page.getByRole("button", { name: item.itemId }).click();
  await expect(
    page.getByRole("heading", { name: "Öffentliche Issue-Veröffentlichung" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Öffentliches Issue vorbereiten" }).click();
  const result = page.locator("#mq-publication-result");
  await expect(result).toContainText(
    "Sie haben keine Berechtigung, diesen Bericht zu veröffentlichen.",
  );
  await expect(result).toBeFocused();
});

test("forced-colors active publication control has a governed pressed state", async ({ page }) => {
  await installFixture(page, { status: { ...prepared, status: "prepared" } });
  await page.emulateMedia({ forcedColors: "active" });
  await open(page);
  const approve = page.getByRole("button", { name: "Approve public publication" });
  await approve.scrollIntoViewIfNeeded();
  const box = await approve.boundingBox();
  if (box === null) throw new Error("Active-state evidence target is unavailable");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect.poll(() => approve.evaluate((node) => node.matches(":active"))).toBe(true);
  await expect(approve).toBeInViewport();
  await capture(page, "08-forced-colors-active");
  await page.mouse.up();
});
