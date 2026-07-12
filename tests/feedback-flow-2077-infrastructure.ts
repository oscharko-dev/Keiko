import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Pool } from "pg";
import {
  FEEDBACK_INTAKE_RECEIPT_PATH_PREFIX_V1,
  FEEDBACK_RECEIPT_AUTH_SCHEME_V1,
} from "@oscharko-dev/keiko-contracts/feedback-intake";

import { buildCspHeader } from "../packages/keiko-server/src/csp.js";
import { buildRedactor, type UiHandlerDeps } from "../packages/keiko-server/src/deps.js";
import { createFeedbackSubmissionHttpPort } from "../packages/keiko-server/src/feedback-submission-http.js";
import { createRunRegistry } from "../packages/keiko-server/src/runs.js";
import { createUiServer, UI_HOST } from "../packages/keiko-server/src/server.js";
import { createInMemoryUiStore } from "../packages/keiko-server/src/store/index.js";
import {
  DEFAULT_TEST_LIMITS,
  validateIntakeLimits,
} from "../packages/keiko-feedback-intake/src/config.js";
import { createFeedbackIntakeHttpHandler } from "../packages/keiko-feedback-intake/src/http.js";
import {
  PostgresIntakeRepository,
  type PgClientLike,
  type PgPoolLike,
  type PgQueryResult,
} from "../packages/keiko-feedback-intake/src/postgres.js";
import { createPostgresFeedbackIntake } from "../packages/keiko-feedback-intake/src/production-service.js";
import type { IntakeSecretProvider } from "../packages/keiko-feedback-intake/src/types.js";

import {
  BENIGN_CANARY,
  NOW,
  SENSITIVE_CANARY,
  type PreparedFeedback,
  type StartedServer,
  type StoredPayload,
  type SubmittedFeedback,
} from "./feedback-flow-2077-common.js";

interface StartedBff extends StartedServer {
  readonly cleanup: () => Promise<void>;
}

export interface FeedbackFlowHarness {
  readonly pool: Pool;
  readonly installationPool: Pool;
  readonly schema: string;
  readonly scopedPool: PgPoolLike;
  readonly installationScopedPool: PgPoolLike;
  readonly bff: StartedBff;
  readonly intake: StartedServer;
  readonly close: () => Promise<void>;
}

export type IntakeMode =
  { readonly kind: "available"; readonly perIdentity?: number } | { readonly kind: "unavailable" };

export function scopedPool(pool: Pool, schema: string): PgPoolLike {
  return {
    connect: async (): Promise<PgClientLike> => {
      const client = await pool.connect();
      await client.query(`SET search_path TO "${schema}"`);
      return createScopedClient(client);
    },
  };
}

function createScopedClient(client: PgClientLike): PgClientLike {
  return {
    query: async <Row extends object = Record<string, never>>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<PgQueryResult<Row>> => {
      const result = await client.query<Row>(text, values);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    release: (error?: Error): void => {
      client.release(error);
    },
  };
}

export async function createFeedbackFlowHarness(
  databaseUrl: string,
  intakeMode: IntakeMode = { kind: "available" },
): Promise<FeedbackFlowHarness> {
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const installationPool = new Pool({ connectionString: databaseUrl, max: 2 });
  const schema = await createSchema(pool);
  const scoped = scopedPool(pool, schema);
  const intake = await startIntake(scoped, intakeMode);
  const bff = await startBff(intake.origin);
  return {
    pool,
    installationPool,
    schema,
    scopedPool: scoped,
    installationScopedPool: scopedPool(installationPool, schema),
    bff,
    intake,
    close: async (): Promise<void> => {
      await close(bff.server);
      await bff.cleanup();
      await close(intake.server);
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await Promise.all([pool.end(), installationPool.end()]);
    },
  };
}

async function createSchema(pool: Pool): Promise<string> {
  const schema = `feedback_flow_${randomUUID().replaceAll("-", "")}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await applyMigrations(client);
    return schema;
  } finally {
    client.release();
  }
}

async function applyMigrations(client: PgClientLike): Promise<void> {
  for (const name of migrationNames()) {
    await client.query(
      await readFile(
        join(process.cwd(), "packages", "keiko-feedback-intake", "migrations", name),
        "utf8",
      ),
    );
  }
}

function migrationNames(): readonly string[] {
  return [
    "001_feedback_intake.sql",
    "002_feedback_review.sql",
    "003_feedback_publication.sql",
    "004_feedback_publication_worker.sql",
    "005_feedback_publication_circuit.sql",
  ];
}

export async function listen(server: Server): Promise<StartedServer> {
  await listenOnPort(server, 0);
  const address = server.address() as AddressInfo;
  return { origin: `http://${UI_HOST}:${String(address.port)}`, server };
}

async function listenOnPort(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(port, UI_HOST, resolve);
  });
}

