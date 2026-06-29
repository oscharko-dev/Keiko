// Issue #1381, ADR-0069 D5/D6 — read-only status route for the governed LSP process manager. It serves
// the bounded, content-free lifecycle ledger so an operator can inspect recent LSP process activity
// (spawn, initialize, crash, restart, dispose) without any source text, paths, or method names ever
// crossing the boundary. The route is env-gated default-OFF (`KEIKO_EDITOR_LSP_STATUS`): until an
// operator explicitly enables it, the endpoint reports 404 NOT_FOUND so it is not even discoverable.
//
// GET only, no CSRF (a read route mutates nothing). No CSP/connect-src change is needed: the response
// is same-origin BFF JSON consumed over the existing fetch path, identical to /api/editor/agent/audit.

import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { errorBody, type RouteResult } from "../../routes.js";
import { listLspLifecycleEvents } from "./lspLifecycleLedger.js";

export interface LspStatusRouteDeps {
  readonly env: EnvSource;
}

// Default-OFF: the status surface is only exposed when the operator opts in. Any value other than the
// explicit truthy tokens leaves it disabled (fail-closed), so a typo cannot accidentally expose it.
export function isLspStatusTrusted(env: EnvSource): boolean {
  const raw = env.KEIKO_EDITOR_LSP_STATUS;
  return raw === "1" || raw === "true";
}

export function handleEditorLspStatus(_ctx: unknown, deps: LspStatusRouteDeps): RouteResult {
  if (!isLspStatusTrusted(deps.env)) {
    return { status: 404, body: errorBody("NOT_FOUND", "The requested resource was not found.") };
  }
  return { status: 200, body: { events: listLspLifecycleEvents() } };
}
