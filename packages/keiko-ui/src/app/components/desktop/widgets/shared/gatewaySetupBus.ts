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
