import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, type CDPSession, type Locator, type Page, type TestInfo } from "@playwright/test";
import { formatViolations, runAxe } from "./axe.js";
import { evidenceArtifactPath, evidenceScreenshotPath } from "./evidence.js";
import {
  counts,
  createAndConnect,
  fixture,
  JIRA_BROWSER_COPY,
  messages,
  openJiraChat,
  type JiraBrowserLocale,
} from "./jira-chat-4081.js";

const COPY = {
  en: {
    read: "Read Jira in this chat",
    allow: "Allow reading",
    deny: "Do not allow",
    readPending: "Waiting for your permission",
    approval: "Review Jira action",
    preview: "Proposed action details",
    approve: "Approve this action",
    reject: "Decline this action",
    pending: "Waiting for your decision",
    claimed: "Approval used for this action",
    tool: "Jira action",
    succeeded: "Jira change confirmed",
  },
  de: {
    read: "Jira in diesem Chat lesen",
    allow: "Lesen erlauben",
    deny: "Nicht erlauben",
    readPending: "Wartet auf deine Freigabe",
    approval: "Jira-Aktion prüfen",
    preview: "Details der vorgeschlagenen Aktion",
    approve: "Diese Aktion genehmigen",
    reject: "Diese Aktion ablehnen",
    pending: "Deine Entscheidung steht aus",
    claimed: "Freigabe für diese Aktion verwendet",
    tool: "Jira-Aktion",
    succeeded: "Jira-Änderung bestätigt",
  },
} as const;
interface Presentation {
  readonly name: string;
  readonly theme: "dark" | "light";
  readonly contrast?: "more";
  readonly forcedColors?: "active";
  readonly reducedMotion?: "reduce";
  readonly width?: number;
  readonly maximize?: boolean;
  readonly zoom?: 2;
}
const PRESENTATIONS: readonly Presentation[] = [
  { name: "dark", theme: "dark" },
  { name: "light", theme: "light" },
  { name: "prefers-contrast", theme: "dark", contrast: "more" },
  { name: "forced-colors", theme: "dark", forcedColors: "active" },
  { name: "reduced-motion", theme: "dark", reducedMotion: "reduce" },
  { name: "narrow-390", theme: "light", width: 390, maximize: true },
  { name: "maximized", theme: "dark", maximize: true },
  // Half the CSS viewport at device scale 2 emulates 200% desktop zoom without changing product CSS.
  { name: "viewport-device-scale-200-percent-emulation", theme: "light", zoom: 2, maximize: true },
];
interface EvidenceSession {
  readonly page: Page;
  readonly locale: JiraBrowserLocale;
  readonly info: TestInfo;
  readonly emulation: CDPSession;
  readonly captures: Record<string, unknown>[];
}

export async function keyboardActivate(control: Locator): Promise<void> {
  await expect(control).toBeEnabled();
  await control.focus();
  await expect(control).toBeFocused();
  await control.press("Enter");
}

async function presentation(
  session: EvidenceSession,
  surface: Locator,
  mode: Presentation,
): Promise<void> {
  const { page, emulation } = session;
  const scale = mode.zoom ?? 1;
  const viewport = { width: (mode.width ?? 1440) / scale, height: 1100 / scale };
  await page.setViewportSize(viewport);
  await emulation.send("Emulation.setDeviceMetricsOverride", {
    ...viewport,
    deviceScaleFactor: scale,
    mobile: false,
  });
  await page.emulateMedia({
    colorScheme: mode.theme,
    contrast: mode.contrast ?? "no-preference",
    forcedColors: mode.forcedColors ?? "none",
    reducedMotion: mode.reducedMotion ?? "no-preference",
  });
  await page.evaluate((theme) => {
    window.dispatchEvent(new CustomEvent("keiko:theme-change", { detail: theme }));
  }, mode.theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", mode.theme);
  const frame = surface.locator(
    "xpath=ancestor-or-self::section[contains(concat(' ', normalize-space(@class), ' '), ' window ')][1]",
  );
  if ((await frame.getAttribute("data-max")) !== String(mode.maximize === true))
    await keyboardActivate(frame.locator(".win-traffic-maximize"));
  await expect(frame).toHaveAttribute("data-max", String(mode.maximize === true));
  await surface.scrollIntoViewIfNeeded();
  await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => {
        resolve();
      }),
    );
    await Promise.allSettled(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().iterations))
        .map((animation) => animation.finished),
    );
  });
}

