import { createHash } from "node:crypto";

import { OPENCODE_APPROVED_ENDPOINTS } from "./opencodeProtocol.js";

export const OPEN_CODE_PROTOCOL_SURFACE_ALGORITHM = "keiko-opencode-protocol-surface-v1" as const;
export const OPEN_CODE_PINNED_PROTOCOL_SURFACE_SHA256 =
  "e1db492f2ac661f2b44da6ef3d7e58ed34856621a2c58de4610640e1291266f6";

export interface OpenCodeProtocolSurfaceProjection {
  readonly digest: string;
  readonly projection: unknown;
}

const DOCUMENTATION_KEYS = new Set([
  "description",
  "operationId",
  "summary",
  "tags",
  "x-codeSamples",
]);

/** Projects the v1.17.17 OpenAPI document onto only Keiko's admitted structural surface. */
export function projectOpenCodeProtocolSurface(
  document: unknown,
): OpenCodeProtocolSurfaceProjection {
  const root = record(document);
  const paths = projectPaths(root);
  const references = collectReferences(paths);
  const components = projectReferencedComponents(root, references);
  const projection = {
    openapi: typeof root?.openapi === "string" ? root.openapi : null,
    paths,
    ...(Object.keys(components).length === 0 ? {} : { components }),
  };
  return {
    digest: createHash("sha256").update(canonicalJson(projection), "utf8").digest("hex"),
    projection,
  };
}

function projectPaths(
  document: Readonly<Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> {
  const source = record(document?.paths);
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of OPENCODE_APPROVED_ENDPOINTS) {
    const separator = route.indexOf(" ");
    const method = route.slice(0, separator).toLowerCase();
    const path = route.slice(separator + 1);
    const operation = record(record(source?.[path])?.[method]);
    if (operation === undefined) continue;
    (paths[path] ??= {})[method] = structural(operation);
  }
  return paths;
}

function projectReferencedComponents(
  document: Readonly<Record<string, unknown>> | undefined,
  references: Set<string>,
): Record<string, Record<string, unknown>> {
  const projected: Record<string, Record<string, unknown>> = {};
  const visited = new Set<string>();
  while (references.size > 0) {
    const reference = references.values().next().value;
    if (reference === undefined) break;
    references.delete(reference);
    if (visited.has(reference)) continue;
    visited.add(reference);
    const component = projectComponent(document, reference);
    if (component === undefined) continue;
    (projected[component.category] ??= {})[component.name] = component.value;
    for (const nested of collectReferences(component.value)) {
      if (!visited.has(nested)) references.add(nested);
    }
  }
  return projected;
}

function projectComponent(
  document: Readonly<Record<string, unknown>> | undefined,
  reference: string,
): { readonly category: string; readonly name: string; readonly value: unknown } | undefined {
  const match = /^#\/components\/([^/]+)\/([^/]+)$/u.exec(reference);
  const category = match?.[1];
  const name = match?.[2];
  if (category === undefined || name === undefined) return undefined;
  const component = record(record(record(document?.components)?.[category])?.[name]);
  return component === undefined ? undefined : { category, name, value: structural(component) };
}

function collectReferences(value: unknown): Set<string> {
  const references = new Set<string>();
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry);
      return;
    }
    const object = record(item);
    if (object === undefined) return;
    for (const [key, entry] of Object.entries(object)) {
      if (key === "$ref" && typeof entry === "string" && entry.startsWith("#/components/")) {
        references.add(entry);
      } else {
        visit(entry);
      }
    }
  };
  visit(value);
  return references;
}

function structural(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structural);
  const source = record(value);
  if (source === undefined) return value;
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => !DOCUMENTATION_KEYS.has(key) && !key.startsWith("x-"))
      .map(([key, item]) => [key, structural(item)]),
  );
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = record(value);
  if (object !== undefined) {
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
