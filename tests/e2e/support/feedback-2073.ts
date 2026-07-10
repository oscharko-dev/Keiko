import { expect, type Locator, type Page, type Response } from "@playwright/test";

export const FEEDBACK_WINDOW_SELECTOR = '.window[data-window-id="feedback"]';
export const SETTINGS_WINDOW_ID = "issue-2073-settings";
export const SECURITY_ADVISORY_URL =
  "https://github.com/oscharko-dev/Keiko/security/advisories/new";
export const SAFE_TITLE = "Bearer";
export const SAFE_DESCRIPTION = "The login button remains disabled after sign-in.";
export const AMBIGUOUS_ASSIGNMENT = '"password=opaque-value"';

export interface PreparedFeedbackResponse {
  readonly report: {
    readonly summary: { readonly title: string; readonly description: string };
    readonly diagnostics: { readonly category: string; readonly featureArea: string };
    readonly browserDescription?: string | undefined;
    readonly attachments?: readonly string[] | undefined;
  };
  readonly canonicalJson: string;
  readonly exactBodySha256: string;
  readonly dispositionSidecar: {
    readonly exactBodySha256: string;
    readonly records: readonly {
      readonly action: "redacted" | "quarantined" | "omitted";
      readonly reason: string;
      readonly unitKind: string;
      readonly target:
        | { readonly kind: "draft-field"; readonly field: string }
        | { readonly kind: "attachment"; readonly ordinal: number };
    }[];
  };
}

export type FeedbackModeName =
  | "dark"
  | "light"
  | "dark-high-contrast"
  | "light-high-contrast"
  | "prefers-contrast"
  | "forced-colors"
  | "reduced-motion";

export type FeedbackScreenshotName =
  | "01-dark.png"
  | "02-light.png"
  | "03-dark-hc.png"
  | "04-light-hc.png"
  | "05-prefers-contrast.png"
  | "06-forced-colors.png"
  | "07-reduced-motion.png"
  | "08-responsive-500.png";

export interface FeedbackMode {
  readonly file: FeedbackScreenshotName;
  readonly name: FeedbackModeName;
  readonly theme: "dark" | "light";
  readonly dataHc: "more" | null;
  readonly media: {
    readonly colorScheme: "dark" | "light";
    readonly contrast: "no-preference" | "more";
    readonly forcedColors: "none" | "active";
    readonly reducedMotion: "no-preference" | "reduce";
  };
}

function media(colorScheme: "dark" | "light"): FeedbackMode["media"] {
  return {
    colorScheme,
    contrast: "no-preference",
    forcedColors: "none",
    reducedMotion: "no-preference",
  };
}

export const BASELINE_FEEDBACK_MODE: FeedbackMode = {
  file: "01-dark.png",
  name: "dark",
  theme: "dark",
  dataHc: null,
  media: media("dark"),
};

export const FEEDBACK_MODES: readonly FeedbackMode[] = [
  BASELINE_FEEDBACK_MODE,
  { file: "02-light.png", name: "light", theme: "light", dataHc: null, media: media("light") },
  {
    file: "03-dark-hc.png",
    name: "dark-high-contrast",
    theme: "dark",
    dataHc: "more",
    media: media("dark"),
  },
  {
    file: "04-light-hc.png",
    name: "light-high-contrast",
    theme: "light",
    dataHc: "more",
    media: media("light"),
  },
  {
    file: "05-prefers-contrast.png",
    name: "prefers-contrast",
    theme: "dark",
    dataHc: null,
    media: { ...media("dark"), contrast: "more" },
  },
  {
    file: "06-forced-colors.png",
    name: "forced-colors",
    theme: "dark",
    dataHc: null,
    media: { ...media("dark"), forcedColors: "active" },
  },
  {
    file: "07-reduced-motion.png",
    name: "reduced-motion",
    theme: "dark",
    dataHc: null,
    media: { ...media("dark"), reducedMotion: "reduce" },
  },
];

export interface RequiredDraftValues {
  readonly title?: string;
  readonly description?: string;
  readonly actual?: string;
}

