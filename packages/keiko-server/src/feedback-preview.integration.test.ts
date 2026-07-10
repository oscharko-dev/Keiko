import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  FeedbackDispositionRecordV1,
  FeedbackReportV1,
} from "@oscharko-dev/keiko-contracts/feedback-report";
import { FEEDBACK_REPORT_LIMITS } from "@oscharko-dev/keiko-contracts/feedback-report";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCspHeader } from "./csp.js";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  type UiHandlerDeps,
} from "./index.js";
import { createUiServer, UI_HOST } from "./server.js";

const CONFIGURED_SECRET = "internal.corp.example";

interface FeedbackPreviewResponse {
  readonly report: FeedbackReportV1;
  readonly canonicalJson: string;
  readonly exactBodySha256: string;
  readonly dispositionSidecar: {
    readonly exactBodySha256: string;
    readonly records: readonly FeedbackDispositionRecordV1[];
  };
}

let server: Server;
let staticRoot: string;
let port: number;

async function listen(candidate: Server): Promise<number> {
  await new Promise<void>((resolve) => candidate.listen(0, UI_HOST, resolve));
  return (candidate.address() as AddressInfo).port;
}

async function closeServer(candidate: Server = server): Promise<void> {
  await new Promise<void>((resolve) =>
    candidate.close(() => {
      resolve();
    }),
  );
}

function handlerDeps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): string => "",
      list: (): readonly string[] => [],
      get: (): string | undefined => undefined,
      delete: (): void => undefined,
    },
    env: {},
    redactor: buildRedactor({}),
    redactionSecrets: [CONFIGURED_SECRET],
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store: createInMemoryUiStore(),
  };
}

function validDraft(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    category: "defect",
    title: "Feedback attachment regression",
    description: "The feedback flow remains safe.",
    reproductionSteps: "Open Settings and preview feedback.",
    expectedBehavior: "The preview should be safe.",
    actualBehavior: "The preview was generated.",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "model-configuration",
    impact: "Degrades core workflow",
    ...overrides,
  };
}

async function postPreview(draft: Record<string, unknown>): Promise<Response> {
  return fetch(`http://${UI_HOST}:${String(port)}/api/feedback/preview`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
    },
    body: JSON.stringify(draft),
  });
}

beforeEach(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-feedback-preview-"));
  const deps = handlerDeps();
  const probe = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps: deps });
  port = await listen(probe);
  await closeServer(probe);
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port, handlerDeps: deps });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
});

afterEach(async () => {
  await closeServer();
  await rm(staticRoot, { recursive: true, force: true });
});

