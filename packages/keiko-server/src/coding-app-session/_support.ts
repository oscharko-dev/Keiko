// TEST-ONLY support for the authenticated app-session channel (ADR-0141 D7).
//
// This file is excluded from the package build (`**/_support.ts` in tsconfig), so it is never
// compiled into `dist`, never shipped, and — because it is outside the compiled program — a
// production source file cannot import it without breaking the build. That is the structural
// guarantee that the deterministic CI pairing fake, which mints read authority, is unreachable from
// production composition. It is injected only at the `options.sessionPairingPort` seam by tests.
// The root typecheck (`packages/*/src/**/*.ts`) still type-checks this file, so its helpers stay honest.

import { mkdtempSync, realpathSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCspHeader } from "../csp.js";
import { buildUiHandlerDeps, type UiHandlerDeps } from "../deps.js";
import { createUiServer, UI_HOST } from "../server.js";
import { createInMemoryUiStore } from "../store/index.js";
import type { CodingAppSessionChannelContent } from "./channelContract.js";
import { APP_SESSION_COOKIE_NAME } from "./sessionCookie.js";
import type { CodingAppSessionContentSource } from "./sessionChannel.js";
import {
  SESSION_PAIRING_DENIED,
  isWellFormedSessionPairingAttestation,
  type SessionPairingAttestation,
  type SessionPairingDecision,
  type SessionPairingPort,
} from "./sessionPairingPort.js";
import type { AppSession } from "./sessionRegistry.js";

export interface FakeSessionPairingPortOptions {
  readonly principalLabel?: string;
  /** Predicate over the (already well-formed) attestation; default approves everything. */
  readonly shouldApprove?: (attestation: SessionPairingAttestation) => boolean;
}

/**
 * Deterministic CI pairing authority. Approves any well-formed attestation (or per `shouldApprove`)
 * so the channel is testable without a real launcher. Never constructed by production composition.
 */
export function createFakeSessionPairingPort(
  options: FakeSessionPairingPortOptions = {},
): SessionPairingPort {
  const principalLabel = options.principalLabel ?? "test-operator";
  const shouldApprove = options.shouldApprove ?? ((): boolean => true);
  return {
    attest: (attestation: SessionPairingAttestation): SessionPairingDecision => {
      if (!isWellFormedSessionPairingAttestation(attestation)) return SESSION_PAIRING_DENIED;
      return shouldApprove(attestation)
        ? { outcome: "approved", principalLabel }
        : SESSION_PAIRING_DENIED;
    },
  };
}

/** A well-formed pairing request body the fake port accepts. The claim is a dummy the fake ignores. */
export function fakePairingRequestBody(
  overrides: Partial<SessionPairingAttestation> = {},
): SessionPairingAttestation {
  return {
    requestId: overrides.requestId ?? "req_fake_pairing",
    issuedAtMs: overrides.issuedAtMs ?? 1,
    claim: overrides.claim ?? "fake-claim",
  };
}

/** A content source returning a fixed bounded payload to any paired session (journey canary). */
export function createStaticContentSource(
  content: CodingAppSessionChannelContent,
): CodingAppSessionContentSource {
  return { contentFor: (_session: AppSession): CodingAppSessionChannelContent => content };
}

export interface AppSessionTestServerOptions {
  readonly sessionPairingPort?: SessionPairingPort | undefined;
  readonly contentSource?: CodingAppSessionContentSource | undefined;
}

export interface AppSessionTestServer {
  readonly baseUrl: string;
  readonly deps: UiHandlerDeps;
  readonly close: () => Promise<void>;
}

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

async function bindServer(deps: UiHandlerDeps, staticRoot: string): Promise<Server> {
  const csp = buildCspHeader([]);
  const probe = createUiServer({ staticRoot, csp, port: 0, handlerDeps: deps });
  await new Promise<void>((resolve) => probe.listen(0, UI_HOST, resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  const server = createUiServer({ staticRoot, csp, port, handlerDeps: deps });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
  return server;
}

/**
 * Compose the real BFF (production `buildUiHandlerDeps`) with the injected pairing/content seams and
 * bind it on a loopback port. The two-step bind resolves an ephemeral port, then rebinds with that
 * exact port so the server's own loopback-authority host check (`isAllowedHost`) matches.
 */
export async function startAppSessionTestServer(
  options: AppSessionTestServerOptions = {},
): Promise<AppSessionTestServer> {
  const staticRoot = tempDir("app-session-static-");
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: tempDir("app-session-evidence-"),
    env: {},
    store: createInMemoryUiStore(),
    sessionPairingPort: options.sessionPairingPort,
    codingAppSessionContentSource: options.contentSource,
  });
  const server = await bindServer(deps, staticRoot);
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://${UI_HOST}:${String(port)}`,
    deps,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await deps.dispose?.();
    },
  };
}

/** The channel route paths, so tests never hard-code and drift from the mounted group. */
export const APP_SESSION_PATHS = {
  pair: "/api/coding-workbench/app-session/pair",
  channel: "/api/coding-workbench/app-session/channel",
  stream: "/api/coding-workbench/app-session/channel/stream",
  rotate: "/api/coding-workbench/app-session/rotate",
  signOut: "/api/coding-workbench/app-session/sign-out",
} as const;

/** Extract the `name=value` app-session cookie pair from a response's `Set-Cookie`, if present. */
export function extractSessionCookie(response: Response): string | undefined {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0]?.trim() ?? "";
    if (
      pair.startsWith(`${APP_SESSION_COOKIE_NAME}=`) &&
      pair.length > APP_SESSION_COOKIE_NAME.length + 1
    ) {
      return pair;
    }
  }
  return undefined;
}

/** Headers for a state-changing POST: CSRF envelope + JSON content type, plus an optional cookie. */
export function postHeaders(cookie?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-keiko-csrf": "1",
  };
  if (cookie !== undefined) headers.cookie = cookie;
  return headers;
}