async function measuredPresentation(
  page: Page,
  surface: Locator,
): Promise<Record<string, unknown>> {
  const media = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    contrast: matchMedia("(prefers-contrast: more)").matches,
    forcedColors: matchMedia("(forced-colors: active)").matches,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    deviceScale: window.devicePixelRatio,
    layoutViewport: { width: window.innerWidth, height: window.innerHeight },
    questionTargets: Array.from(document.querySelectorAll(".chat-question-map-button"))
      .slice(0, 8)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          centerX: rect.x + rect.width / 2,
          centerY: rect.y + rect.height / 2,
        };
      }),
  }));
  const geometry = await surface.evaluate((element) => {
    // Resize handles intentionally protrude from window chrome; measure its real content body.
    const content = element.matches(".window")
      ? element.querySelector("[data-window-body]")
      : element;
    if (content === null) throw new TypeError("Missing window content measurement target");
    const rect = content.getBoundingClientRect();
    return {
      measurementTarget: element === content ? "surface" : "window-body",
      clientWidth: content.clientWidth,
      scrollWidth: content.scrollWidth,
      horizontalOverflow: content.scrollWidth > content.clientWidth + 2,
      withinLayoutViewport: rect.left >= -2 && rect.right <= window.innerWidth + 2,
    };
  });
  return { ...media, ...geometry, viewport: page.viewportSize() };
}

async function summaryContrast(page: Page): Promise<readonly Record<string, unknown>[]> {
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            root: Element,
            options: { runOnly: { type: "rule"; values: string[] } },
          ) => Promise<import("axe-core").AxeResults>;
        };
      }
    ).axe;
    const results = await axe.run(document.documentElement, {
      runOnly: { type: "rule", values: ["color-contrast"] },
    });
    return [...results.violations, ...results.passes].flatMap((result) =>
      result.nodes
        .filter((node) =>
          node.target.some((target) => typeof target === "string" && target.includes("summary")),
        )
        .flatMap((node) =>
          node.any.flatMap((check) => {
            const data: unknown = check.data;
            if (typeof data !== "object" || data === null) return [];
            const value = data as Record<string, unknown>;
            return [
              {
                ratio: value.contrastRatio,
                foreground: value.fgColor,
                background: value.bgColor,
                minimum: value.expectedContrastRatio,
              },
            ];
          }),
        ),
    );
  });
}

const BODY_MASK =
  "input, textarea, .chat-msg-content, .chat-question-map-card, pre, .acx-meta, .acx-card-title, [data-testid='acx-connector'] a";
// Screenshot-only redaction follows axe, retains native clipping, and cannot be undone by forced colors.
const BODY_REDACTION = `:is(${BODY_MASK}), :is(${BODY_MASK}) * {
  forced-color-adjust: none !important;
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  text-shadow: none !important;
  background: #777777 !important;
}`;
async function captureZoomControls(
  session: EvidenceSession,
  surface: Locator,
  path: string,
): Promise<Record<string, unknown>> {
  const controls = surface.locator(
    ":is(input, textarea, select, button, summary):not(:disabled):visible",
  );
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  await controls.first().focus();
  for (let index = 1; index < count; index++) {
    await session.page.keyboard.press("Tab");
    await expect(controls.nth(index)).toBeFocused();
  }
  await expect(controls.last()).toBeFocused();
  await expect(controls.last()).toBeInViewport();
  const file = path.replace(/\.png$/u, "-keyboard-controls.png");
  await session.page.screenshot({
    path: file,
    animations: "disabled",
    style: BODY_REDACTION,
  });
  await session.info.attach(`${session.locale}-zoom-keyboard-controls`, {
    path: file,
    contentType: "image/png",
  });
  return {
    zoomKeyboardControlCount: count,
    zoomLastControlVisible: true,
    zoomControlsScreenshot: file,
    zoomControlsScreenshotSha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  };
}