export async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error): void => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function secretProvider(fill: number): IntakeSecretProvider {
  const key = Object.freeze({
    id: `feedback-flow-${String(fill)}`,
    key: new Uint8Array(32).fill(fill),
    activatedAt: new Date(0),
  });
  return { snapshot: () => ({ active: key, predecessors: [] }) };
}

function intakeService(
  pool: PgPoolLike,
  perIdentity?: number,
): ReturnType<typeof createPostgresFeedbackIntake> {
  const limits = intakeLimits(perIdentity);
  return createPostgresFeedbackIntake({
    repository: new PostgresIntakeRepository(pool),
    limits,
    abuseKeys: secretProvider(1),
    dedupeKeys: secretProvider(2),
    now: () => NOW,
    logger: { event: (): void => undefined },
    metrics: { increment: (): void => undefined },
  });
}

async function startIntake(pool: PgPoolLike, mode: IntakeMode): Promise<StartedServer> {
  if (mode.kind === "unavailable") return startUnavailableIntake();
  const handler = createFeedbackIntakeHttpHandler({
    service: intakeService(pool, mode.perIdentity),
    limits: intakeLimits(mode.perIdentity),
    proxy: { family: "forwarded", trustedCidrs: [] },
  });
  return listen(
    createServer((request, response): void => {
      void handler(request, response);
    }),
  );
}

function intakeLimits(perIdentity?: number): ReturnType<typeof validateIntakeLimits> {
  return validateIntakeLimits({
    ...DEFAULT_TEST_LIMITS,
    perIdentity: perIdentity ?? DEFAULT_TEST_LIMITS.perIdentity,
    storageDeadlineMs: 2_000,
  });
}

async function startUnavailableIntake(): Promise<StartedServer> {
  return listen(
    createServer((_request, response): void => {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "temporarily-unavailable" }));
    }),
  );
}

function handlerDeps(intakeOrigin: string): UiHandlerDeps {
  const port = createFeedbackSubmissionHttpPort({
    origin: "https://intake.example.test",
    timeoutMs: 2_000,
    fetch: async (url, options): Promise<Response> => {
      if (url !== "https://intake.example.test/v1/feedback/reports") {
        throw new Error("Unexpected feedback intake target");
      }
      return fetch(`${intakeOrigin}/v1/feedback/reports`, forwardingOptions(options));
    },
  });
  if (port === undefined) throw new Error("Feedback submission port must be configured");
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): string => "",
      list: (): [] => [],
      get: (): undefined => undefined,
      delete: (): undefined => undefined,
    },
    env: {},
    redactor: buildRedactor({}),
    redactionSecrets: [SENSITIVE_CANARY],
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store: createInMemoryUiStore(),
    feedbackSubmission: port,
  };
}

function forwardingOptions(options: RequestInit): RequestInit {
  const request: RequestInit = {};
  if (options.method !== undefined) request.method = options.method;
  if (options.headers !== undefined) request.headers = options.headers;
  if (options.body !== undefined) request.body = options.body;
  return request;
}

async function startBff(intakeOrigin: string): Promise<StartedBff> {
  const staticRoot = await mkdtemp(join(tmpdir(), "keiko-feedback-flow-"));
  const probe = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port: 0,
    handlerDeps: handlerDeps(intakeOrigin),
  });
  const reserved = await listen(probe);
  const port = Number(new URL(reserved.origin).port);
  await close(reserved.server);
  const server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port,
    handlerDeps: handlerDeps(intakeOrigin),
  });
  await listenOnPort(server, port);
  return {
    origin: `http://${UI_HOST}:${String(port)}`,
    server,
    cleanup: async (): Promise<void> => rm(staticRoot, { recursive: true, force: true }),
  };
}

