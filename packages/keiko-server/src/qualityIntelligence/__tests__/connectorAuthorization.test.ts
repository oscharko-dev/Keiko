import { describe, expect, it } from "vitest";
import {
  isFigmaConnectorAuthorized,
  isJiraConnectorAuthorized,
  summariseQiConnectorCapabilities,
  type QiConnectorConfig,
} from "../connectorAuthorization.js";

describe("QI connector authorisation — defaults FALSE", () => {
  it("returns false for undefined config", () => {
    expect(isFigmaConnectorAuthorized(undefined)).toBe(false);
    expect(isJiraConnectorAuthorized(undefined)).toBe(false);
  });

  it("returns false for empty config", () => {
    expect(isFigmaConnectorAuthorized({})).toBe(false);
    expect(isJiraConnectorAuthorized({})).toBe(false);
  });

  it("returns false when flag is missing", () => {
    const config: QiConnectorConfig = { jira_connector_authorized: true };
    expect(isFigmaConnectorAuthorized(config)).toBe(false);
  });

  it("rejects truthy non-boolean values (no coercion)", () => {
    expect(isFigmaConnectorAuthorized({ figma_connector_authorized: "true" })).toBe(false);
    expect(isFigmaConnectorAuthorized({ figma_connector_authorized: 1 })).toBe(false);
    expect(isFigmaConnectorAuthorized({ figma_connector_authorized: "yes" })).toBe(false);
    expect(isJiraConnectorAuthorized({ jira_connector_authorized: 1 })).toBe(false);
    expect(isJiraConnectorAuthorized({ jira_connector_authorized: "true" })).toBe(false);
  });

  it("rejects null and zero (no coercion)", () => {
    expect(isFigmaConnectorAuthorized({ figma_connector_authorized: null })).toBe(false);
    expect(isFigmaConnectorAuthorized({ figma_connector_authorized: 0 })).toBe(false);
  });

  it("returns true only for literal boolean true", () => {
    expect(isFigmaConnectorAuthorized({ figma_connector_authorized: true })).toBe(true);
    expect(isJiraConnectorAuthorized({ jira_connector_authorized: true })).toBe(true);
  });
});

describe("summariseQiConnectorCapabilities", () => {
  it("returns booleans only, never raw config values", () => {
    const config: QiConnectorConfig = {
      figma_connector_authorized: true,
      jira_connector_authorized: false,
    };
    const caps = summariseQiConnectorCapabilities(config);
    expect(caps).toEqual({ figma: true, jira: false });
    expect(typeof caps.figma).toBe("boolean");
    expect(typeof caps.jira).toBe("boolean");
  });

  it("defaults to all-false for empty input", () => {
    expect(summariseQiConnectorCapabilities(undefined)).toEqual({ figma: false, jira: false });
    expect(summariseQiConnectorCapabilities({})).toEqual({ figma: false, jira: false });
  });
});
