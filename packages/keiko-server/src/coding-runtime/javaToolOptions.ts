/**
 * The JVM environment options a native run hands every JVM (`JAVA_TOOL_OPTIONS`). These are JVM
 * option quotes, not a shell command: HotSpot splits the value at whitespace outside single or
 * double quotes and strips the quotes, and it expands nothing (no `$`, backslash or glob). An
 * unmatched quote anywhere makes the JVM refuse to start ("Unmatched quote"), so a malformed
 * inherited value fails closed rather than absorbing the run's options.
 */

/** One `-D` option whose value arrives byte for byte, whatever it contains. */
export function javaSystemProperty(name: string, value: string): string {
  return "'-D" + name + "=" + value.replaceAll("'", "'\"'\"'") + "'";
}

/**
 * The inherited options first, then the run's: a later `-D` overrides an earlier one, so the run's
 * private home and temporary directory win over an inherited value for the same property.
 */
export function javaToolOptions(
  inherited: string | undefined,
  properties: Readonly<Record<string, string>>,
): string {
  const options = Object.entries(properties).map(([name, value]) =>
    javaSystemProperty(name, value),
  );
  return [inherited, ...options].filter(Boolean).join(" ");
}
