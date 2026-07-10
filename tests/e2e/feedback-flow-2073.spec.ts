import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";

import {
  AMBIGUOUS_ASSIGNMENT,
  SAFE_DESCRIPTION,
  SAFE_TITLE,
  enterOrdinaryFeedback,
  expectNoBypass,
  fillRequiredDraft,
  openFeedbackFromSettings,
  postDataJson,
  scanFeedback,
  type PreparedFeedbackResponse,
} from "./support/feedback-2073.js";

// Issue #2073 (Epic #2070) - live packaged CLI/BFF proof for feedback and recovery.

async function attestAndSubmit(
  feedback: Locator,
): Promise<{ readonly preview: Locator; readonly submit: Locator }> {
  const preview = feedback.getByRole("region", { name: "Sanitized preview" });
  await preview
    .getByRole("checkbox", {
      name: "I reviewed the exact sanitized payload and confirm it is ready for submission.",
    })
    .check();
  await preview.getByRole("button", { name: "Continue to submission" }).click();
  return {
    preview,
    submit: preview.getByRole("button", { name: "Submit feedback" }),
  };
}

async function assertPreparedPreview(
  feedback: Locator,
  prepared: PreparedFeedbackResponse,
): Promise<void> {
  expect(prepared.report.summary).toEqual({ title: SAFE_TITLE, description: SAFE_DESCRIPTION });
  expect(prepared.exactBodySha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.parse(prepared.canonicalJson)).toEqual(prepared.report);
  expect(prepared.dispositionSidecar.exactBodySha256).toBe(prepared.exactBodySha256);
  const preview = feedback.getByRole("region", { name: "Sanitized preview" });
  const title = preview.getByRole("heading", { name: SAFE_TITLE, exact: true });
  await expect(title).toBeVisible();
  await expect(preview.getByText(SAFE_DESCRIPTION, { exact: true })).toBeVisible();
  expect(
    await title.evaluate((node, descriptionText) => {
      const parent = node.parentElement;
      if (parent === null) return false;
      const description = [...parent.children].find(
        (child) => child.textContent === descriptionText,
      );
      return (
        description !== undefined &&
        (node.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      );
    }, SAFE_DESCRIPTION),
  ).toBe(true);
  await expect(preview.locator("pre")).toHaveText(prepared.canonicalJson);
  await expect(preview.locator("code")).toHaveText(prepared.exactBodySha256);
  await expect(preview.getByRole("button", { name: "Open public GitHub form" })).toBeVisible();
}

async function assertUnavailableSubmission(
  page: Page,
  feedback: Locator,
  prepared: PreparedFeedbackResponse,
): Promise<void> {
  const confirmation = await attestAndSubmit(feedback);
  const responsePromise = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/feedback/submit",
  );
  await confirmation.submit.click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(Object.keys(postDataJson(response)).sort()).toEqual(["canonicalJson", "exactBodySha256"]);
  expect(postDataJson(response)).toEqual({
    canonicalJson: prepared.canonicalJson,
    exactBodySha256: prepared.exactBodySha256,
  });
  expect(await response.json()).toEqual({ outcome: "unavailable" });
  const unavailable = confirmation.preview.getByRole("region", {
    name: "Feedback intake unavailable",
  });
  await expect(unavailable).toBeFocused();
  await expect(unavailable.getByText(/use the public GitHub form/u)).toBeVisible();
  const retryPromise = page.waitForResponse(
    (retry) => new URL(retry.url()).pathname === "/api/feedback/submit",
  );
  await unavailable.getByRole("button", { name: "Retry submission" }).click();
  const retry = await retryPromise;
  expect(postDataJson(retry)).toEqual(postDataJson(response));
  expect(await retry.json()).toEqual({ outcome: "unavailable" });
  await expect(unavailable).toBeFocused();
}

