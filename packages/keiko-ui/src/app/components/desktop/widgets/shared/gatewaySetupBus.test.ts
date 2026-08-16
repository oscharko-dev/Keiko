// Issue #1399: gateway-setup bus — the cross-window channel that deep-links a Figma Snapshot PAT
// error to the Settings gateway-setup dialog.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CONFIG_UPDATED_EVENT,
  GATEWAY_MODEL_READINESS_UPDATED_EVENT,
  GATEWAY_SETUP_REQUEST_EVENT,
  consumePendingGatewaySetup,
  notifyGatewayConfigUpdated,
  notifyGatewayModelReadinessUpdated,
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

  // F-02: the configuration-updated announcement is a pure notification — unlike the setup request
  // it must NOT latch, or a panel mounted long afterwards would discard readiness evidence it
  // gathered about the configuration that is actually current.
  it("announces a configuration update without latching it", () => {
    const handler = vi.fn();
    window.addEventListener(GATEWAY_CONFIG_UPDATED_EVENT, handler);
    try {
      notifyGatewayConfigUpdated();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(consumePendingGatewaySetup()).toBe(false);
    } finally {
      window.removeEventListener(GATEWAY_CONFIG_UPDATED_EVENT, handler);
    }
  });

  it("announces a model-readiness update on its own catalog-refresh channel", () => {
    const readinessHandler = vi.fn();
    const configHandler = vi.fn();
    window.addEventListener(GATEWAY_MODEL_READINESS_UPDATED_EVENT, readinessHandler);
    window.addEventListener(GATEWAY_CONFIG_UPDATED_EVENT, configHandler);
    try {
      notifyGatewayModelReadinessUpdated();
      expect(readinessHandler).toHaveBeenCalledTimes(1);
      expect(configHandler).not.toHaveBeenCalled();
      expect(consumePendingGatewaySetup()).toBe(false);
    } finally {
      window.removeEventListener(GATEWAY_MODEL_READINESS_UPDATED_EVENT, readinessHandler);
      window.removeEventListener(GATEWAY_CONFIG_UPDATED_EVENT, configHandler);
    }
  });
});