describe("POST /api/feedback/preview", () => {
  it("keeps independently safe title and description unchanged in the exact prepared body", async () => {
    const response = await fetch(`http://${UI_HOST}:${String(port)}/api/feedback/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Keiko-CSRF": "1",
      },
      body: JSON.stringify({
        schemaVersion: "1",
        category: "defect",
        title: "Bearer",
        description: "The login button remained disabled",
        reproductionSteps: "Open the sign-in window and select Continue.",
        expectedBehavior: "The login window should continue.",
        actualBehavior: "The login button remained disabled.",
        productVersion: "0.2.14",
        platform: "macOS",
        featureArea: "model-configuration",
        impact: "Degrades core workflow",
      }),
    });
    const body = (await response.json()) as FeedbackPreviewResponse;

    expect(response.status).toBe(200);
    expect(body.report.summary).toEqual({
      title: "Bearer",
      description: "The login button remained disabled",
    });
    expect(JSON.parse(body.canonicalJson)).toEqual(body.report);
    expect(body.exactBodySha256).toBe(
      createHash("sha256").update(body.canonicalJson, "utf8").digest("hex"),
    );
    expect(body.dispositionSidecar).toEqual({
      exactBodySha256: body.exactBodySha256,
      records: [],
    });
  });

  it("returns only a safe canonical projection and content-free closed dispositions", async () => {
    const completeSecret = "opaque-auth-value";
    const optionalSecret = "opaque-optional-value";
    const response = await fetch(`http://${UI_HOST}:${String(port)}/api/feedback/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Keiko-CSRF": "1",
      },
      body: JSON.stringify({
        schemaVersion: "1",
        category: "defect",
        title: "Feedback privacy regression",
        description: `Connection to ${CONFIGURED_SECRET} failed.`,
        reproductionSteps: "Open Settings and retry the connection.",
        expectedBehavior: "The connection should succeed.",
        actualBehavior: `Safe prefix Bearer "${completeSecret}" safe suffix`,
        productVersion: "0.2.14",
        platform: "Linux",
        featureArea: "model-configuration",
        browserDescription: `"password=${optionalSecret}"`,
        impact: "Degrades core workflow",
      }),
    });
    const body = (await response.json()) as FeedbackPreviewResponse;
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.report.summary.description).toBe("Connection to [REDACTED] failed.");
    expect(body.report.actualResult).toContain("Safe prefix");
    expect(body.report.actualResult).toContain("safe suffix");
    expect(body.report).not.toHaveProperty("browserDescription");
    expect(serialized).not.toContain(CONFIGURED_SECRET);
    expect(serialized).not.toContain(completeSecret);
    expect(serialized).not.toContain(optionalSecret);
    expect(body.dispositionSidecar.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "redacted",
          reason: "complete-sensitive-span",
          target: { kind: "draft-field", field: "description" },
        }),
        expect.objectContaining({
          action: "redacted",
          reason: "complete-sensitive-span",
          target: { kind: "draft-field", field: "actualBehavior" },
        }),
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
      ]),
    );
    for (const record of body.dispositionSidecar.records) {
      expect(Object.keys(record).sort()).toEqual(["action", "reason", "target", "unitKind"]);
      expect(["redacted", "quarantined", "omitted"]).toContain(record.action);
      expect([
        "complete-sensitive-span",
        "ambiguous-credential-structure",
        "no-safe-optional-content",
      ]).toContain(record.reason);
      expect(["quoted-segment", "structured-value", "line-remainder", "optional-field"]).toContain(
        record.unitKind,
      );
    }
  });

  it("decodes bounded browser attachments and omits an exhausted optional attachment", async () => {
    const removedSecret = "opaque-attachment-value";
    const removedText = `"password=${removedSecret}"`;
    const safeText = "Safe attachment remains";
    const response = await postPreview(
      validDraft({
        attachments: [
          {
            bytesBase64: Buffer.from(removedText, "utf8").toString("base64"),
            declaredMediaType: "text/plain",
            extension: ".txt",
          },
          {
            bytesBase64: Buffer.from(safeText, "utf8").toString("base64"),
            declaredMediaType: "text/plain; charset=utf-8",
            extension: "txt",
          },
        ],
      }),
    );
    const body = (await response.json()) as FeedbackPreviewResponse;
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.report.attachments).toEqual([safeText]);
    expect(body.dispositionSidecar.records).toEqual([
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
    expect(serialized).not.toContain(removedSecret);
    expect(serialized).not.toContain("bytesBase64");
    expect(serialized).not.toContain("declaredMediaType");
    expect(serialized).not.toContain("extension");
  });

  it("enforces exact attachment byte, aggregate, and count caps", async () => {
    const exactBytes = Buffer.alloc(FEEDBACK_REPORT_LIMITS.attachmentBytes, 97);
    const exactEnvelope = { bytesBase64: exactBytes.toString("base64") };
    const exact = await postPreview(validDraft({ attachments: [exactEnvelope, exactEnvelope] }));
    const exactBody = (await exact.json()) as FeedbackPreviewResponse;

    expect(exact.status).toBe(200);
    expect(exactBody.report.attachments).toHaveLength(2);
    expect(exactBody.report.attachments?.[0]).toHaveLength(FEEDBACK_REPORT_LIMITS.attachmentBytes);

    const overPerAttachment = await postPreview(
      validDraft({
        attachments: [
          {
            bytesBase64: Buffer.alloc(FEEDBACK_REPORT_LIMITS.attachmentBytes + 4, 97).toString(
              "base64",
            ),
          },
        ],
      }),
    );
    const overAggregate = await postPreview(
      validDraft({ attachments: [exactEnvelope, exactEnvelope, { bytesBase64: "YQ==" }] }),
    );
    const overCount = await postPreview(
      validDraft({
        attachments: Array.from({ length: FEEDBACK_REPORT_LIMITS.attachmentCount + 1 }, () => ({
          bytesBase64: "YQ==",
        })),
      }),
    );

    for (const rejected of [overPerAttachment, overAggregate, overCount]) {
      const rejectedBody = (await rejected.json()) as { readonly error: { readonly code: string } };
      expect(rejected.status).toBe(413);
      expect(rejectedBody.error.code).toBe("FEEDBACK_ATTACHMENT_LIMIT");
    }
  });

  it("rejects filename and path fields without reflecting their values", async () => {
    const privateFilename = "customer-private-finding.txt";
    const privatePath = "/Users/customer/private/finding.txt";
    const response = await postPreview(
      validDraft({
        attachments: [
          {
            bytesBase64: "U2FmZSB0ZXh0",
            filename: privateFilename,
            path: privatePath,
          },
        ],
      }),
    );
    const serialized = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(serialized)).toMatchObject({
      error: { code: "FEEDBACK_ATTACHMENT_ENVELOPE_INVALID" },
    });
    expect(serialized).not.toContain(privateFilename);
    expect(serialized).not.toContain(privatePath);
  });

  it.each([
    [
      "base64 whitespace",
      { bytesBase64: "U2Fm ZQ==" },
      400,
      "FEEDBACK_ATTACHMENT_ENVELOPE_INVALID",
    ],
    ["base64 padding", { bytesBase64: "U2FmZQ=" }, 400, "FEEDBACK_ATTACHMENT_ENVELOPE_INVALID"],
    ["base64 trailing bits", { bytesBase64: "YR==" }, 400, "FEEDBACK_ATTACHMENT_ENVELOPE_INVALID"],
    [
      "media type bytes",
      { bytesBase64: "U2FmZQ==", declaredMediaType: `text/${"a".repeat(252)}` },
      413,
      "FEEDBACK_ATTACHMENT_LIMIT",
    ],
    [
      "extension bytes",
      { bytesBase64: "U2FmZQ==", extension: "x".repeat(65) },
      413,
      "FEEDBACK_ATTACHMENT_LIMIT",
    ],
  ] as const)(
    "rejects non-canonical or over-limit %s content-free",
    async (_label, envelope, status, code) => {
      const response = await postPreview(validDraft({ attachments: [envelope] }));
      const serialized = await response.text();

      expect(response.status).toBe(status);
      expect(JSON.parse(serialized)).toMatchObject({ error: { code } });
      for (const value of Object.values(envelope)) {
        expect(serialized).not.toContain(value);
      }
    },
  );
});
