// Issue #1399: gateway-setup bus — the cross-window channel that deep-links a Figma Snapshot PAT
// error to the Settings gateway-setup dialog.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_SETUP_REQUEST_EVENT,
  consumePendingGatewaySetup,
  requestGatewaySetup,
} from "./gatewaySetupBus";

afterEach(() => {
  // Drain the latch so state never leaks between cases.
  consumePendingGatewaySetup();
});

describe("gatewaySetupBus", () => {
  it("consumePendingGatewaySetup returns false when nothing was requested", () => {
    expect(consumePendingGatewaySetup()).toBe(false);
  });

  it("latches a request that a later consumer reads exactly once", () => {
    requestGatewaySetup();
    expect(consumePendingGatewaySetup()).toBe(true);
    // The latch is one-shot: a second read sees nothing.
    expect(consumePendingGatewaySetup()).toBe(false);
  });

  it("dispatches the request event for already-mounted listeners", () => {
    const handler = vi.fn();
    window.addEventListener(GATEWAY_SETUP_REQUEST_EVENT, handler);
    try {
      requestGatewaySetup();
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(GATEWAY_SETUP_REQUEST_EVENT, handler);
    }
  });
});