async function screenshotEvidence(
  session: EvidenceSession,
  surface: Locator,
  mode: Presentation,
  file: string,
): Promise<Record<string, unknown>> {
  const options = {
    path: file,
    animations: "disabled" as const,
    style: BODY_REDACTION,
  };
  if (mode.zoom !== 2) {
    await surface.screenshot(options);
    return { screenshotScope: "surface" };
  }
  // Tall cards legitimately scroll at 200%; capture the real viewport at both the heading and controls.
  await surface.evaluate((element) => {
    element.scrollIntoView({ block: "start", behavior: "instant" });
  });
  await session.page.screenshot(options);
  return { screenshotScope: "viewport", ...(await captureZoomControls(session, surface, file)) };
}

async function capture(
  session: EvidenceSession,
  surface: Locator,
  stage: string,
  mode: Presentation,
): Promise<Record<string, unknown>> {
  const { page, locale, captures, info } = session;
  await presentation(session, surface, mode);
  const violations = await runAxe(page, "html");
  const geometry = await measuredPresentation(page, surface);
  const contrast = await summaryContrast(page);
  const name = `${locale}-${stage}-${mode.name}`;
  const file = evidenceScreenshotPath(`docs/design-system/evidence/4081/${name}.png`);
  const screenshots = await screenshotEvidence(session, surface, mode, file);
  const record = {
    stage,
    mode: mode.name,
    ...geometry,
    summaryContrast: contrast,
    screenshotRedaction: "content-colors-only-with-native-clipping",
    axeBeforeScreenshotRedaction: true,
    ...screenshots,
    axeScope: "document",
    axeViolations: violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
    screenshot: file,
    screenshotSha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  };
  captures.push(record);
  await info.attach(name, { path: file, contentType: "image/png" });
  expect(violations, `${name}\n${formatViolations(violations)}`).toEqual([]);
  expect(geometry.horizontalOverflow, `${name} horizontal overflow`).toBe(false);
  expect(geometry.withinLayoutViewport, `${name} horizontal viewport clipping`).toBe(true);
  expect(geometry.contrast).toBe(mode.contrast === "more");
  expect(geometry.forcedColors).toBe(mode.forcedColors === "active");
  expect(geometry.reducedMotion).toBe(mode.reducedMotion === "reduce");
  expect(geometry.deviceScale).toBe(mode.zoom ?? 1);
  return record;
}

async function captureMatrix(
  session: EvidenceSession,
  surface: Locator,
  stage: string,
): Promise<void> {
  for (const mode of PRESENTATIONS) await capture(session, surface, stage, mode);
  await presentation(session, surface, { name: "reset", theme: "dark" });
}

async function formEvidence(session: EvidenceSession, form: Locator, hub: Locator): Promise<void> {
  const copy = JIRA_BROWSER_COPY[session.locale];
  const label = form.getByLabel(copy.label, { exact: true });
  await label.focus();
  await session.page.keyboard.press("Tab");
  await expect(form.getByLabel(copy.url, { exact: true })).toBeFocused();
  await session.page.keyboard.press("Tab");
  await expect(form.getByLabel(copy.token, { exact: true })).toBeFocused();
  await expect(form.getByLabel(copy.token, { exact: true })).toHaveAttribute("type", "password");
  await hub
    .getByRole("heading", {
      name: session.locale === "de" ? "Jira Live-Pods" : "Jira Live Pods",
      exact: true,
    })
    .scrollIntoViewIfNeeded();
  await capture(session, hub, "hub-create-context", { name: "dark", theme: "dark" });
  await captureMatrix(session, form, "hub-create-form");
  await expect(hub.getByRole("button", { name: copy.save, exact: true })).toBeVisible();
}

async function keyboardDecision(page: Page, allow: Locator, deny: Locator): Promise<void> {
  await allow.focus();
  await expect(allow).toBeFocused();
  const visibleFocus = await allow.evaluate((element) => {
    const style = getComputedStyle(element);
    return Number.parseFloat(style.outlineWidth) > 0 || style.boxShadow !== "none";
  });
  expect(visibleFocus).toBe(true);
  await page.keyboard.press("Tab");
  await expect(deny).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(allow).toBeFocused();
  await page.keyboard.press("Enter");
}

async function sendWithKeyboard(
  session: EvidenceSession,
  region: Locator,
  content: string,
): Promise<void> {
  const copy = JIRA_BROWSER_COPY[session.locale];
  await region.getByRole("textbox", { name: copy.message, exact: true }).fill(content);
  await keyboardActivate(region.getByRole("button", { name: copy.send, exact: true }));
}

