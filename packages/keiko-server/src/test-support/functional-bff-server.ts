// A functional pipeline's BFF, served on loopback, and the paired browser that drives it (#4492).
// Every state-changing coding-runtime route binds to the launcher-attested app session (ADR-0141
// D1/D2), so a pipeline redeems one session lazily and presents it, with the CSRF header and its
// own origin, on every later POST. The pair endpoint is the one path that presents no cookie: it is
// what mints one. Shared fixture modules live under `src/test-support/` (KEIKO-0130): outside the
// build, coverage and Sonar scope, and outside the coding-runtime egress rule, which binds product
// code that must never open a socket of its own.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { fakePairingRequestBody } from "../coding-app-session/_support.js";
import {
  FUNCTIONAL_MODEL_ACTIVATION,
  productionDiscoveryBffDeps,
  type DiscoveryBffDepsInput,
} from "../coding-runtime/productionOpenCodeBackend.functional/_support.js";
import type { UiHandlerDeps } from "../deps.js";
import { createUiServer, UI_HOST } from "../server.js";

export const FUNCTIONAL_PAIR_PATH = "/api/coding-workbench/app-session/pair";

/** A check every response of a pipeline passes, such as a suite's redaction canaries. */
export type FunctionalResponseCheck = (response: Response) => void;

const sessions = new Map<string, Promise<string>>();

/** The app-session cookie of the pipeline at `base`, paired on first use. */
export function functionalSessionCookie(
  base: string,
  check?: FunctionalResponseCheck,
): Promise<string> {
  const existing = sessions.get(base);
  if (existing !== undefined) return existing;
  const minted = pairFunctionalSession(base, check);
  sessions.set(base, minted);
  return minted;
}

async function pairFunctionalSession(
  base: string,
  check: FunctionalResponseCheck | undefined,
): Promise<string> {
  const response = await functionalPost(
    base,
    FUNCTIONAL_PAIR_PATH,
    fakePairingRequestBody(),
    check,
  );
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (response.status !== 200 || cookie === undefined) {
    throw new Error(`functional-app-session-pairing-failed:${String(response.status)}`);
  }
  return cookie;
}

/** A state-changing request as the paired Workbench sends it. */
export async function functionalPost(
  base: string,
  path: string,
  body: unknown,
  check?: FunctionalResponseCheck,
): Promise<Response> {
  const cookie =
    path === FUNCTIONAL_PAIR_PATH ? undefined : await functionalSessionCookie(base, check);
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Keiko-CSRF": "1",
      Origin: base,
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
    body: JSON.stringify(body),
  });
  check?.(response);
  return response;
}

/** A loopback port that was free a moment ago, for a server the pipeline starts next. */
export async function reserveLoopbackPort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, UI_HOST, resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
  return port;
}

/**
 * Activates the pipeline's chat model the way a person does in Settings > Models before a first
 * run. A fresh server process starts with every chat model inactive, and a run for an inactive
 * model is refused `CODING_RUNTIME_MODEL_UNAVAILABLE` (ADR-0171 D2, amended 2026-11-16).
 */
export async function activateFunctionalModel(
  base: string,
  check?: FunctionalResponseCheck,
): Promise<void> {
  const activated = await functionalPost(
    base,
    "/api/gateway/readiness",
    FUNCTIONAL_MODEL_ACTIVATION,
    check,
  );
  if (activated.status !== 200) {
    throw new Error(
      `functional-model-activation-failed:${String(activated.status)}:${await activated.text()}`,
    );
  }
}

/** A served production-discovery BFF and the one way to end it. */
export interface FunctionalDiscoveryServer {
  readonly baseUrl: string;
  readonly deps: UiHandlerDeps;
  /** Shuts the control plane down, disposes the composition and closes the server. */
  readonly close: () => Promise<void>;
}

/**
 * Boots the BFF with production composition only (`productionDiscoveryBffDeps`) on a loopback
 * port, serves it, and activates its chat model the way a person does before a first run.
 */
export async function startFunctionalDiscoveryServer(
  input: Omit<DiscoveryBffDepsInput, "uiPort"> & {
    readonly staticRoot: string;
    readonly check?: FunctionalResponseCheck;
  },
): Promise<FunctionalDiscoveryServer> {
  const { staticRoot, check, ...depsInput } = input;
  const port = await reserveLoopbackPort();
  const deps = productionDiscoveryBffDeps({ ...depsInput, uiPort: port });
  const server = createUiServer({ staticRoot, csp: "default-src 'none'", port, handlerDeps: deps });
  await new Promise<void>((resolve) => server.listen(port, UI_HOST, resolve));
  const close = async (): Promise<void> => {
    await deps.codingRuntimeOrchestrator?.shutdown();
    await deps.dispose?.();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };
  const baseUrl = `http://${UI_HOST}:${String(port)}`;
  try {
    await activateFunctionalModel(baseUrl, check);
  } catch (error) {
    await close();
    throw error;
  }
  return { baseUrl, deps, close };
}
