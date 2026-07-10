import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { expect, describe, it } from "vitest";

import { buildCspHeader } from "./csp.js";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  type UiHandlerDeps,
} from "./index.js";
import { createUiServer, UI_HOST } from "./server.js";

const CONFIGURED_SECRET = "internal.corp.example";

interface SubmissionPortDouble {
  submit(prepared: unknown): Promise<"accepted" | "rejected">;
}

interface PreviewResponse {
  readonly canonicalJson: string;
  readonly exactBodySha256: string;
}

function handlerDeps(
  feedbackSubmission?: SubmissionPortDouble,
  gatewayConfig?: NonNullable<UiHandlerDeps["gatewayConfig"]>,
): UiHandlerDeps {
  const base: UiHandlerDeps = {
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
  if (feedbackSubmission !== undefined) Object.assign(base, { feedbackSubmission });
  if (gatewayConfig !== undefined) Object.assign(base, { gatewayConfig });
  return base;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, UI_HOST, resolve));
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
}

async function withFeedbackServer<T>(
  feedbackSubmission: SubmissionPortDouble | undefined,
  useServer: (baseUrl: string) => Promise<T>,
  gatewayConfig?: NonNullable<UiHandlerDeps["gatewayConfig"]>,
): Promise<T> {
  const staticRoot = await mkdtemp(join(tmpdir(), "keiko-feedback-submit-"));
  const deps = handlerDeps(feedbackSubmission, gatewayConfig);
  const probe = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps: deps });
  const port = await listen(probe);
  await closeServer(probe);
  const server = createUiServer({ staticRoot, csp: buildCspHeader([]), port, handlerDeps: deps });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
  try {
    return await useServer(`http://${UI_HOST}:${String(port)}`);
  } finally {
    await closeServer(server);
    await rm(staticRoot, { recursive: true, force: true });
  }
}

function mutableGatewayConfig(): NonNullable<UiHandlerDeps["gatewayConfig"]> {
  let config: GatewayConfig | undefined;
  let present = false;
  return {
    storagePath: "/tmp/keiko-feedback-runtime-config.json",
    current: () => config,
    present: () => present,
    set: (next, nextPresent): void => {
      config = next;
      present = nextPresent;
    },
  };
}

function gatewayConfigWithSecret(secret: string): GatewayConfig {
  return {
    providers: [
      {
        modelId: "feedback-runtime-model",
        baseUrl: "https://feedback-runtime.example.invalid/v1",
        apiKey: secret,
        timeoutMs: 30_000,
        maxRetries: 0,
        retryBaseDelayMs: 0,
      },
    ],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
  };
}

function jsonHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "X-Keiko-CSRF": "1" };
}

async function preview(baseUrl: string): Promise<PreviewResponse> {
  const response = await fetch(`${baseUrl}/api/feedback/preview`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      schemaVersion: "1",
      category: "defect",
      title: "Feedback submission regression",
      description: "The safe preview is ready.",
      reproductionSteps: "Open Settings and preview feedback.",
      expectedBehavior: "The preview should be submitted unchanged.",
      actualBehavior: "The preview was generated.",
      productVersion: "0.2.14",
      platform: "Linux",
      featureArea: "model-configuration",
      impact: "Degrades core workflow",
    }),
  });
  expect(response.status).toBe(200);
  const prepared = (await response.json()) as PreviewResponse;
  return {
    canonicalJson: prepared.canonicalJson,
    exactBodySha256: prepared.exactBodySha256,
  };
}