async function assertOptionalOmission(
  feedback: Locator,
  prepared: PreparedFeedbackResponse,
): Promise<{ readonly preview: Locator; readonly notices: Locator }> {
  expect(prepared.report.browserDescription).toBeUndefined();
  expect(prepared.canonicalJson).not.toContain("opaque-value");
  expect(prepared.dispositionSidecar.records).toEqual([
    {
      action: "quarantined",
      reason: "ambiguous-credential-structure",
      unitKind: "quoted-segment",
      target: { kind: "draft-field", field: "browserDescription" },
    },
    {
      action: "omitted",
      reason: "no-safe-optional-content",
      unitKind: "optional-field",
      target: { kind: "draft-field", field: "browserDescription" },
    },
  ]);
  const preview = feedback.getByRole("region", { name: "Sanitized preview" });
  const notices = preview.getByRole("region", { name: "Privacy changes" });
  await expect(notices).toContainText("ambiguous credential-like content was quarantined");
  await expect(notices).toContainText("no safe optional content remained, so it was omitted");
  await expect(preview).not.toContainText("opaque-value");
  return { preview, notices };
}

async function removeOptionalAndRescan(page: Page, feedback: Locator): Promise<Locator> {
  const browser = feedback.getByLabel("Browser description (optional)");
  const optional = feedback.getByRole("region", { name: "Sanitized preview" });
  const notices = optional.getByRole("region", { name: "Privacy changes" });
  await notices.getByRole("button", { name: "Edit browser description" }).click();
  await expect(browser).toBeFocused();
  await expect(browser).toHaveValue(AMBIGUOUS_ASSIGNMENT);
  await notices.getByRole("button", { name: "Remove browser description" }).click();
  await expect(optional).toHaveCount(0);
  await expect(browser).toHaveValue("");
  const response = await scanFeedback(page, feedback);
  expect(response.status()).toBe(200);
  expect(postDataJson(response)).not.toHaveProperty("browserDescription");
  const rescanned = feedback.getByRole("region", { name: "Sanitized preview" });
  await expect(rescanned.getByRole("checkbox")).not.toBeChecked();
  await expect(rescanned).not.toContainText("opaque-value");
  return rescanned;
}

async function recoverRequiredRewrite(
  page: Page,
  feedback: Locator,
  preview: Locator,
): Promise<void> {
  await preview.getByRole("button", { name: "Edit and rescan" }).click();
  const description = feedback.getByLabel("Description", { exact: true });
  await description.fill(AMBIGUOUS_ASSIGNMENT);
  const blocked = await scanFeedback(page, feedback);
  expect(blocked.status()).toBe(422);
  const body = (await blocked.json()) as Record<string, unknown>;
  expect(body).toMatchObject({
    errors: [
      {
        code: "rewrite-required",
        target: { kind: "draft-field", field: "description" },
      },
    ],
  });
  expect(JSON.stringify(body)).not.toContain("opaque-value");
  await expect(description).toBeFocused();
  await expect(feedback.getByRole("alert")).toContainText("Rewrite the required field");
  await description.fill("Recovered safe description.");
  const recovered = await scanFeedback(page, feedback);
  expect(recovered.status()).toBe(200);
  await expect(feedback.getByRole("region", { name: "Sanitized preview" })).toContainText(
    "Recovered safe description.",
  );
}

test("uses exact prepared bytes for public and unavailable intake paths", async ({ page }) => {
  const feedback = await openFeedbackFromSettings(page);
  await expect(feedback.getByRole("heading", { name: "Before you continue" })).toBeFocused();
  await expect(feedback.getByRole("heading", { name: "Share feedback" })).toHaveCount(0);
  await enterOrdinaryFeedback(feedback);
  await fillRequiredDraft(feedback);

  const previewResponse = await scanFeedback(page, feedback);
  expect(previewResponse.status()).toBe(200);
  const prepared = (await previewResponse.json()) as PreparedFeedbackResponse;
  await assertPreparedPreview(feedback, prepared);
  await expectNoBypass(feedback);
  await assertUnavailableSubmission(page, feedback, prepared);
  await expectNoBypass(feedback);
});

