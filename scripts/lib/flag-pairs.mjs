/**
 * Reads `--flag value` pairs into `options` and returns it. `flags` maps each accepted flag to its
 * option name. An unknown flag, an inherited property name or a flag without a value is handed to
 * `refuse`, which must throw; nothing else is accepted.
 */
export function readFlagPairs(argv, flags, options, refuse) {
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const name = Object.hasOwn(flags, flag) ? flags[flag] : undefined;
    const value = argv[index + 1];
    if (name === undefined) refuse(`unknown argument ${String(flag)}`);
    if (value === undefined || value.startsWith("--")) refuse(`${flag} needs a value`);
    options[name] = value;
  }
  return options;
}