async function seedSettingsWindow(page: Page, mode: FeedbackMode): Promise<void> {
  await page.addInitScript(
    ({ windowId, theme, dataHc }) => {
      window.localStorage.setItem("keiko.theme", theme);
      window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: windowId,
            type: "settings",
            x: 32,
            y: 28,
            w: 500,
            h: 680,
            z: 10,
            cfg: {},
            max: false,
          },
        ]),
      );
      window.localStorage.removeItem("keiko.conns.v1");
      if (dataHc === null) document.documentElement.removeAttribute("data-hc");
      else document.documentElement.dataset.hc = dataHc;
    },
    { windowId: SETTINGS_WINDOW_ID, theme: mode.theme, dataHc: mode.dataHc },
  );
}

export async function openFeedbackFromSettings(
  page: Page,
  mode: FeedbackMode = BASELINE_FEEDBACK_MODE,
): Promise<Locator> {
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.emulateMedia(mode.media);
  await seedSettingsWindow(page, mode);
  await page.goto("/");
  await page.evaluate((dataHc) => {
    if (dataHc === null) document.documentElement.removeAttribute("data-hc");
    else document.documentElement.dataset.hc = dataHc;
  }, mode.dataHc);
  const settings = page.locator(`.window[data-window-id="${SETTINGS_WINDOW_ID}"]`);
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "General" }).click();
  await settings.getByRole("button", { name: "Open feedback" }).click();
  const feedback = page.locator(FEEDBACK_WINDOW_SELECTOR);
  await expect(feedback).toHaveCount(1);
  await expect(feedback).toBeVisible();
  await expect(feedback).toHaveAttribute("data-top", "true");
  return feedback;
}

export async function enterOrdinaryFeedback(feedback: Locator): Promise<void> {
  const privateLink = feedback.getByRole("link", { name: "Report a security issue privately" });
  await expect(privateLink).toHaveAttribute("href", SECURITY_ADVISORY_URL);
  await feedback.getByRole("button", { name: "Continue with ordinary feedback" }).click();
  await expect(feedback.getByRole("heading", { name: "Share feedback" })).toBeVisible();
}

export async function fillRequiredDraft(
  feedback: Locator,
  values: RequiredDraftValues = {},
): Promise<void> {
  await feedback.getByLabel("Product version").fill("0.2.14");
  await feedback.getByLabel("Title", { exact: true }).fill(values.title ?? SAFE_TITLE);
  await feedback
    .getByLabel("Description", { exact: true })
    .fill(values.description ?? SAFE_DESCRIPTION);
  await feedback.getByLabel("Steps to reproduce").fill("Open Settings and select Login.");
  await feedback.getByLabel("Expected result").fill("The login button becomes available.");
  await feedback
    .getByLabel("Actual result")
    .fill(values.actual ?? "The login button remains disabled.");
}

export async function scanFeedback(page: Page, feedback: Locator): Promise<Response> {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/feedback/preview",
  );
  await feedback.getByRole("button", { name: "Scan and preview" }).click();
  return responsePromise;
}

export async function resizeFeedbackWindowToWidth(
  page: Page,
  feedback: Locator,
  width: number,
): Promise<void> {
  const frame = feedback.locator("xpath=..");
  const windowBox = await feedback.boundingBox();
  if (windowBox === null) throw new Error("Feedback resize affordance missing");
  const handles = frame.locator(".wz-e");
  let handleBox:
    | { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    | undefined;
  for (let index = 0; index < (await handles.count()); index += 1) {
    const candidate = await handles.nth(index).boundingBox();
    if (
      candidate !== null &&
      Math.abs(candidate.x - (windowBox.x + windowBox.width)) < 8 &&
      candidate.y >= windowBox.y &&
      candidate.y <= windowBox.y + windowBox.height
    ) {
      handleBox = candidate;
      break;
    }
  }
  if (handleBox === undefined) throw new Error("Feedback east resize affordance missing");
  const targetRight = windowBox.x + width;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetRight, handleBox.y + handleBox.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => (await feedback.boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(width - 2);
  await expect
    .poll(async () => (await feedback.boundingBox())?.width ?? 0)
    .toBeLessThanOrEqual(width + 2);
}

export function postDataJson(response: Response): Record<string, unknown> {
  return response.request().postDataJSON() as Record<string, unknown>;
}

export function expectNoBypass(feedback: Locator): Promise<void> {
  return expect(feedback.getByRole("button", { name: /send anyway/iu })).toHaveCount(0);
}