test("recovers optional omission and required rewrite without exposing removed text", async ({
  page,
}) => {
  const feedback = await openFeedbackFromSettings(page);
  await enterOrdinaryFeedback(feedback);
  await fillRequiredDraft(feedback);
  const browser = feedback.getByLabel("Browser description (optional)");
  await browser.fill(AMBIGUOUS_ASSIGNMENT);

  const optionalResponse = await scanFeedback(page, feedback);
  expect(optionalResponse.status()).toBe(200);
  const optionalPrepared = (await optionalResponse.json()) as PreparedFeedbackResponse;
  await assertOptionalOmission(feedback, optionalPrepared);
  await expectNoBypass(feedback);
  const rescanned = await removeOptionalAndRescan(page, feedback);
  await recoverRequiredRewrite(page, feedback, rescanned);
  await expectNoBypass(feedback);
});

async function preparePublicPreview(
  page: Page,
): Promise<{ readonly feedback: Locator; readonly prepared: PreparedFeedbackResponse }> {
  const feedback = await openFeedbackFromSettings(page);
  await enterOrdinaryFeedback(feedback);
  await fillRequiredDraft(feedback);
  const response = await scanFeedback(page, feedback);
  expect(response.status()).toBe(200);
  const prepared = (await response.json()) as PreparedFeedbackResponse;
  await expect(feedback.getByRole("region", { name: "Sanitized preview" })).toBeVisible();
  return { feedback, prepared };
}

test("opens one reserved accessible popup before delayed live validation and navigates that popup once", async ({
  page,
  context,
}) => {
  const { feedback } = await preparePublicPreview(page);
  let githubRequestUrl: string | undefined;
  await page.route("**/api/feedback/revalidate", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });
  await context.route("https://github.com/oscharko-dev/Keiko/issues/new**", async (route) => {
    githubRequestUrl = route.request().url();
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>GitHub user finding</title><main>User finding</main>",
    });
  });
  const pagesBefore = context.pages();
  const popupPromise = page.waitForEvent("popup");
  await feedback.getByRole("button", { name: "Open public GitHub form" }).click();
  const popup = await popupPromise;
  expect(context.pages()).toHaveLength(pagesBefore.length + 1);
  await expect(popup).toHaveTitle("Opening public GitHub form");
  await expect(popup.getByRole("status")).toHaveText("Opening public GitHub form…");
  expect(popup.url()).toBe("about:blank");
  await popup.waitForURL(
    (url) =>
      url.origin === "https://github.com" && url.pathname === "/oscharko-dev/Keiko/issues/new",
  );
  expect(githubRequestUrl).toMatch(/^https:\/\/github\.com\/oscharko-dev\/Keiko\/issues\/new\?/u);
  expect(context.pages()).toHaveLength(pagesBefore.length + 1);
  expect(await popup.title()).toBe("GitHub user finding");
  await popup.close();
});

test("closes the reserved popup on a real live-policy security rejection without external navigation", async ({
  page,
  context,
}) => {
  const { feedback } = await preparePublicPreview(page);
  let githubNavigated = false;
  await context.route("https://github.com/oscharko-dev/Keiko/issues/new**", async (route) => {
    githubNavigated = true;
    await route.abort();
  });
  await page.route("**/api/feedback/revalidate", async (route) => {
    const body = route.request().postDataJSON() as {
      canonicalJson: string;
      exactBodySha256: string;
    };
    const report = JSON.parse(body.canonicalJson) as {
      summary: { title: string; description: string };
    };
    report.summary.title = "Exploit: session validation";
    report.summary.description = "A proof-of-concept exploit is reproducible.";
    const canonicalJson = JSON.stringify(report);
    const exactBodySha256 = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
    await route.continue({ postData: JSON.stringify({ canonicalJson, exactBodySha256 }) });
  });
  const popupPromise = page.waitForEvent("popup");
  await feedback.getByRole("button", { name: "Open public GitHub form" }).click();
  await popupPromise;
  await expect.poll(() => context.pages().length).toBe(1);
  await expect(feedback.getByRole("alert")).toContainText("private Security Advisory route");
  expect(githubNavigated).toBe(false);
});
