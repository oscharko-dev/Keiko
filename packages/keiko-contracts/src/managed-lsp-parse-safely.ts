// Shared throw-to-content-free-Result parse wrapper for the managed-LSP contract family
// (KEIKO-0909). Five sibling managed-lsp-*.ts files each independently implemented the same
// try/catch adapter around their own `...Unsafe` parser: normalize any thrown exception into a
// fixed, content-free `{ ok: false, errors: [...] }` shape naming the error's constructor name (or
// "unknown"). Three (managed-lsp-activation.ts, managed-lsp-capabilities.ts, managed-lsp-route.ts)
// had it as a named, reusable generic helper; two (managed-lsp-runtime.ts, managed-lsp-evidence.ts)
// had the identical logic inlined directly in their one exported parser. This module is the one
// place that logic lives now; each sibling imports and calls it. (A grep for the exact error-message
// template below across managed-lsp-*.ts must find exactly this one definition.)
//
// Leaf-package rules (ADR-0019): no imports, no IO, no clock, no randomness. Intentionally NOT
// re-exported from index.ts — this is internal wiring between sibling files in this package, not a
// public contract; an unnecessary public export would trip `npm run check:package-surface:assembled`
// for no benefit.

type ParseSafelyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

export function parseSafely<T>(parser: () => ParseSafelyResult<T>): ParseSafelyResult<T> {
  try {
    return parser();
  } catch (error: unknown) {
    return {
      ok: false,
      errors: [
        `payload could not be inspected: ${error instanceof Error ? error.name : "unknown"}`,
      ],
    };
  }
}
