import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { DEFAULT_UI_PORT, UI_HOST } from "@oscharko-dev/keiko-contracts/runtime/bff-wire";

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

export interface LoopbackEndpointOptions {
  readonly host?: string | undefined;
  readonly port?: string | undefined;
}

export interface LoopbackEndpoint {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
}

function parsePort(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

export function resolveLoopbackEndpoint(
  options: LoopbackEndpointOptions,
  env: EnvSource,
): LoopbackEndpoint | null {
  const host = options.host ?? env.KEIKO_UI_HOST ?? UI_HOST;
  const port = parsePort(options.port ?? env.KEIKO_UI_PORT ?? String(DEFAULT_UI_PORT));
  if (!ALLOWED_HOSTS.has(host) || port === null) return null;
  return { host, port, baseUrl: `http://${host}:${String(port)}` };
}
