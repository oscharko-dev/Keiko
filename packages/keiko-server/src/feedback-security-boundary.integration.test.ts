import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GatewayConfig } from "@oscharko-dev/keiko-model-gateway";
import { prepareFeedbackReportV1 } from "@oscharko-dev/keiko-security/feedback-report";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCspHeader } from "./csp.js";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  type UiHandlerDeps,
} from "./index.js";
import { createUiServer, UI_HOST } from "./server.js";

let server: Server;
let staticRoot: string;
let baseUrl: string;
let portCalls: number;
let runtimeConfig: NonNullable<UiHandlerDeps["gatewayConfig"]>;

function mutableGatewayConfig(): NonNullable<UiHandlerDeps["gatewayConfig"]> {
  let config: GatewayConfig | undefined;
  return {
    storagePath: "/tmp/keiko-feedback-security-boundary.json",
    current: () => config,
    present: () => config !== undefined,
    set: (next): void => {
      config = next;
    },
  };
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
    gatewayConfig: runtimeConfig,
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    feedbackSubmission: {
      submit: (): Promise<"accepted"> => {
        portCalls += 1;
        return Promise.resolve("accepted");
      },
    },
    store: createInMemoryUiStore(),
  };
}

function draft(title: string, description: string): Record<string, unknown> {
  return {
    schemaVersion: "1",
    category: "defect",
    title,
    description,
    reproductionSteps: "Open Settings and preview feedback.",
    expectedBehavior: "The preview should remain private when required.",
    actualBehavior: "The preview was generated.",
    productVersion: "0.2.14",
    platform: "Linux",
    featureArea: "model-configuration",
    impact: "Degrades core workflow",
  };
}

function headers(): Record<string, string> {
  return { "Content-Type": "application/json", "X-Keiko-CSRF": "1" };
}

async function post(path: string, value: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(value),
  });
}

async function closeServer(candidate: Server): Promise<void> {
  await new Promise<void>((resolve) =>
    candidate.close(() => {
      resolve();
    }),
  );
}

beforeEach(async () => {
  portCalls = 0;
  runtimeConfig = mutableGatewayConfig();
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-feedback-security-"));
  const deps = handlerDeps();
  const probe = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps: deps });
  await new Promise<void>((resolve) => probe.listen(0, UI_HOST, resolve));
  const port = (probe.address() as AddressInfo).port;
  await closeServer(probe);
  server = createUiServer({ staticRoot, csp: buildCspHeader([]), port, handlerDeps: deps });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
  baseUrl = `http://${UI_HOST}:${String(port)}`;
});

afterEach(async () => {
  await closeServer(server);
  await rm(staticRoot, { recursive: true, force: true });
});

describe("feedback security boundaries", () => {
  it("blocks high-confidence security reports before returning prepared bytes", async () => {
    const sentinel = "private-exploit-details-must-not-be-reflected";
    const response = await post(
      "/api/feedback/preview",
      draft("Security vulnerability in Keiko: authentication bypass", sentinel),
    );
    const text = await response.text();

    expect(response.status).toBe(422);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "FEEDBACK_SECURITY_REPORT",
        message: "Use the private security reporting route.",
      },
    });
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain("canonicalJson");
  });

  it.each([
    ["Password reset feedback", "The password policy text is confusing."],
    ["Security documentation", "Explain vulnerability scanning in the user guide."],
    ["Training copy", "The guide discusses SQL injection as an example."],
  ])("preserves ordinary discussion without false-positive routing", async (title, description) => {
    const response = await post("/api/feedback/preview", draft(title, description));
    expect(response.status).toBe(200);
  });

  it("repeats private routing at submit and public revalidation boundaries", async () => {
    const prepared = prepareFeedbackReportV1(
      draft("Exploit: session validation", "A proof-of-concept exploit is reproducible."),
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const envelope = {
      canonicalJson: prepared.value.canonicalJson,
      exactBodySha256: prepared.value.exactBodySha256,
    };

    const submitted = await post("/api/feedback/submit", envelope);
    const revalidated = await post("/api/feedback/revalidate", envelope);

    expect(await submitted.json()).toEqual({ outcome: "rejected" });
    expect(await revalidated.json()).toEqual({ outcome: "security" });
    expect(portCalls).toBe(0);
  });

  it("rejects a prepared body after the live redaction policy changes", async () => {
    const runtimeSecret = "secret-added-after-feedback-preview";
    const preview = await post(
      "/api/feedback/preview",
      draft("Ordinary feedback", `The value ${runtimeSecret} appears here.`),
    );
    const prepared = (await preview.json()) as {
      readonly canonicalJson: string;
      readonly exactBodySha256: string;
    };
    runtimeConfig.set(
      {
        providers: [
          {
            modelId: "feedback-model",
            baseUrl: "https://feedback.invalid/v1",
            apiKey: runtimeSecret,
            timeoutMs: 30_000,
            maxRetries: 0,
            retryBaseDelayMs: 0,
          },
        ],
        circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
      },
      true,
    );

    const response = await post("/api/feedback/revalidate", {
      canonicalJson: prepared.canonicalJson,
      exactBodySha256: prepared.exactBodySha256,
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ outcome: "rejected" });
    expect(text).not.toContain(runtimeSecret);
    expect(text).not.toContain(prepared.canonicalJson);
  });
});
