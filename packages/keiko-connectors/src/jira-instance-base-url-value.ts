import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { savedText } from "./jira-saved-configuration-values.js";

/** Comparison-only source fact, never a request destination or navigation target. */
export function jiraObservedInstanceBaseUrl(value: unknown): value is string {
  if (!savedText(value, 2048) || /\s|\\/u.test(value) || !URL.canParse(value)) return false;
  const url = new URL(value);
  return safeParsedObservation(url) && !value.includes("@") && !value.includes("?") && !value.includes("#");
}
function safeParsedObservation(url: URL): boolean {
  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0 &&
    url.username === "" && url.password === "";
}
export function jiraInstanceBaseUrlObservation(value: unknown): CatalogJsonObject {
  return jiraObservedInstanceBaseUrl(value)
    ? { configuredBaseUrlState: "observed", configuredBaseUrl: value }
    : { configuredBaseUrlState: "unavailable" };
}
