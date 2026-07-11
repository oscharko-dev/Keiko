import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCspHeader } from "./csp.js";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  type UiHandlerDeps,
} from "./index.js";
import { createUiServer, UI_HOST } from "./server.js";
import type { FeedbackSubmissionPortOutcome } from "./feedback-submission.js";

interface RawResponse {
  readonly status: number;
  readonly text: string;
}

let server: Server;
let staticRoot: string;
let baseUrl: string;
let submissionCalls: number;

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
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    feedbackSubmission: {
      submit: (): Promise<FeedbackSubmissionPortOutcome> => {
        submissionCalls += 1;
        return Promise.resolve({
          outcome: "accepted" as const,
          receipt: {
            receiptId: "A".repeat(22),
            receiptSecret: "A".repeat(43),
            expiresAt: "2026-08-10T00:00:00.000Z",
          },
        });
      },
    },
    store: createInMemoryUiStore(),
  };
}

async function closeServer(candidate: Server): Promise<void> {
  await new Promise<void>((resolve) =>
    candidate.close(() => {
      resolve();
    }),
  );
}

async function rawPost(path: string, bytes: Uint8Array): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const req = request(
      `${baseUrl}${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(bytes.byteLength),
          Origin: baseUrl,
          "X-Keiko-CSRF": "1",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(bytes);
  });
}

beforeEach(async () => {
  submissionCalls = 0;
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-feedback-decoder-"));
  const deps = handlerDeps();
  const probe = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port: 0,
    handlerDeps: deps,
  });
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

function expectContentFreeInvalid(response: RawResponse, sentinel: string): void {
  expect(response.status).toBe(400);
  expect(JSON.parse(response.text)).toEqual({
    error: {
      code: "FEEDBACK_REQUEST_INVALID",
      message: "The feedback request is invalid.",
    },
  });
  expect(response.text).not.toContain(sentinel);
}

describe("feedback-only strict request decoder", () => {
  it("rejects malformed UTF-8 before preview parsing", async () => {
    const prefix = Buffer.from('{"title":"utf8-', "utf8");
    const suffix = Buffer.from('"}', "utf8");
    const bytes = Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix]);

    expectContentFreeInvalid(await rawPost("/api/feedback/preview", bytes), "utf8-");
  });

  it.each(["/api/feedback/preview", "/api/feedback/submit", "/api/feedback/revalidate"])(
    "rejects duplicate object keys on %s before route parsing",
    async (path) => {
      const sentinel = "duplicate-private-value";
      const bytes = Buffer.from(
        `{"canonicalJson":"{}","canonicalJson":"${sentinel}","exactBodySha256":"${"0".repeat(64)}"}`,
        "utf8",
      );

      expectContentFreeInvalid(await rawPost(path, bytes), sentinel);
      expect(submissionCalls).toBe(0);
    },
  );

  it("rejects duplicate keys nested inside a preview draft", async () => {
    const sentinel = "nested-private-value";
    const bytes = Buffer.from(
      `{"schemaVersion":"1","diagnostics":{"errors":1,"errors":"${sentinel}"}}`,
      "utf8",
    );

    expectContentFreeInvalid(await rawPost("/api/feedback/preview", bytes), sentinel);
  });

  it("rejects escaped duplicate keys and excessive nesting with the same closed error", async () => {
    const duplicate = Buffer.from('{"title":"safe","t\\u0069tle":"private"}', "utf8");
    const nested = Buffer.from(`{"value":${"[".repeat(65)}0${"]".repeat(65)}}`, "utf8");

    expectContentFreeInvalid(await rawPost("/api/feedback/preview", duplicate), "private");
    expectContentFreeInvalid(await rawPost("/api/feedback/preview", nested), "value");
  });
});
