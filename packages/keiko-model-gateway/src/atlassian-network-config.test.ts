import { describe, expect, it } from "vitest";
import { ConfigInvalidError } from "@oscharko-dev/keiko-security/errors/gateway";
import { parseAtlassianNetworkConfig } from "./atlassian-network-config.js";
import { parseGatewayConfig, toSafeObject } from "./config.js";

const target = { baseUrl: "https://jira.example:8443/context", addressClass: "private" } as const;

describe("operator-owned Atlassian network admission", () => {
  it("loads exact targets from the existing config without exposing addresses in safe projections", () => {
    const config = parseGatewayConfig({
      providers: [
        { modelId: "fixture", baseUrl: "https://model.example/v1", apiKey: "synthetic-key" },
      ],
      atlassian: { privateTargets: [target] },
    });
    expect(config.atlassian).toEqual({ privateTargets: [target] });
    expect(JSON.stringify(toSafeObject(config))).not.toContain("jira.example");
  });

  it("cannot derive connector admission from environment or global private egress", () => {
    const config = parseGatewayConfig(
      {
        providers: [
          { modelId: "fixture", baseUrl: "https://model.example/v1", apiKey: "synthetic-key" },
        ],
        egress: { allowPrivateNetwork: true },
      },
      { KEIKO_ATLASSIAN_PRIVATE_TARGETS: JSON.stringify([target]) },
    );
    expect(config.atlassian).toBeUndefined();
    expect(parseAtlassianNetworkConfig(undefined)).toBeUndefined();
  });

  it.each([
    { privateTargets: [{ ...target, baseUrl: "http://jira.example" }] },
    { privateTargets: [{ ...target, baseUrl: "https://169.254.169.254" }] },
    { privateTargets: [{ ...target, baseUrl: "https://127.0.0.1" }] },
    { privateTargets: [{ ...target, baseUrl: "https://jira.example/a/../b" }] },
    { privateTargets: [{ ...target, baseUrl: "https://jira.example/%2e%2e" }] },
    { privateTargets: [{ ...target, baseUrl: "https://jira.example/a%2fb" }] },
    { privateTargets: [{ ...target, baseUrl: "https://jira.example?override=true" }] },
    { privateTargets: [{ ...target, addressClass: "public" }] },
    { privateTargets: [target, target] },
    { privateTargets: Array.from({ length: 65 }, () => target) },
    { privateTargets: [target], allowPrivateNetwork: true },
  ])(
    "rejects malformed or widening target declarations without retaining submitted values",
    (value) => {
      expect(() => parseAtlassianNetworkConfig(value)).toThrow(ConfigInvalidError);
      try {
        parseAtlassianNetworkConfig(value);
      } catch (error) {
        expect(String(error)).not.toContain("jira.example");
      }
    },
  );
});