async function submit(baseUrl: string, input: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/feedback/submit`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(input),
  });
}

describe("POST /api/feedback/submit", () => {
  it("uses the current runtime gateway secrets for preview and submit policy", async () => {
    const runtimeSecret = "runtime-feedback-secret-added-after-startup";
    const runtimeConfig = mutableGatewayConfig();
    let portCalls = 0;
    const port: SubmissionPortDouble = {
      submit: () => {
        portCalls += 1;
        return Promise.resolve("accepted");
      },
    };
    await withFeedbackServer(
      port,
      async (baseUrl) => {
        runtimeConfig.set(gatewayConfigWithSecret(runtimeSecret), true);
        const response = await fetch(`${baseUrl}/api/feedback/preview`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            schemaVersion: "1",
            category: "defect",
            title: "Runtime feedback redaction",
            description: `Removed literal ${CONFIGURED_SECRET}; current literal ${runtimeSecret}`,
            reproductionSteps: "Update Settings, then preview feedback.",
            expectedBehavior: "Current runtime secrets are redacted.",
            actualBehavior: "The preview was generated.",
            productVersion: "0.2.14",
            platform: "Linux",
            featureArea: "model-configuration",
            impact: "Degrades core workflow",
          }),
        });
        const prepared = (await response.json()) as PreviewResponse & {
          readonly report: { readonly summary: { readonly description: string } };
        };

        expect(response.status).toBe(200);
        expect(prepared.report.summary.description).toBe(
          `Removed literal ${CONFIGURED_SECRET}; current literal [REDACTED]`,
        );
        const unsafeJson = prepared.canonicalJson.replace("[REDACTED]", runtimeSecret);
        const unsafe = await submit(baseUrl, {
          canonicalJson: unsafeJson,
          exactBodySha256: createHash("sha256").update(unsafeJson, "utf8").digest("hex"),
        });

        expect(unsafe.status).toBe(200);
        expect(await unsafe.json()).toEqual({ outcome: "rejected" });
        expect(portCalls).toBe(0);
      },
      runtimeConfig,
    );
  });

  it("is unavailable by default without inventing a hosted contract", async () => {
    await withFeedbackServer(undefined, async (baseUrl) => {
      const prepared = await preview(baseUrl);
      const response = await submit(baseUrl, prepared);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: "unavailable" });
    });
  });

  it("passes only the independently verified immutable body to the injected port", async () => {
    const captured: unknown[] = [];
    let portOutcome: "accepted" | "rejected" = "accepted";
    const port: SubmissionPortDouble = {
      submit: (prepared) => {
        captured.push(prepared);
        return Promise.resolve(portOutcome);
      },
    };
    await withFeedbackServer(port, async (baseUrl) => {
      const prepared = await preview(baseUrl);
      const accepted = await submit(baseUrl, prepared);
      portOutcome = "rejected";
      const rejected = await submit(baseUrl, prepared);

      expect(accepted.status).toBe(200);
      expect(rejected.status).toBe(200);
      expect(await accepted.json()).toEqual({ outcome: "accepted" });
      expect(await rejected.json()).toEqual({ outcome: "rejected" });
      expect(captured).toHaveLength(2);
      for (const value of captured) {
        const verified = value as {
          readonly canonicalJson: string;
          readonly exactBodySha256: string;
          readonly canonicalBody: { copyBytes(): Uint8Array };
        };
        expect(verified.canonicalJson).toBe(prepared.canonicalJson);
        expect(verified.exactBodySha256).toBe(prepared.exactBodySha256);
        expect(new TextDecoder().decode(verified.canonicalBody.copyBytes())).toBe(
          prepared.canonicalJson,
        );
      }
    });
  });

  it("returns a content-free non-success when the submission outcome is uncertain", async () => {
    const privateFailure = "private-port-failure-must-not-be-reflected";
    const port: SubmissionPortDouble = {
      submit: () => Promise.reject(new Error(privateFailure)),
    };
    await withFeedbackServer(port, async (baseUrl) => {
      const prepared = await preview(baseUrl);
      const response = await submit(baseUrl, prepared);
      const serialized = await response.text();

      expect(response.status).toBe(502);
      expect(JSON.parse(serialized)).toEqual({
        error: {
          code: "FEEDBACK_SUBMIT_FAILED",
          message: "Feedback submission could not be confirmed.",
        },
      });
      expect(serialized).not.toContain(privateFailure);
      expect(serialized).not.toContain(prepared.canonicalJson);
    });
  });

  it("fails closed on an unknown injected-port outcome", async () => {
    const port: SubmissionPortDouble = {
      submit: () => Promise.resolve("unknown" as "accepted"),
    };
    await withFeedbackServer(port, async (baseUrl) => {
      const prepared = await preview(baseUrl);
      const response = await submit(baseUrl, prepared);

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: {
          code: "FEEDBACK_SUBMIT_FAILED",
          message: "Feedback submission could not be confirmed.",
        },
      });
    });
  });

  it("rejects digest drift, unsafe recomputation, and extra fields before the port", async () => {
    let calls = 0;
    const port: SubmissionPortDouble = {
      submit: () => {
        calls += 1;
        return Promise.resolve("accepted");
      },
    };
    await withFeedbackServer(port, async (baseUrl) => {
      const prepared = await preview(baseUrl);
      const digestDrift = await submit(baseUrl, {
        ...prepared,
        canonicalJson: `${prepared.canonicalJson} `,
      });
      const unsafeJson = prepared.canonicalJson.replace(
        "The safe preview is ready.",
        CONFIGURED_SECRET,
      );
      const unsafeRecomputed = await submit(baseUrl, {
        canonicalJson: unsafeJson,
        exactBodySha256: createHash("sha256").update(unsafeJson, "utf8").digest("hex"),
      });
      const rawSentinel = "raw-draft-must-not-cross-submit";
      const extraField = await submit(baseUrl, { ...prepared, rawDraft: rawSentinel });
      const extraSerialized = await extraField.text();

      expect(await digestDrift.json()).toEqual({ outcome: "rejected" });
      expect(await unsafeRecomputed.json()).toEqual({ outcome: "rejected" });
      expect(extraField.status).toBe(400);
      expect(JSON.parse(extraSerialized)).toMatchObject({
        error: { code: "FEEDBACK_SUBMIT_ENVELOPE_INVALID" },
      });
      expect(extraSerialized).not.toContain(rawSentinel);
      expect(calls).toBe(0);
    });
  });
});
