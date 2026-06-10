// Quality Intelligence connector authorisation (Epic #270, Issue #278).
//
// Typed authorisation predicates for the QI dry-run connector routes. Every
// authorisation DEFAULTS TO FALSE; only flips on an explicit boolean `true` config flag.
// No reflection, no string coercion — the boolean must be a real `true`.
//
// The config object passed to these predicates is intentionally a structural Record
// that the BFF resolver hydrates from the gateway-config storage layer (issue #279 will
// formalise this; today it is read off `env` until the gateway exposes it). The
// predicates themselves are pure — they do no IO and cannot construct credentials.

export interface QiConnectorConfig {
  readonly figma_connector_authorized?: unknown;
  readonly jira_connector_authorized?: unknown;
}

export interface QiConnectorCapabilities {
  readonly figma: boolean;
  readonly jira: boolean;
}

const isExplicitTrue = (value: unknown): boolean => value === true;

/**
 * True only when `config.figma_connector_authorized === true`. Pure.
 */
export const isFigmaConnectorAuthorized = (config: QiConnectorConfig | undefined): boolean => {
  if (config === undefined) return false;
  return isExplicitTrue(config.figma_connector_authorized);
};

/**
 * True only when `config.jira_connector_authorized === true`. Pure.
 */
export const isJiraConnectorAuthorized = (config: QiConnectorConfig | undefined): boolean => {
  if (config === undefined) return false;
  return isExplicitTrue(config.jira_connector_authorized);
};

/**
 * Capabilities summary suitable for the `/api/quality-intelligence/sources/capabilities`
 * route. Carries booleans only — NEVER credentials, endpoint URLs, or raw config values.
 */
export const summariseQiConnectorCapabilities = (
  config: QiConnectorConfig | undefined,
): QiConnectorCapabilities => ({
  figma: isFigmaConnectorAuthorized(config),
  jira: isJiraConnectorAuthorized(config),
});
