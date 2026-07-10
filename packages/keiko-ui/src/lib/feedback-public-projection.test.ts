import type { FeedbackReportV1 } from "@oscharko-dev/keiko-contracts/feedback-report";
import { describe, expect, it } from "vitest";

import {
  createFeedbackPublicProjectionV1,
  PUBLIC_FEEDBACK_FORM_URL_V1,
} from "./feedback-public-projection";

function report(overrides: Partial<FeedbackReportV1> = {}): FeedbackReportV1 {
  return {
    schemaVersion: "1",
    privacyContractVersion: "1",
    redactionProvenance: {
      engineVersion: "1",
      rules: [{ code: "credential-assignment", count: 1 }],
    },
    productVersion: "0.2.14",
    platform: "Linux",
    browserDescription: "Firefox 139",
    summary: {
      title: "Editor preview is unavailable",
      description: "The preview contains [REDACTED] and remains safe.",
    },
    steps: "1. Open Files\n2. Select a file",
    expectedResult: "The editor preview opens.",
    actualResult: "The editor preview stays empty.",
    impact: "Degrades core workflow",
    handwrittenEvidence: "Sanitized evidence remains.",
    attachments: ["First safe attachment", "Second safe attachment"],
    diagnostics: { category: "defect", featureArea: "editor" },
    ...overrides,
  };
}

describe("public feedback projection v1", () => {
  it("maps only reliably prefillable public form fields from the sanitized report", () => {
    const prepared = report();
    const projection = createFeedbackPublicProjectionV1(prepared);
    const repeated = createFeedbackPublicProjectionV1(prepared);
    const url = new URL(projection.href);

    expect(projection.mode).toBe("prefilled");
    expect(projection).toEqual(repeated);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/oscharko-dev/Keiko/issues/new");
    expect([...url.searchParams.keys()]).toEqual([
      "template",
      "title",
      "version",
      "browser",
      "summary",
      "steps",
      "expected",
      "actual",
      "evidence",
    ]);
    expect(url.searchParams.get("template")).toBe("user_finding.yml");
    expect(url.searchParams.get("title")).toBe("[User Finding]: Editor preview is unavailable");
    expect(url.searchParams.get("summary")).toBe(
      "Editor preview is unavailable\n\nThe preview contains [REDACTED] and remains safe.",
    );
    expect(url.searchParams.get("version")).toBe("0.2.14");
    expect(url.searchParams.has("platform")).toBe(false);
    expect(url.searchParams.get("browser")).toBe("Firefox 139");
    expect(url.searchParams.get("steps")).toBe("1. Open Files\n2. Select a file");
    expect(url.searchParams.get("expected")).toBe("The editor preview opens.");
    expect(url.searchParams.get("actual")).toBe("The editor preview stays empty.");
    expect(url.searchParams.has("impact")).toBe(false);
    expect(url.searchParams.get("evidence")).toBe(
      [
        "Sanitized evidence remains.",
        "Attachment 1:\nFirst safe attachment",
        "Attachment 2:\nSecond safe attachment",
        "Diagnostics:\nCategory: defect\nFeature area: editor",
      ].join("\n\n"),
    );
    expect(url.searchParams.has("safety")).toBe(false);
    expect(url.searchParams.has("maintainer_release_impact")).toBe(false);
    expect(projection.copyText).toContain(
      "Summary:\nEditor preview is unavailable\n\nThe preview contains [REDACTED] and remains safe.",
    );
    expect(projection.copyText).toContain(
      "Evidence:\nSanitized evidence remains.\n\nAttachment 1:\nFirst safe attachment",
    );
    expect(projection.copyText).toContain("Platform:\nLinux");
    expect(projection.copyText).toContain("User impact:\nDegrades core workflow");
    expect(PUBLIC_FEEDBACK_FORM_URL_V1).toBe(
      "https://github.com/oscharko-dev/Keiko/issues/new?template=user_finding.yml",
    );
  });

  it("falls back to the unprefilled form with complete deterministic sanitized copy", () => {
    const completeActual = `oversize-sanitized-${"ü".repeat(10_000)}`;
    const prepared = report({ actualResult: completeActual });
    const projection = createFeedbackPublicProjectionV1(prepared);
    const repeated = createFeedbackPublicProjectionV1(prepared);
    const url = new URL(projection.href);

    expect(projection.mode).toBe("copy-fallback");
    expect(projection).toEqual(repeated);
    expect(projection.href).toBe(PUBLIC_FEEDBACK_FORM_URL_V1);
    expect([...url.searchParams.keys()]).toEqual(["template"]);
    expect(new TextEncoder().encode(projection.href).length).toBeLessThanOrEqual(8_192);
    expect(projection.copyText).toContain(
      "Issue title:\n[User Finding]: Editor preview is unavailable",
    );
    expect(projection.copyText).toContain(
      "Summary:\nEditor preview is unavailable\n\nThe preview contains [REDACTED] and remains safe.",
    );
    expect(projection.copyText).toContain(`Actual result:\n${completeActual}`);
    expect(projection.copyText.endsWith("User impact:\nDegrades core workflow")).toBe(true);
  });

  it("keeps sanitized diagnostics in copy text without unsupported query keys", () => {
    const projection = createFeedbackPublicProjectionV1(
      report({
        diagnostics: {
          category: "performance",
          featureArea: "local-knowledge",
          severityCounts: { errors: 2, warnings: 3, infos: 4 },
        },
      }),
    );
    const url = new URL(projection.href);

    expect(projection.copyText).toContain(
      [
        "Diagnostics:",
        "Category: performance",
        "Feature area: local-knowledge",
        "Errors: 2",
        "Warnings: 3",
        "Infos: 4",
      ].join("\n"),
    );
    expect(url.searchParams.get("evidence")).toContain(
      [
        "Diagnostics:",
        "Category: performance",
        "Feature area: local-knowledge",
        "Errors: 2",
        "Warnings: 3",
        "Infos: 4",
      ].join("\n"),
    );
    expect(url.searchParams.has("category")).toBe(false);
    expect(url.searchParams.has("featureArea")).toBe(false);
    expect(url.searchParams.has("severityCounts")).toBe(false);
  });
});
