import type { RejectionReason } from "./errors.js";
import type { CapturePolicyOptions } from "./types.js";

type DeniedCategoryMatchers = NonNullable<CapturePolicyOptions["deniedCategoryMatchers"]>;

function matcherFires(body: string, matcher: RegExp): boolean {
  // Caller matchers may carry `g` or `y`. Reset their mutable cursor before and after evaluation so
  // repeated classification remains byte-identical for the same policy object.
  matcher.lastIndex = 0;
  const matched = matcher.test(body);
  matcher.lastIndex = 0;
  return matched;
}

export function classifyDeniedCategory(
  body: string,
  categories: DeniedCategoryMatchers,
): Extract<RejectionReason, "denied-category"> | null {
  for (const category of categories) {
    for (const matcher of category.matchers) {
      if (matcherFires(body, matcher)) {
        return "denied-category";
      }
    }
  }
  return null;
}
