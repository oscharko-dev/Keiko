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

let pending = false;

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
