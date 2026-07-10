import { Buffer } from "node:buffer";

import { expect, test, type Locator, type Page, type Response } from "@playwright/test";

import {
  enterOrdinaryFeedback,
  expectNoBypass,
  fillRequiredDraft,
  openFeedbackFromSettings,
  postDataJson,
  scanFeedback,
  type PreparedFeedbackResponse,
} from "./support/feedback-2073.js";

// Issue #2073 (Epic #2070) - live attachment privacy and complete public-copy proof.

interface BrowserAttachmentEnvelope {
  readonly bytesBase64: string;
  readonly declaredMediaType: string;
  readonly extension: string;
}

function requestAttachments(body: Record<string, unknown>): readonly BrowserAttachmentEnvelope[] {
  expect(Array.isArray(body.attachments)).toBe(true);
  return body.attachments as readonly BrowserAttachmentEnvelope[];
}

function assertAnonymousRequest(
  response: Response,
  excludedNames: readonly string[],
): readonly BrowserAttachmentEnvelope[] {
  const requestBody = postDataJson(response);
  const envelopes = requestAttachments(requestBody);
  for (const envelope of envelopes) {
    expect(Object.keys(envelope).sort()).toEqual(["bytesBase64", "declaredMediaType", "extension"]);
  }
  const serialized = JSON.stringify(requestBody);
  for (const name of excludedNames) expect(serialized).not.toContain(name);
  expect(serialized).not.toContain("lastModified");
  expect(serialized).not.toContain("path");
  return envelopes;
}

async function assertPreparedAttachments(
  feedback: Locator,
  prepared: PreparedFeedbackResponse,
  safeRaw: string,
): Promise<Locator> {
  expect(prepared.report.attachments).toEqual([safeRaw]);
  expect(prepared.canonicalJson).not.toContain("opaque-attachment-value");
  expect(prepared.dispositionSidecar.records).toEqual([
    {
      action: "quarantined",
      reason: "ambiguous-credential-structure",
      unitKind: "quoted-segment",
      target: { kind: "attachment", ordinal: 0 },
    },
    {
      action: "omitted",
      reason: "no-safe-optional-content",
      unitKind: "attachment",
      target: { kind: "attachment", ordinal: 0 },
    },
  ]);
  const preview = feedback.getByRole("region", { name: "Sanitized preview" });
  const notices = preview.getByRole("region", { name: "Privacy changes" });
  await expect(notices).toContainText("ambiguous credential-like content was quarantined");
  await expect(notices).toContainText("no safe optional content remained, so it was omitted");
  await expect(preview.getByText("Attachment 2", { exact: true })).toBeVisible();
  await expect(preview.getByText(safeRaw, { exact: true })).toBeVisible();
  await expect(preview).not.toContainText("opaque-attachment-value");
  return preview;
}

async function removeAndRescanAttachment(
  page: Page,
  feedback: Locator,
  preview: Locator,
  safeRaw: string,
): Promise<void> {
  const notices = preview.getByRole("region", { name: "Privacy changes" });
  const removeFirst = feedback.getByRole("button", { name: "Remove attachment 1" });
  await notices.getByRole("button", { name: "Review attachment 1" }).click();
  await expect(removeFirst).toBeFocused();
  await removeFirst.click();
  await expect(preview).toHaveCount(0);
  await expect(feedback.getByRole("status")).toContainText("Attachment 1 removed");
  const response = await scanFeedback(page, feedback);
  expect(response.status()).toBe(200);
  const envelopes = requestAttachments(postDataJson(response));
  expect(envelopes).toHaveLength(1);
  const retained = envelopes[0];
  if (retained === undefined) throw new Error("Expected one retained attachment envelope");
  expect(Buffer.from(retained.bytesBase64, "base64").toString("utf8")).toBe(safeRaw);
  const rescanned = feedback.getByRole("region", { name: "Sanitized preview" });
  await expect(rescanned.getByText("Attachment 1", { exact: true })).toBeVisible();
  await expect(rescanned.getByText(safeRaw, { exact: true })).toBeVisible();
}

test("keeps anonymous attachment ordinals through omission, navigation, and rescan", async ({
  page,
}) => {
  const feedback = await openFeedbackFromSettings(page);
  await enterOrdinaryFeedback(feedback);
  await fillRequiredDraft(feedback);
  const unsafeRaw = '"password=opaque-attachment-value"';
  const safeRaw = "Safe attachment remains.";
  const unsafeName = "customer-private-first.txt";
  const safeName = "customer-private-second.txt";
  const picker = feedback.getByLabel("Add text attachment");
  await picker.setInputFiles([
    { name: unsafeName, mimeType: "text/plain", buffer: Buffer.from(unsafeRaw) },
    { name: safeName, mimeType: "text/plain", buffer: Buffer.from(safeRaw) },
  ]);
  await expect(feedback.getByText("Attachment 1", { exact: true })).toBeVisible();
  await expect(feedback.getByText("Attachment 2", { exact: true })).toBeVisible();
  await expect(feedback).not.toContainText(unsafeName);
  await expect(feedback).not.toContainText(safeName);

  const response = await scanFeedback(page, feedback);
  expect(response.status()).toBe(200);
  const envelopes = assertAnonymousRequest(response, [unsafeName, safeName]);
  expect(envelopes).toHaveLength(2);
  const prepared = (await response.json()) as PreparedFeedbackResponse;
  const preview = await assertPreparedAttachments(feedback, prepared, safeRaw);
  await expectNoBypass(feedback);
  await removeAndRescanAttachment(page, feedback, preview, safeRaw);
  await expectNoBypass(feedback);
});

test("offers an exact complete copy when a safe report exceeds public URL bounds", async ({
  page,
}) => {
  const feedback = await openFeedbackFromSettings(page);
  await enterOrdinaryFeedback(feedback);
  const completeActual = `oversize-sanitized-${"ü".repeat(2_000)}`;
  await fillRequiredDraft(feedback, {
    title: "Large safe feedback report",
    description: "The report needs the complete public-copy handoff.",
    actual: completeActual,
  });
  const response = await scanFeedback(page, feedback);
  expect(response.status()).toBe(200);
  const prepared = (await response.json()) as PreparedFeedbackResponse;
  const preview = feedback.getByRole("region", { name: "Sanitized preview" });
  const publicLink = preview.getByRole("button", { name: "Open public GitHub form" });
  await expect(publicLink).toBeVisible();

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  const copyButton = preview.getByRole("button", { name: "Copy sanitized report" });
  await copyButton.click();
  const completeCopy = preview.getByRole("textbox", { name: "Complete sanitized report" });
  const copyText = await completeCopy.inputValue();
  await expect(completeCopy).toHaveAttribute("readonly", "");
  expect(copyText).toContain("Issue title:\n[User Finding]: Large safe feedback report");
  expect(copyText).toContain(`Actual result:\n${completeActual}`);
  expect(copyText).toContain("Diagnostics:\nCategory: defect\nFeature area: other");
  expect(copyText).toContain(prepared.report.summary.description);
  expect(copyText.endsWith("User impact:\nUnknown")).toBe(true);
  await expect(preview.getByRole("status")).toHaveText("Sanitized report copied.");
  await expect(copyButton).toBeFocused();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(copyText);
  await expectNoBypass(feedback);
});
