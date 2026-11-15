import { captureCatalogBinding, ToolCatalogError } from "@oscharko-dev/keiko-tool-catalog";
import type { JiraChatCatalogRuntime } from "../../packages/keiko-server/src/atlassian/jiraChatCatalogRuntime.js";

type JiraChatScope = Parameters<JiraChatCatalogRuntime["select"]>[1];

// The offer a round binds with: one reference per projected tool, as a Chat turn offers them. Only its
// size matters to the capture's bound, so the probe builds it from the projection it is asked about.
function probeOffer(projection: {
  readonly profile: unknown;
  readonly projectionDigest: string;
  readonly tools: readonly { readonly toolRef: unknown }[];
}): unknown {
  return {
    binding: {
      catalogRevision: "0".repeat(64),
      profile: projection.profile,
      projectionDigest: projection.projectionDigest,
      handlerSetDigest: projection.projectionDigest,
      readiness: "ready",
    },
    offerId: "binding-probe-offer-0000000000000000",
    toolRefs: projection.tools.map((tool) => tool.toolRef),
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

/**
 * Whether the gateway can bind a round that offers `identities` beside the base, decided by the one
 * production capture the gateway binds with and the tool selection is admitted with. A test derives
 * its boundary from this, so a change to a descriptor, the base or the bound moves the test with it.
 */
export async function selectionBinds(
  catalog: JiraChatCatalogRuntime,
  identities: readonly string[],
  scope?: JiraChatScope,
): Promise<boolean> {
  try {
    const selected = await catalog.select(identities, scope);
    try {
      captureCatalogBinding({
        catalog: selected.catalog,
        projection: selected.projection,
        offered: probeOffer(selected.projection),
      });
      return true;
    } finally {
      await selected.close();
    }
  } catch (error) {
    if (error instanceof ToolCatalogError && error.reason === "input-bound") return false;
    throw error;
  }
}

/**
 * The most of `identities`, taken from the front, that the gateway can still bind beside the base,
 * found with the production capture. The boundary must lie inside the list: the base alone must
 * bind and the whole list must not, or the walk that uses it would prove nothing.
 */
export async function largestBindingSelection(
  catalog: JiraChatCatalogRuntime,
  identities: readonly string[],
  scope?: JiraChatScope,
  fixed: readonly string[] = [],
): Promise<number> {
  const binds = (count: number): Promise<boolean> =>
    selectionBinds(catalog, [...fixed, ...identities.slice(0, count)], scope);
  if (!(await binds(0))) throw new Error("The base alone does not bind");
  if (await binds(identities.length)) throw new Error("The whole list binds: nothing to walk");
  let fits = 0;
  let refused = identities.length;
  while (refused - fits > 1) {
    const middle = Math.floor((fits + refused) / 2);
    if (await binds(middle)) fits = middle;
    else refused = middle;
  }
  return fits;
}
