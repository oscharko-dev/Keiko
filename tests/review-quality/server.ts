// The real Keiko server composition the offline review gate drives (Issue #4138, ADR-0182 D9),
// started the way the dev BFF (`scripts/dev-bff.mjs`) starts it: `buildUiHandlerDeps` over the
// operator's state directory and gateway configuration, served by `createUiServer` on loopback, so
// each review instance reaches the Model Gateway through the server's own coding sidecar route.
// The only difference to a product server is `reviewEvaluationSwitches`, which only this
// composition passes. The review service is driven in process; no route is called.

import { mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";

import {
  buildCspHeader,
  buildUiHandlerDeps,
  checkActivityLogReadiness,
  createUiServer,
  UI_HOST,
  type UiHandlerDeps,
} from "@oscharko-dev/keiko-server";

import type { GateVariant } from "./cli.js";

export interface GateServerOptions {
  readonly stateDir: string;
  /** The evaluation repository, the server's initial project, as the dev BFF uses its checkout. */
  readonly repository: string;
  readonly configPath: string;
  readonly port: number;
  readonly variant: GateVariant;
  /** The process environment; the gateway credential reaches the server only through it. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface GateServer {
  readonly deps: UiHandlerDeps;
  readonly activityLogReadiness: string;
  readonly close: () => Promise<void>;
}

const SWITCHES: Readonly<
  Record<GateVariant, { readonly counterCheck: "on" | "off"; readonly swapRoles: boolean }>
> = {
  product: { counterCheck: "on", swapRoles: false },
  "roles-swapped": { counterCheck: "on", swapRoles: true },
  "counter-check-off": { counterCheck: "off", swapRoles: false },
};

/** The environment of the composition: the dev lane's runtime discovery on the server's port. */
export function gateServerEnv(options: GateServerOptions): Record<string, string | undefined> {
  return {
    ...options.env,
    KEIKO_STATE_DIR: options.stateDir,
    KEIKO_UI_DATA_DIR: join(options.stateDir, "ui"),
    KEIKO_MEMORY_DIR: join(options.stateDir, "memory"),
    KEIKO_CODING_RUNTIME_DEV_LANE: "1",
    KEIKO_UI_PORT: String(options.port),
    KEIKO_REVIEW_ENABLED: "true",
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, UI_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** Starts the composition and resolves once it listens. */
export async function startGateServer(options: GateServerOptions): Promise<GateServer> {
  const env = gateServerEnv(options);
  // The process-wide Activity Log writer reads its directory from `process.env`, as under `keiko ui`.
  process.env.KEIKO_STATE_DIR = options.stateDir;
  const staticRoot = join(options.stateDir, "static-placeholder");
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(
    join(staticRoot, "index.html"),
    "<!doctype html><title>Keiko review gate</title>\n",
  );
  const deps = buildUiHandlerDeps({
    configPath: options.configPath,
    evidenceDir: undefined,
    uiDbPath: undefined,
    env,
    initialProjectPath: options.repository,
    closeActivityLogOnDispose: true,
    reviewEvaluationSwitches: SWITCHES[options.variant],
  });
  // As the dev BFF does: a real write probe persisted as `activity-log.readiness`; the gate records
  // the result with its evidence instead of refusing to start.
  const readiness = checkActivityLogReadiness({ stateDir: options.stateDir, env });
  const server = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port: options.port,
    handlerDeps: deps,
  });
  await listen(server, options.port);
  return {
    deps,
    activityLogReadiness: readiness.readiness,
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
