/** One shared, versioned PR-body frame for creation, rendering and reconciliation (#3398). */
export const PR_DESCRIPTION_REGION_VERSION = "1" as const;
export const PR_DESCRIPTION_REGION_START = "<!-- keiko:pr-description:v1:start -->";
export const PR_DESCRIPTION_REGION_END = "<!-- keiko:pr-description:v1:end -->";
export const PR_DESCRIPTION_ATTRIBUTION = "by Keiko";
export const PR_DESCRIPTION_LOGO_SOURCE = "packages/keiko-ui/public/keiko-logo.svg";

/** Also catches malformed/future markers: only the trusted frame may emit this namespace. */
export function containsPrDescriptionMarker(value: string): boolean {
  return /keiko\s*:\s*pr-description/iu.test(value);
}

export function framePrDescriptionRegion(body: string): string {
  if (containsPrDescriptionMarker(body)) throw new TypeError("Nested PR description marker");
  return `${PR_DESCRIPTION_REGION_START}\n${body}\n${PR_DESCRIPTION_REGION_END}`;
}