export async function previewAndSubmit(origin: string): Promise<SubmittedFeedback> {
  const previewResponse = await preview(origin, positiveDraft());
  const previewText = await previewResponse.text();
  if (!previewResponse.ok) throw new Error(`Feedback preview was rejected: ${previewText}`);
  const prepared = JSON.parse(previewText) as PreparedFeedback;
  if (prepared.canonicalJson.includes(SENSITIVE_CANARY)) {
    throw new Error("Prepared feedback retained the sensitive canary");
  }
  if (!prepared.canonicalJson.includes(BENIGN_CANARY)) {
    throw new Error("Prepared feedback removed the benign false-positive canary");
  }
  const submitted = await submitPrepared(origin, prepared);
  const submittedText = await submitted.text();
  const outcome = JSON.parse(submittedText) as {
    readonly outcome?: string;
    readonly receipt?: SubmittedFeedback["receipt"];
  };
  if (!submitted.ok || outcome.outcome !== "accepted" || outcome.receipt === undefined) {
    throw new Error(`Feedback submission was not accepted: ${submittedText}`);
  }
  if (
    submittedText.includes(prepared.canonicalJson) ||
    submittedText.includes(SENSITIVE_CANARY) ||
    submittedText.includes(BENIGN_CANARY)
  ) {
    throw new Error("Feedback admission response echoed report content");
  }
  return { ...prepared, receipt: outcome.receipt };
}

export async function receiptIsContentFree(
  intakeOrigin: string,
  submitted: SubmittedFeedback,
): Promise<boolean> {
  const response = await fetch(
    `${intakeOrigin}${FEEDBACK_INTAKE_RECEIPT_PATH_PREFIX_V1}${submitted.receipt.receiptId}`,
    {
      headers: {
        Authorization: `${FEEDBACK_RECEIPT_AUTH_SCHEME_V1} ${submitted.receipt.receiptSecret}`,
      },
    },
  );
  const text = await response.text();
  if (!response.ok) return false;
  const body = JSON.parse(text) as Record<string, unknown>;
  return (
    Object.keys(body).sort().join(",") === "expiresAt,receiptId,status" &&
    body.receiptId === submitted.receipt.receiptId &&
    body.status === "received" &&
    !text.includes(submitted.canonicalJson) &&
    !text.includes(SENSITIVE_CANARY) &&
    !text.includes(BENIGN_CANARY)
  );
}

export function requestHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "X-Keiko-CSRF": "1" };
}

export function safeDraft(): Record<string, string> {
  return {
    schemaVersion: "1",
    category: "defect",
    title: "Feedback flow negative contract",
    description: "The governed report is safe to submit.",
    reproductionSteps: "Open Settings and submit feedback.",
    expectedBehavior: "The report is handled safely.",
    actualBehavior: "The scenario is exercised.",
    productVersion: "0.2.15",
    platform: "Linux",
    featureArea: "model-configuration",
    impact: "Degrades core workflow",
  };
}

function positiveDraft(): Record<string, string> {
  return {
    ...safeDraft(),
    title: BENIGN_CANARY,
    description: `The governed report reaches maintainer review at ${SENSITIVE_CANARY}.`,
    expectedBehavior: "The report is reviewed before publication.",
    actualBehavior: "The report is ready for review.",
  };
}

export async function preview(
  origin: string,
  draft: Record<string, string> = safeDraft(),
): Promise<Response> {
  return fetch(`${origin}/api/feedback/preview`, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify(draft),
  });
}

export async function submitPrepared(
  origin: string,
  prepared: PreparedFeedback,
): Promise<Response> {
  const body = JSON.stringify({
    canonicalJson: prepared.canonicalJson,
    exactBodySha256: prepared.exactBodySha256,
  });
  return fetch(`${origin}/api/feedback/submit`, {
    method: "POST",
    headers: requestHeaders(),
    body,
  });
}

export async function storedPayload(pool: Pool, schema: string): Promise<StoredPayload> {
  const result = await pool.query<StoredPayload>(
    `SELECT id,exact_body_sha256 AS "exactBodySha256",canonical_bytes AS "canonicalBytes" FROM "${schema}".feedback_payloads`,
  );
  const payload = result.rows[0];
  if (payload === undefined) throw new Error("Expected one stored feedback payload");
  return payload;
}

export async function payloadCount(pool: Pool, schema: string): Promise<number> {
  const result = await pool.query<{ readonly count: string }>(
    `SELECT count(*)::text AS count FROM "${schema}".feedback_payloads`,
  );
  return Number(result.rows[0]?.count ?? "0");
}
