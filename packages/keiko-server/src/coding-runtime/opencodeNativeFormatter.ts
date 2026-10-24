/**
 * The closed vocabulary of what a native run does with the producer's built-in formatters (#3897,
 * parity row C07). `enabled` is the only value that lets a formatter run; every other value is a
 * reason it is switched off.
 */
export const OPENCODE_NATIVE_FORMATTER_DISPOSITIONS = [
  "enabled",
  "disabled-ask-mode",
  "disabled-supervised-mode",
  "disabled-unknown-mode",
] as const;

export type OpenCodeNativeFormatterDisposition =
  (typeof OPENCODE_NATIVE_FORMATTER_DISPOSITIONS)[number];

/**
 * The pinned 2.1.4 producer runs a built-in formatter (prettier, biome, gofmt, ...) after its own
 * `edit`, `write` and `patch` tools, as a plain child process of the runtime, and consults no
 * permission for it: the policy hook sees the edit, never the formatter. The tool it starts is a
 * host binary found on the launcher's PATH, a package resolved through the producer's own package
 * manager (offline under Keiko, so none resolves), or, for `pint`, the repository's own
 * `./vendor/bin/pint`: a command that starts without the approval an unvetted command needs. The
 * producer keeps built-in formatters off unless the configuration says `formatter: true`, so this
 * function decides, per launch mode, whether Keiko says so.
 *
 * The decision is bound when the tree launches and cannot follow a later narrowing: a resume may
 * narrow Supervised workspace to Ask for approval in place, and the formatter's setting is part of
 * the launch configuration. Only Full access therefore enables the formatter. A Full access tree
 * cannot be narrowed in place at all (`openCodeNativeEgress` binds its egress at exec and the
 * composition refuses the narrowing), so an enabled formatter never outlives the authority that
 * allowed it. Ask for approval keeps it off because nothing may start unapproved there, Supervised
 * workspace because it may become Ask for approval, and an unrecognized or absent mode fails closed.
 */
export function openCodeNativeFormatterDisposition(
  mode: string | undefined,
): OpenCodeNativeFormatterDisposition {
  switch (mode) {
    case "autonomous-delivery":
      return "enabled";
    case "supervised-coding":
      return "disabled-supervised-mode";
    case "governed-assist":
      return "disabled-ask-mode";
    default:
      return "disabled-unknown-mode";
  }
}

/** The `formatter` setting the server-owned binding carries: always explicit, never inherited. */
export function openCodeNativeFormatterSetting(
  disposition: OpenCodeNativeFormatterDisposition,
): boolean {
  return disposition === "enabled";
}
