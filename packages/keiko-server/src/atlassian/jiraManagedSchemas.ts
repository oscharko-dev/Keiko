import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

export function text(maxLength: number): CatalogJsonObject {
  return { type: "string", maxLength };
}
/** A required-meaning value such as a key, name or identifier; native Jira rejects an empty one. */
export function identifier(maxLength: number): CatalogJsonObject {
  return { type: "string", minLength: 1, maxLength };
}
/**
 * A complete native plugin module key (`pluginKey:moduleKey`). Jira resolves project templates by
 * module key and answers a bare module name with an opaque HTTP 500 instead of a validation error.
 */
export function moduleKey(maxLength: number): CatalogJsonObject {
  return {
    type: "string",
    minLength: 3,
    maxLength,
    pattern: String.raw`^[^:\s]+:[^:\s]+$`,
    description:
      "Complete native plugin module key in the form pluginKey:moduleKey. Jira Software Data Center's built-in project templates are com.pyxis.greenhopper.jira:gh-scrum-template (Scrum), com.pyxis.greenhopper.jira:gh-kanban-template (Kanban) and com.pyxis.greenhopper.jira:basic-software-development-template. A bare module name is invalid; omit the field to use Jira's default template for the project type.",
  };
}
export function object(
  properties: CatalogJsonObject,
  required: readonly string[] = [],
): CatalogJsonObject {
  return { type: "object", required, additionalProperties: false, properties };
}
