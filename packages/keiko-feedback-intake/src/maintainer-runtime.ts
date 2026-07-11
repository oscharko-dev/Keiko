import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PostgresFeedbackReviewQuery } from "./feedback-review-query.js";
import { PostgresFeedbackReviewRepository } from "./feedback-review-store.js";
import { createMaintainerAuthService } from "./maintainer-auth.js";
import { loadMaintainerRuntimeConfig, type MaintainerRuntimeConfig } from "./maintainer-config.js";
import { createMaintainerHttpHandler, type MaintainerHttpOptions } from "./maintainer-http.js";
import type { MaintainerDiagnostics } from "./maintainer-http-response.js";
import { MaintainerLoginLimiter } from "./maintainer-login-limiter.js";
import { createMaintainerOidcClient, type MaintainerOidcClient } from "./maintainer-oidc.js";
import { PostgresMaintainerAuthStore } from "./maintainer-store.js";
import type { PgPoolLike } from "./postgres-types.js";
import { loadHostedRuntimeConfig, type HostedRuntimeConfig } from "./runtime-config.js";

export interface MaintainerRuntimeServer {
  listen(port: number, host: string, callback: () => void): void;
  close(callback: (error?: Error) => void): void;
  closeAllConnections?(): void;
  once?(event: "error", listener: (error: Error) => void): void;
  removeListener?(event: "error", listener: (error: Error) => void): void;
}

export interface MaintainerRuntimeOptions {
  readonly config: Extract<MaintainerRuntimeConfig, { readonly enabled: true }>;
  readonly runtimeConfig: HostedRuntimeConfig;
  readonly pool: PgPoolLike;
  readonly now: () => Date;
  readonly oidc?: MaintainerOidcClient | undefined;
  readonly diagnostics?: MaintainerHttpOptions["diagnostics"];
  readonly serverFactory?:
    | ((handler: (req: IncomingMessage, res: ServerResponse) => void) => MaintainerRuntimeServer)
    | undefined;
}

export function loadFeedbackRuntimeConfigs(
  env: Readonly<Record<string, string | undefined>>,
  migrations: {
    readonly migrationSource?: (() => Promise<string>) | undefined;
    readonly migrationSources?: (() => Promise<readonly unknown[]>) | undefined;
  },
): {
  readonly config: HostedRuntimeConfig;
  readonly maintainerConfig: MaintainerRuntimeConfig;
} {
  const config = loadHostedRuntimeConfig(env);
  const maintainerConfig = loadMaintainerRuntimeConfig(env);
  if (
    maintainerConfig.enabled &&
    (maintainerConfig.port === config.port || maintainerConfig.port === config.managementPort)
  ) {
    throw new Error("Invalid maintainer port");
  }
  assertMaintainerMigrationConfiguration(maintainerConfig, migrations);
  return { config, maintainerConfig };
}

function assertMaintainerMigrationConfiguration(
  config: MaintainerRuntimeConfig,
  options: {
    readonly migrationSource?: (() => Promise<string>) | undefined;
    readonly migrationSources?: (() => Promise<readonly unknown[]>) | undefined;
  },
): void {
  if (
    config.enabled &&
    options.migrationSource !== undefined &&
    options.migrationSources === undefined
  ) {
    throw new Error("Maintainer runtime requires ordered migration sources");
  }
}

export async function createMaintainerRuntimeServer(
  options: MaintainerRuntimeOptions,
): Promise<MaintainerRuntimeServer> {
  const oidc = options.oidc ?? (await createMaintainerOidcClient(options.config));
  const auth = createMaintainerAuthService(
    options.config,
    oidc,
    new PostgresMaintainerAuthStore(
      options.pool,
      options.config.sessionIdleMs,
      options.config.sessionAbsoluteMs,
    ),
    options.now,
  );
  const handler = createMaintainerHttpHandler({
    publicOrigin: options.config.publicOrigin,
    auth,
    query: new PostgresFeedbackReviewQuery(options.pool),
    review: new PostgresFeedbackReviewRepository(
      options.pool,
      5_000,
      options.config.legalHoldPolicyKeys,
      options.now,
    ),
    loginLimiter: new MaintainerLoginLimiter({
      perSource: options.config.loginPerSourceLimit,
      global: options.config.loginGlobalLimit,
      windowMs: options.config.loginWindowMs,
      concurrency: options.config.loginConcurrencyLimit,
    }),
    proxy: {
      family: options.runtimeConfig.proxyFamily,
      trustedCidrs: options.runtimeConfig.trustedProxyCidrs,
      maxHops: options.runtimeConfig.limits.proxyHops,
    },
    legalHoldPolicyKeys: options.config.legalHoldPolicyKeys,
    diagnostics: options.diagnostics ?? defaultMaintainerDiagnostics(),
  });
  const factory =
    options.serverFactory ??
    ((route): MaintainerRuntimeServer => {
      return createServer(route);
    });
  return factory((req, res) => {
    void handler(req, res);
  });
}

function defaultMaintainerDiagnostics(): MaintainerDiagnostics {
  return {
    event: (category, correlationId): void => {
      process.stderr.write(
        `${JSON.stringify({ event: "maintainer-failure", category, correlationId })}\n`,
      );
    },
  };
}