async function readEvidence(session: EvidenceSession, region: Locator): Promise<void> {
  const copy = COPY[session.locale];
  const before = counts();
  await sendWithKeyboard(session, region, "JIRA_E2E_READ: inspect the synthetic projects.");
  const consent = region.getByRole("region", { name: copy.read, exact: true });
  await expect(consent.locator('output[aria-live="polite"]')).toHaveText(copy.readPending);
  await captureMatrix(session, consent, "pending-read-consent");
  expect(counts().projects).toBe(before.projects);
  await keyboardDecision(
    session.page,
    consent.getByRole("button", { name: copy.allow, exact: true }),
    consent.getByRole("button", { name: copy.deny, exact: true }),
  );
  await expect.poll(() => counts().projects).toBe(before.projects + 1);
  await expect(region.getByText("JIRA_E2E_DONE", { exact: true })).toBeVisible();
}

async function writeEvidence(session: EvidenceSession, region: Locator): Promise<void> {
  const copy = COPY[session.locale];
  const before = counts();
  await sendWithKeyboard(
    session,
    region,
    "JIRA_E2E_COMMENT: add the synthetic approval fixture comment.",
  );
  const approval = region.getByRole("region", { name: copy.approval, exact: true });
  const preview = approval.getByRole("textbox", { name: copy.preview, exact: true });
  await expect(preview).toBeVisible();
  expect(JSON.parse(await preview.inputValue()) as unknown).toEqual({
    issueKey: "KEIKO-1",
    body: "Synthetic browser approval fixture",
  });
  await expect(preview).toHaveAttribute("readonly", "");
  await expect(approval.locator('output[aria-live="polite"]')).toHaveText(copy.pending);
  await captureMatrix(session, approval, "pending-exact-write-approval");
  expect(counts().writes).toBe(before.writes);
  await preview.focus();
  await session.page.keyboard.press("Tab");
  const allow = approval.getByRole("button", { name: copy.approve, exact: true });
  await expect(allow).toBeFocused();
  await keyboardDecision(
    session.page,
    allow,
    approval.getByRole("button", { name: copy.reject, exact: true }),
  );
  await expect(region.getByText(copy.succeeded, { exact: true })).toBeVisible();
  await expect(approval.locator('output[aria-live="polite"]')).toHaveText(copy.claimed);
  expect(counts().writes).toBe(before.writes + 1);
  expect(counts().confirmations).toBe(before.confirmations + 1);
  const result = region.getByRole("region", { name: copy.tool, exact: true }).last();
  await expect(result.getByRole("status")).toHaveText(copy.succeeded);
  await captureMatrix(session, result, "settled-jira-result");
}

async function appendNavigationTurns(session: EvidenceSession, region: Locator): Promise<void> {
  for (let index = 0; index < 28; index++) {
    const content = `Navigation fixture ${String(index + 1)}`;
    await sendWithKeyboard(session, region, content);
    await expect
      .poll(async () => {
        const rows = await messages(session.page, fixture().chats["accessibility-en"].id);
        return rows.find((message) => message.role === "user" && message.content === content)
          ?.turnState;
      })
      .toBe("completed");
  }
}

async function questionNavigationEvidence(
  session: EvidenceSession,
  region: Locator,
): Promise<void> {
  const before = counts();
  await appendNavigationTurns(session, region);
  const navigation = region.getByRole("navigation", {
    name: "Conversation questions",
    exact: true,
  });
  const buttons = navigation.getByRole("button");
  await expect(buttons).toHaveCount(30);
  await buttons.first().focus();
  for (let index = 1; index < 30; index++) await session.page.keyboard.press("Tab");
  await expect(buttons.last()).toBeFocused();
  await expect(buttons.last()).toBeInViewport();
  const geometry = await navigation.locator("ol").evaluate((list) => ({
    scrollHeight: list.scrollHeight,
    clientHeight: list.clientHeight,
    scrollTop: list.scrollTop,
  }));
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  expect(geometry.clientHeight).toBeLessThanOrEqual(520);
  expect(geometry.scrollTop).toBeGreaterThan(0);
  await buttons.last().press("Enter");
  await expect(
    region.locator(".chat-msg-content").filter({ hasText: "Navigation fixture 28" }),
  ).toBeInViewport();
  await buttons.first().focus();
  await buttons.first().press("Enter");
  await expect(
    region.locator(".chat-msg-content").filter({ hasText: "JIRA_E2E_READ:" }),
  ).toBeInViewport();
  expect(counts().jiraRequests).toBe(before.jiraRequests);
  const record = await capture(session, navigation, "bounded-keyboard-question-navigation", {
    name: "dark",
    theme: "dark",
  });
  record.keyboardTraversal = {
    ...geometry,
    questionCount: await buttons.count(),
    additionalJiraRequests: counts().jiraRequests - before.jiraRequests,
  };
}

