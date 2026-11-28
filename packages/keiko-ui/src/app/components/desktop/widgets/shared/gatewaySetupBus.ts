import { isActivityLogCorrelationId } from "@oscharko-dev/keiko-contracts/runtime/observability";

// Cross-window bus (intentionally outside React) that lets the Figma Snapshot window ask the
// Settings panel to open the gateway-setup dialog on its Figma access-token section. The token is
// resolved server-side and can only be entered in that dialog, so the PAT error in the Snapshot
// window needs a way to reach it without the user hunting through Settings.
//
// Two delivery paths cover both states of the singleton Settings window without a mount race:
//   - a module-level latch, read once when the Settings panel mounts (covers "Settings was just
//     opened by openWindow" — the event fires before the panel's listener is registered), and
//   - a custom event, handled by the live panel (covers "Settings was already open" — there is no
//     fresh mount, so the latch is consumed by the event handler instead).
// Exactly one path fires per request, so the dialog opens once. The latch is in-memory only, so a
// reload never re-triggers it.

export const GATEWAY_SETUP_REQUEST_EVENT = "keiko:gateway-setup-request";

/**
 * Announced by the gateway-setup dialog the moment a submission has replaced the stored gateway
 * configuration. Surfaces that remember observations ABOUT the gateway — readiness runs, the
 * verification badge derived from them — must treat everything they measured before this signal as
 * evidence about the PREVIOUS configuration.
 *
 * It exists because the safe config projection the UI receives carries no credential: rotating an
 * API key leaves every field the panel can see byte-identical, so a value comparison cannot detect
 * that replacement. This is the client-side counterpart of the server holder's `set()`, which
 * invalidates its recorded verification for exactly the same reason.
 */
export const GATEWAY_CONFIG_UPDATED_EVENT = "keiko:gateway-config-updated";

/**
 * Announced after the server records a model readiness result. Unlike a configuration update, this
 * refreshes model-catalog projections without invalidating Settings evidence about the current
 * configuration generation.
 */
export const GATEWAY_MODEL_READINESS_UPDATED_EVENT = "keiko:gateway-model-readiness-updated";

/** A background read has already adopted a changed catalog; consumers can refresh their posture. */
export const GATEWAY_MODEL_CATALOG_UPDATED_EVENT = "keiko:gateway-model-catalog-updated";

/**
 * Requested when a visible model picker is opened. This is deliberately separate from
 * GATEWAY_CONFIG_UPDATED_EVENT: opening a picker needs a current catalog, but must never
 * imply that credentials or the gateway configuration were replaced.
 */
export const GATEWAY_MODEL_CATALOG_REFRESH_REQUESTED_EVENT =
  "keiko:gateway-model-catalog-refresh-requested";

let pending = false;
let catalogRefreshConsumers = 0;
// One entry per mounted requester: a merged `check` is served only while a requester that asked for
// it is still mounted, so an unmounted window's check never outlives it.
let unservedCatalogRefreshes: { readonly check: boolean; readonly at: number }[] = [];
/** A kept request older than this is stale: the shell it waited for did not appear in time. */
const UNSERVED_CATALOG_REFRESH_TTL_MS = 10_000;

/**
 * Request that the Settings panel open the gateway-setup dialog (Figma access-token section).
 * Sets the latch first, then notifies any already-mounted listener.
 */
export function requestGatewaySetup(): void {
  pending = true;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(GATEWAY_SETUP_REQUEST_EVENT));
  }
}

/**
 * Read and clear the pending flag. Returns true when a gateway-setup request was waiting — the
 * Settings panel calls this on mount and from the event handler so the request is consumed once.
 */
export function consumePendingGatewaySetup(): boolean {
  const had = pending;
  pending = false;
  return had;
}

/**
 * Announce that the stored gateway configuration was just replaced. Fire-and-forget: unlike the
 * setup request there is no latch, because a listener that does not exist yet has nothing stale to
 * invalidate — it starts with no remembered observations at all.
 */
export function notifyGatewayConfigUpdated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(GATEWAY_CONFIG_UPDATED_EVENT));
}

export function notifyGatewayModelReadinessUpdated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(GATEWAY_MODEL_READINESS_UPDATED_EVENT));
}

export function notifyGatewayModelCatalogUpdated(correlationId?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(GATEWAY_MODEL_CATALOG_UPDATED_EVENT, { detail: { correlationId } }),
  );
}

/**
 * Request a fresh gateway model catalog without changing configuration-readiness state. `check`
 * marks a person's own step (opening the Workbench or a model picker): the server then checks
 * again the models that are not ready, like a page load, so a model that was busy at startup can
 * come back without a reload (customer 1.3.4). Automatic rereads never ask for it.
 */
export function requestGatewayModelCatalogRefresh(
  options: { readonly check?: boolean } = {},
): () => void {
  if (typeof window === "undefined") return noop;
  // A window that mounts in the same commit as the shell runs its effects before the shell's
  // catalog consumer has subscribed, so the event would reach nobody and the catalog would stay the
  // bootstrap's activated-only list (U-45). The request is kept, for a short while and only while
  // its requester is mounted: the returned cleanup (an unmounting window) drops it.
  const kept =
    catalogRefreshConsumers === 0 ? { check: options.check === true, at: Date.now() } : undefined;
  if (kept !== undefined) unservedCatalogRefreshes.push(kept);
  window.dispatchEvent(
    new CustomEvent(GATEWAY_MODEL_CATALOG_REFRESH_REQUESTED_EVENT, {
      detail: { check: options.check === true },
    }),
  );
  return (): void => {
    if (kept !== undefined)
      unservedCatalogRefreshes = unservedCatalogRefreshes.filter((r) => r !== kept);
  };
}

function noop(): void {
  // nothing was kept, so there is nothing to drop
}

/** Whether a catalog refresh request came from a person's own step and asks for a check. */
export function gatewayModelCatalogCheckRequested(event: Event): boolean {
  const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
  if (typeof detail !== "object" || detail === null) return false;
  return Object.getOwnPropertyDescriptor(detail, "check")?.value === true;
}

/** Only the actual catalog request can parent a consumer refresh; malformed event details carry none. */
export function gatewayModelCatalogCorrelationId(event: Event): string | undefined {
  const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
  if (typeof detail !== "object" || detail === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(detail, "correlationId");
  const value: unknown = descriptor?.value;
  return isActivityLogCorrelationId(value) ? value : undefined;
}

/**
 * A catalog refresh consumer is now listening. Returns the request that arrived before any consumer
 * existed (and clears it), so the consumer serves it once instead of the request being lost.
 */
export function attachGatewayModelCatalogRefreshConsumer():
  { readonly check: boolean } | undefined {
  catalogRefreshConsumers += 1;
  const now = Date.now();
  const fresh = unservedCatalogRefreshes.filter(
    (request) => now - request.at <= UNSERVED_CATALOG_REFRESH_TTL_MS,
  );
  unservedCatalogRefreshes = [];
  return fresh.length === 0 ? undefined : { check: fresh.some((request) => request.check) };
}

/** The consumer stopped listening; later requests are kept for the next one. */
export function detachGatewayModelCatalogRefreshConsumer(): void {
  catalogRefreshConsumers = Math.max(0, catalogRefreshConsumers - 1);
}
