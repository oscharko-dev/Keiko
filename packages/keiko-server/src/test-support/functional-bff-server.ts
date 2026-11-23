// A functional pipeline's BFF, served on loopback, and the paired browser that drives it (#4492).
// Every state-changing coding-runtime route binds to the launcher-attested app session (ADR-0141
// D1/D2), so a pipeline redeems one session lazily and presents it, with the CSRF header and its
// own origin, on every later POST. The pair endpoint is the one path that presents no cookie: it is
// what mints one. Shared fixture modules live under `src/test-support/` (KEIKO-0130): outside the
// build, coverage and Sonar scope, and outside the coding-runtime egress rule, which binds product
// code that must never open a socket of its own.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type {
  GatewayRequest,
  GatewayStreamChunk,
  NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";

import { fakePairingRequestBody } from "../coding-app-session/_support.js";
import {
  functionalGatewayConfig,
  productionDiscoveryBffDeps,
  type DiscoveryBffDepsInput,
} from "../coding-runtime/productionOpenCodeBackend.functional/_support.js";
import type { UiHandlerDeps } from "../deps.js";
import { createUiServer, UI_HOST } from "../server.js";

export const FUNCTIONAL_PAIR_PATH = "/api/coding-workbench/app-session/pair";

/**
 * The one chat model of the functional gateway configuration, which owns its id. A test-support
 * module imports no other test-support module (ADR-0019 trust rule 8), so this one owns it for the
 * pipeline, its scripted models and the e2e suites.
 */
export function functionalChatModelId(): string {
  const chat = functionalGatewayConfig().capabilities?.find(
    (capability) => capability.kind === "chat",
  );
  if (chat === undefined) throw new Error("functional-chat-model-missing");
  return chat.id;
}

/**
 * The body of the explicit check Settings > Models sends to activate the chat model. Since
 * ADR-0171 D2 (amended 2026-11-16) every chat model is inactive in a fresh server process.
 */
const FUNCTIONAL_MODEL_ACTIVATION = Object.freeze({
  modelId: functionalChatModelId(),
  options: Object.freeze({ probes: Object.freeze(["chat"]) }),
});

/**
 * The deps with their coding-sidecar chat seams answered by `respond`, streamed as a real model
 * streams: the content as a delta before the terminal chunk.
 */
export function withFunctionalChat(
  deps: UiHandlerDeps,
  respond: (request: GatewayRequest) => NormalizedResponse,
): UiHandlerDeps {
  const chat = (request: GatewayRequest): Promise<NormalizedResponse> =>
    Promise.resolve(respond(request));
  return {
    ...deps,
    codingSidecarGatewayChatFactory: () => chat,
    codingSidecarGatewayChatStreamFactory: () =>
      async function* (request: GatewayRequest): AsyncIterable<GatewayStreamChunk> {
        const response = await chat(request);
        if (response.content.length > 0) yield { type: "delta" as const, token: response.content };
        yield { type: "done" as const, response };
      },
  };
}

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

/**
 * A loopback port that was free a moment ago, for a server the pipeline starts next. Another
 * process can take it before that server binds; `listenOnLoopback` then rejects instead of
 * leaving an unhandled `error` event, and `startFunctionalDiscoveryServer` tries a new port.
 */
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

/** Binds `server` to `port` on loopback; rejects when the bind fails (such as `EADDRINUSE`). */
export function listenOnLoopback(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, UI_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
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

/** How often a server start tries a new port after another process took the reserved one. */
const FUNCTIONAL_LISTEN_ATTEMPTS = 3;

type FunctionalDiscoveryServerInput = Omit<DiscoveryBffDepsInput, "uiPort"> & {
  readonly staticRoot: string;
  readonly check?: FunctionalResponseCheck;
  /** Answers the coding-sidecar model calls in place of the functional script (`withFunctionalChat`). */
  readonly respond?: (request: GatewayRequest) => NormalizedResponse;
};

/**
 * Boots the BFF with production composition only (`productionDiscoveryBffDeps`) on a loopback
 * port, serves it, and activates its chat model the way a person does before a first run.
 */
export async function startFunctionalDiscoveryServer(
  input: FunctionalDiscoveryServerInput,
  attempt = 1,
): Promise<FunctionalDiscoveryServer> {
  const { staticRoot, check, respond, ...depsInput } = input;
  const port = await reserveLoopbackPort();
  const composed = productionDiscoveryBffDeps({ ...depsInput, uiPort: port });
  const deps = respond === undefined ? composed : withFunctionalChat(composed, respond);
  const server = createUiServer({ staticRoot, csp: "default-src 'none'", port, handlerDeps: deps });
  try {
    await listenOnLoopback(server, port);
  } catch (error) {
    // A failed disposal must not hide why the server could not listen.
    await disposeFunctionalDeps(deps).catch((disposeError: unknown) => {
      throw new AggregateError([error, disposeError], "functional-server-listen-failed");
    });
    const taken = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
    if (taken && attempt < FUNCTIONAL_LISTEN_ATTEMPTS) {
      return startFunctionalDiscoveryServer(input, attempt + 1);
    }
    throw error;
  }
  const baseUrl = `http://${UI_HOST}:${String(port)}`;
  const close = async (): Promise<void> => {
    // A later server may bind the same port; it must pair its own session, not reuse this one's.
    sessions.delete(baseUrl);
    await disposeFunctionalDeps(deps);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };
  try {
    await activateFunctionalModel(baseUrl, check);
  } catch (error) {
    await close();
    throw error;
  }
  return { baseUrl, deps, close };
}

async function disposeFunctionalDeps(deps: UiHandlerDeps): Promise<void> {
  await deps.codingRuntimeOrchestrator?.shutdown();
  await deps.dispose?.();
}
