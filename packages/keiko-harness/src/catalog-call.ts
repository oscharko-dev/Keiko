import type { NormalizedToolCall } from "@oscharko-dev/keiko-model-gateway";
import type { BoundToolInvocation } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import {
  captureCatalogJson,
  type ToolInvocationNormalizer,
} from "@oscharko-dev/keiko-tool-catalog";
import { HarnessCatalogError } from "./catalog-errors.js";
import { HARNESS_CODES } from "./errors.js";

export function captureHarnessToolCall(
  normalizer: ToolInvocationNormalizer,
  input: NormalizedToolCall,
  now: number,
): NormalizedToolCall & { readonly invocation: BoundToolInvocation } {
  const captured = captureCatalogJson(input) as unknown as NormalizedToolCall;
  if (
    typeof captured.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(captured.id) ||
    Object.keys(captured).length !== 4 ||
    captured.invocation === undefined
  )
    throw new HarnessCatalogError(HARNESS_CODES.INTERNAL, "Invalid bound provider call");
  const invocation = normalizer.normalize(captured.invocation, now);
  const aliasView = normalizer.bindAlias(captured.name, captured.arguments, now);
  if (canonicalise(invocation) !== canonicalise(aliasView))
    throw new HarnessCatalogError(
      HARNESS_CODES.INTERNAL,
      "Provider alias or argument view disagrees with bound invocation",
    );
  return Object.freeze({ ...captured, invocation });
}