const EVIDENCE_SOURCES = [
  "tests/e2e/jira-chat-4081.spec.ts",
  "tests/e2e/support/jira-chat-4081.ts",
  "tests/e2e/support/jira-chat-4081-accessibility.ts",
  "tests/e2e/support/jira-chat-4081-server.mjs",
  "tests/e2e/support/jira-chat-4081-transport.mjs",
  "tests/e2e/config/playwright.jira-chat-4081.config.ts",
  "packages/keiko-ui/src/app/components/desktop/JiraChatTools.tsx",
  "packages/keiko-ui/src/app/components/desktop/JiraChatTools.module.css",
  "packages/keiko-ui/src/app/components/desktop/JiraWriteApproval.tsx",
  "packages/keiko-ui/src/app/components/desktop/JiraChatConnection.tsx",
  "packages/keiko-ui/src/app/components/desktop/JiraChatConnection.module.css",
  "packages/keiko-ui/src/app/globals.css",
  "packages/keiko-ui/src/lib/i18n-messages.optional.en.ts",
  "packages/keiko-ui/src/lib/i18n-messages.optional.de.ts",
];

function saveReceipt(session: EvidenceSession): string {
  const file = evidenceArtifactPath(
    `docs/design-system/evidence/4081/${session.locale}-accessibility.json`,
  );
  writeFileSync(
    file,
    JSON.stringify(
      {
        schemaVersion: 1,
        epic: 4081,
        issue: 4086,
        evidenceClass: "production-composed-deterministic-browser",
        realJiraQualification: false,
        realModelQualification: false,
        nativeZoomQualification: false,
        screenReaderQualification: false,
        locale: session.locale,
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        browser: session.page.context().browser()?.version(),
        gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        sourceHashes: Object.fromEntries(
          EVIDENCE_SOURCES.map((source) => [
            source,
            createHash("sha256").update(readFileSync(source)).digest("hex"),
          ]),
        ),
        capturedAt: new Date().toISOString(),
        captures: session.captures,
      },
      null,
      2,
    ),
  );
  return file;
}

export async function jiraAccessibilityJourney(
  page: Page,
  locale: JiraBrowserLocale,
  info: TestInfo,
): Promise<void> {
  const session: EvidenceSession = {
    page,
    locale,
    info,
    captures: [],
    emulation: await page.context().newCDPSession(page),
  };
  try {
    const region = await openJiraChat(page, `accessibility-${locale}`, locale);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await createAndConnect(page, region, `Jira accessibility ${locale}`, {
      locale,
      activate: keyboardActivate,
      inspectForm: (form, hub) => formEvidence(session, form, hub),
    });
    const copy = JIRA_BROWSER_COPY[locale];
    const connection = region.getByTestId("jira-chat-connection");
    await keyboardActivate(connection.locator("summary"));
    await expect(connection.getByRole("status").filter({ hasText: copy.connected })).toHaveText(
      copy.connected,
    );
    await captureMatrix(session, connection, "confirmed-chat-binding");
    await keyboardActivate(connection.locator("summary"));
    await readEvidence(session, region);
    await writeEvidence(session, region);
    if (locale === "en") await questionNavigationEvidence(session, region);
    const stored = await messages(page, fixture().chats[`accessibility-${locale}`].id);
    const write = stored
      .flatMap((message) => message.toolTranscript?.exchanges ?? [])
      .find((exchange) => exchange.call.name === "jira_comment");
    expect(write?.approval?.state).toBe("claimed");
    expect(write?.mutationOutcome).toBe("succeeded");
    expect(counts().leaks).toBe(0);
    expect(session.captures).toHaveLength(PRESENTATIONS.length * 5 + (locale === "en" ? 2 : 1));
  } finally {
    await info.attach(`${locale}-body-free-accessibility-receipt`, {
      path: saveReceipt(session),
      contentType: "application/json",
    });
    await session.emulation.detach();
  }
}
