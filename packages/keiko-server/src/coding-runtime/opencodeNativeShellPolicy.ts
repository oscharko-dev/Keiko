import { basename } from "node:path";

import { pathInsideWorkspace } from "./opencodeNativePaths.js";

/**
 * The native shell classifier (#4271, ADR-0124/0137): what a Supervised workspace runs without a
 * decision ("vetted commands and verification"), and which invocations reach Keiko-owned delivery.
 *
 * Vetting is by program, subcommand AND options. A program that is safe to run can carry an option
 * that executes another command (`find -exec`, `rg --pre`, `git -c core.fsmonitor=`) or writes a
 * file (`sort -o`, `git diff --output`); those are never vetted, whatever the subcommand. A value
 * option (`mvn -pl api`, `npm -w pkg`) is skipped as an option, so the operand after it is the
 * subcommand, and a path-valued option must name a place inside the workspace. Anything the parser
 * cannot read with certainty (an unterminated quote, an expansion, a redirection) is not vetted: it
 * asks, which is always safe. Reservation (delivery through Git or gh) stays a separate, broader
 * check that also looks inside runners such as `find -exec`, `xargs` and `timeout`.
 */

// ---------------------------------------------------------------------------------------------
// Words and segments
// ---------------------------------------------------------------------------------------------

/** Redirections that cannot write anywhere: descriptor duplication and the null device. */
const BENIGN_REDIRECTION = /\d?>&\d|(?:\d|&)?>{1,2}\s*\/dev\/null(?=\s|$)/gu;
const SEGMENT_OPERATORS = /&&|\|\||[;|&\n\r]/u;

/** The simple commands of one resource, split at every list operator (no regex backtracking). */
export function shellSegments(command: string): readonly string[] {
  return command
    .replaceAll(BENIGN_REDIRECTION, " ")
    .split(SEGMENT_OPERATORS)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

interface WordScan {
  readonly words: string[];
  current: string;
  started: boolean;
  quote: "" | "'" | '"';
}

const EXPANSION_OR_REDIRECTION = new Set(["$", "`", "<", ">", "(", ")"]);

function flushWord(scan: WordScan): void {
  if (scan.started) scan.words.push(scan.current);
  scan.current = "";
  scan.started = false;
}

function append(scan: WordScan, text: string): void {
  scan.current += text;
  scan.started = true;
}

function scanSingleQuoted(scan: WordScan, char: string): number {
  if (char === "'") scan.quote = "";
  else scan.current += char;
  return 0;
}

function scanDoubleQuoted(scan: WordScan, char: string, next: string): number | undefined {
  if (char === '"') {
    scan.quote = "";
    return 0;
  }
  if (char === "$" || char === "`") return undefined;
  if (char === "\\" && (next === '"' || next === "\\" || next === "$" || next === "`")) {
    scan.current += next;
    return 1;
  }
  scan.current += char;
  return 0;
}

function scanBare(scan: WordScan, char: string, next: string): number | undefined {
  if (/\s/u.test(char)) {
    flushWord(scan);
    return 0;
  }
  if (EXPANSION_OR_REDIRECTION.has(char)) return undefined;
  if (char === "'" || char === '"') {
    scan.quote = char;
    scan.started = true;
    return 0;
  }
  if (char === "\\") {
    if (next === "") return undefined;
    append(scan, next);
    return 1;
  }
  append(scan, char);
  return 0;
}

function scanChar(scan: WordScan, char: string, next: string): number | undefined {
  if (scan.quote === "'") return scanSingleQuoted(scan, char);
  if (scan.quote === '"') return scanDoubleQuoted(scan, char, next);
  return scanBare(scan, char, next);
}

/**
 * The words of one simple command as a POSIX shell reads them (quotes and escapes removed), or
 * `undefined` when the text holds something this reader does not interpret: an unterminated quote,
 * a parameter or command expansion, a redirection or a subshell. Such text is never vetted.
 */
export function shellWords(segment: string): readonly string[] | undefined {
  const scan: WordScan = { words: [], current: "", started: false, quote: "" };
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment.charAt(index);
    const next = segment.charAt(index + 1);
    const skip = scanChar(scan, char, next);
    if (skip === undefined) return undefined;
    index += skip;
  }
  if (scan.quote !== "") return undefined;
  flushWord(scan);
  return scan.words;
}

// ---------------------------------------------------------------------------------------------
// Invocations: assignments and transparent wrappers
// ---------------------------------------------------------------------------------------------

const WRAPPER_PROGRAMS = new Set(["env", "command", "exec", "nice", "nohup", "time"]);
/** Wrapper options that take a separate argument (`env -u NAME`, `nice -n 10`). */
const WRAPPER_OPTIONS_WITH_VALUE = new Set([
  "-u",
  "--unset",
  "-n",
  "--adjustment",
  "-C",
  "--chdir",
]);
/** The only wrapper options a vetted command may carry: none changes what or where it runs. */
const SAFE_WRAPPER_OPTIONS = new Set([
  "-i",
  "--ignore-environment",
  "-u",
  "--unset",
  "-n",
  "--adjustment",
  "-p",
  "--",
]);
/**
 * Environment assignments a vetted command may carry. Anything else can redirect what the program
 * loads or runs (`LD_PRELOAD`, `NODE_OPTIONS`, `PATH`, `MAVEN_OPTS`, `GIT_SSH_COMMAND`, ...).
 */
const SAFE_ASSIGNMENT =
  /^(?:CI|NODE_ENV|FORCE_COLOR|NO_COLOR|TZ|TERM|COLUMNS|LANG|LC_[A-Z]+|RUST_BACKTRACE|RUST_LOG|CGO_ENABLED|DEBUG)=/u;
const ASSIGNMENT = /^[A-Za-z_]\w*=/u;

interface StrippedInvocation {
  readonly tokens: readonly string[];
  /** False when an assignment or a wrapper option outside the safe sets was dropped. */
  readonly clean: boolean;
}

function stripWrapper(tokens: readonly string[]): StrippedInvocation {
  let index = 1;
  let clean = true;
  while (index < tokens.length && tokens[index]?.startsWith("-") === true) {
    const option = tokens[index] ?? "";
    clean &&= SAFE_WRAPPER_OPTIONS.has(option);
    index += WRAPPER_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
    if (option === "--") break;
  }
  return { tokens: tokens.slice(index), clean };
}

function stripOnce(tokens: readonly string[]): StrippedInvocation | undefined {
  const [first] = tokens;
  if (first === undefined) return undefined;
  if (ASSIGNMENT.test(first))
    return { tokens: tokens.slice(1), clean: SAFE_ASSIGNMENT.test(first) };
  return WRAPPER_PROGRAMS.has(basename(first)) ? stripWrapper(tokens) : undefined;
}

function stripInvocationPrefix(tokens: readonly string[]): StrippedInvocation {
  let current = tokens;
  let clean = true;
  for (let guard = 0; guard < 8; guard += 1) {
    const stripped = stripOnce(current);
    if (stripped === undefined) break;
    current = stripped.tokens;
    clean &&= stripped.clean;
  }
  return { tokens: current, clean };
}

/** `[program, ...args]` with the program read by its basename, so `/usr/bin/git push` is `git push`. */
function withBasenameProgram(tokens: readonly string[]): readonly string[] {
  const [program, ...rest] = tokens;
  return program === undefined ? [] : [program.slice(program.lastIndexOf("/") + 1), ...rest];
}

/**
 * Whitespace tokens of one segment, reduced to the effective invocation: leading `NAME=value`
 * assignments and transparent wrappers (`env`, `command`, `exec`, `nice`, `nohup`, `time`) are
 * dropped with their own options, and a program given by path is read by its basename, so
 * `env git push`, `/usr/bin/git push` and `exec git push` all read as `git push`. Quoting is not
 * interpreted, so a token is at most a hint (#3897 review).
 */
export function commandTokens(segment: string): readonly string[] {
  return invocationTokens(segment.split(/\s+/u).filter((token) => token.length > 0));
}

/** The same reduction for words a shell reader already produced. */
export function invocationTokens(words: readonly string[]): readonly string[] {
  return withBasenameProgram(stripInvocationPrefix(words).tokens);
}

interface Invocation {
  readonly program: string;
  /** The program as written when it carried a directory (`./mvnw`, `/usr/bin/git`). */
  readonly path: string | undefined;
  readonly args: readonly string[];
}

function invocationOf(words: readonly string[]): Invocation | undefined {
  const stripped = stripInvocationPrefix(words);
  const [written, ...args] = stripped.tokens;
  if (!stripped.clean || written === undefined) return undefined;
  return {
    program: basename(written),
    path: written.includes("/") ? written : undefined,
    args,
  };
}

// ---------------------------------------------------------------------------------------------
// Option tables
// ---------------------------------------------------------------------------------------------

interface ToolSpec {
  /** Options that take a value (separate token, `=value`, or for short options attached). */
  readonly valueOptions: ReadonlySet<string>;
  /** The value options whose value names a place that must be inside the workspace. */
  readonly pathOptions: ReadonlySet<string>;
  /** Options that execute or write something elsewhere: never vetted. */
  readonly denied: ReadonlySet<string>;
  /** Boolean options. With `closed`, any other option is refused. */
  readonly flags: ReadonlySet<string>;
  readonly closed: boolean;
  /** Options with an optional numeric value (`make -j 4`). */
  readonly optionalNumeric?: ReadonlySet<string>;
  /** A value that must not appear after `-D` (`exec.executable`). */
  readonly deniedPropertyPrefixes?: readonly string[];
  /** `--` ends Maven's option parsing for nothing useful, so it is refused there. */
  readonly separatorRefused?: boolean;
}

const set = (...values: readonly string[]): ReadonlySet<string> => new Set(values);
const NO_OPTIONS: ReadonlySet<string> = set();

const MAVEN: ToolSpec = {
  valueOptions: set(
    "-pl",
    "--projects",
    "-f",
    "--file",
    "-T",
    "--threads",
    "-P",
    "--activate-profiles",
    "-s",
    "--settings",
    "-gs",
    "--global-settings",
    "-t",
    "--toolchains",
    "-rf",
    "--resume-from",
    "-b",
    "--builder",
    "-l",
    "--log-file",
    "-D",
    "--define",
  ),
  pathOptions: set(
    "-f",
    "--file",
    "-s",
    "--settings",
    "-gs",
    "--global-settings",
    "-t",
    "--toolchains",
    "-l",
    "--log-file",
  ),
  denied: NO_OPTIONS,
  flags: set(
    "-am",
    "--also-make",
    "-amd",
    "--also-make-dependents",
    "-o",
    "--offline",
    "-B",
    "--batch-mode",
    "-q",
    "--quiet",
    "-e",
    "--errors",
    "-X",
    "--debug",
    "-U",
    "--update-snapshots",
    "-N",
    "--non-recursive",
    "-ff",
    "--fail-fast",
    "-fae",
    "--fail-at-end",
    "-fn",
    "--fail-never",
    "-nsu",
    "--no-snapshot-updates",
    "-npu",
    "--no-plugin-updates",
    "-ntp",
    "--no-transfer-progress",
    "-C",
    "--strict-checksums",
    "-c",
    "--lax-checksums",
    "-V",
    "--show-version",
    "-v",
    "--version",
    "-h",
    "--help",
  ),
  closed: true,
  deniedPropertyPrefixes: ["exec."],
  separatorRefused: true,
};

const GRADLE: ToolSpec = {
  valueOptions: set(
    "-p",
    "--project-dir",
    "-b",
    "--build-file",
    "-c",
    "--settings-file",
    "-x",
    "--exclude-task",
    "--tests",
    "-g",
    "--gradle-user-home",
    "--include-build",
    "--project-cache-dir",
    "--max-workers",
    "--console",
    "--warning-mode",
    "-D",
    "-P",
  ),
  pathOptions: set(
    "-p",
    "--project-dir",
    "-b",
    "--build-file",
    "-c",
    "--settings-file",
    "-g",
    "--gradle-user-home",
    "--include-build",
    "--project-cache-dir",
  ),
  denied: NO_OPTIONS,
  flags: set(
    "--offline",
    "--info",
    "-i",
    "--debug",
    "-d",
    "--quiet",
    "-q",
    "--warn",
    "-w",
    "--stacktrace",
    "-s",
    "--full-stacktrace",
    "-S",
    "--no-daemon",
    "--daemon",
    "--parallel",
    "--no-parallel",
    "--continue",
    "--rerun-tasks",
    "--refresh-dependencies",
    "--build-cache",
    "--no-build-cache",
    "--configuration-cache",
    "--no-configuration-cache",
    "--dry-run",
    "-m",
    "--task-graph",
    "--version",
    "-v",
    "--help",
    "-h",
    "--watch-fs",
    "--no-watch-fs",
  ),
  closed: true,
};

const COMMON_PM_DENIED = set(
  "--script-shell",
  "--shell",
  "--userconfig",
  "--globalconfig",
  "--node-options",
  "-g",
  "--global",
  "--location",
);

const PM_SPECS: Readonly<Record<string, ToolSpec>> = {
  npm: {
    valueOptions: set("-w", "--workspace", "--prefix", "-C", "--cache", "--registry", "--loglevel"),
    pathOptions: set("--prefix", "-C", "--cache"),
    denied: COMMON_PM_DENIED,
    flags: set("-ws", "--workspaces", "--include-workspace-root", "--if-present"),
    closed: false,
  },
  pnpm: {
    valueOptions: set(
      "-F",
      "--filter",
      "--filter-prod",
      "-C",
      "--dir",
      "--workspace-concurrency",
      "--reporter",
      "--loglevel",
    ),
    pathOptions: set("-C", "--dir"),
    denied: COMMON_PM_DENIED,
    flags: set("-r", "--recursive", "-w", "--workspace-root", "--stream", "--parallel"),
    closed: false,
  },
  yarn: {
    valueOptions: set("--cwd"),
    pathOptions: set("--cwd"),
    denied: COMMON_PM_DENIED,
    flags: NO_OPTIONS,
    closed: false,
  },
  bun: {
    valueOptions: set("--cwd"),
    pathOptions: set("--cwd"),
    denied: COMMON_PM_DENIED,
    flags: NO_OPTIONS,
    closed: false,
  },
};

const CARGO: ToolSpec = {
  valueOptions: set(
    "-p",
    "--package",
    "--manifest-path",
    "--features",
    "-F",
    "--target",
    "--jobs",
    "-j",
    "--bin",
    "--test",
    "--example",
    "--bench",
    "--profile",
    "--target-dir",
    "--color",
    "--message-format",
    "--exclude",
  ),
  pathOptions: set("--manifest-path", "--target-dir"),
  denied: set("--config", "-Z"),
  flags: NO_OPTIONS,
  closed: false,
};

const GO: ToolSpec = {
  valueOptions: set("-C", "-o"),
  pathOptions: set("-C", "-o"),
  denied: set("-exec", "-toolexec", "-vettool", "-overlay", "-modfile"),
  flags: NO_OPTIONS,
  closed: false,
};

const MAKE: ToolSpec = {
  valueOptions: set(
    "-C",
    "--directory",
    "-f",
    "--file",
    "--makefile",
    "-I",
    "--include-dir",
    "-o",
    "--old-file",
    "-W",
    "--what-if",
    "-l",
    "--load-average",
  ),
  pathOptions: set("-C", "--directory", "-f", "--file", "--makefile", "-I", "--include-dir"),
  denied: set("--eval", "-E"),
  flags: NO_OPTIONS,
  closed: false,
  optionalNumeric: set("-j", "--jobs"),
};

const SPEC_BY_PROGRAM: Readonly<Record<string, ToolSpec>> = {
  mvn: MAVEN,
  mvnw: MAVEN,
  gradle: GRADLE,
  gradlew: GRADLE,
  cargo: CARGO,
  go: GO,
  make: MAKE,
  ...PM_SPECS,
};

function specOf(program: string): ToolSpec | undefined {
  return Object.hasOwn(SPEC_BY_PROGRAM, program) ? SPEC_BY_PROGRAM[program] : undefined;
}

/** Git global options that consume the next token (`git -C <path> push`, `git -c k=v push`). */
const GIT_OPTIONS_WITH_VALUE = set(
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
);

function valueOptionsOf(program: string | undefined): ReadonlySet<string> {
  if (program === "git") return GIT_OPTIONS_WITH_VALUE;
  return (program === undefined ? undefined : specOf(program))?.valueOptions ?? NO_OPTIONS;
}

/**
 * The first operand after `program`'s options, as `git <subcommand>` or `mvn <goal>` would read
 * it. A value option consumes its value (`mvn -pl api verify`, `npm -w pkg run test`), so the value
 * never reads as the subcommand.
 */
export function subcommandOf(tokens: readonly string[]): string | undefined {
  const options = valueOptionsOf(tokens[0]);
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (!token.startsWith("-")) return token;
    index += options.has(token) ? 2 : 1;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------------------------

interface ParsedArgs {
  readonly operands: readonly string[];
}

interface ParseState {
  readonly operands: string[];
  index: number;
}

interface ParseContext {
  readonly spec: ToolSpec;
  readonly root: string;
}

function valueAllowed(option: string, value: string, context: ParseContext): boolean {
  const { spec, root } = context;
  if (spec.pathOptions.has(option) && !pathInsideWorkspace(value, root)) return false;
  if (option === "-D" || option === "--define") {
    const prefixes = spec.deniedPropertyPrefixes ?? [];
    return !prefixes.some((prefix) => value.startsWith(prefix));
  }
  return true;
}

/** The option name of a token: `--file=x` is `--file`, `-Dx=y` is `-D` when `-D` takes a value. */
function optionName(token: string, spec: ToolSpec): { name: string; attached?: string } {
  const eq = token.indexOf("=");
  if (token.startsWith("--") && eq > 0)
    return { name: token.slice(0, eq), attached: token.slice(eq + 1) };
  if (spec.flags.has(token) || spec.valueOptions.has(token) || token.startsWith("--"))
    return { name: token };
  const short = token.slice(0, 2);
  if (token.length > 2 && !token.startsWith("--") && spec.valueOptions.has(short))
    return { name: short, attached: token.slice(2) };
  return { name: token };
}

function consumeValue(
  name: string,
  attached: string | undefined,
  args: readonly string[],
  state: ParseState,
  context: ParseContext,
): boolean {
  const value = attached ?? args[state.index + 1];
  if (value === undefined) return false;
  if (attached === undefined) state.index += 1;
  return valueAllowed(name, value, context);
}

function consumeOption(
  token: string,
  args: readonly string[],
  state: ParseState,
  context: ParseContext,
): boolean {
  const { spec } = context;
  const { name, attached } = optionName(token, spec);
  if (spec.denied.has(name)) return false;
  if (spec.valueOptions.has(name)) return consumeValue(name, attached, args, state, context);
  if (spec.optionalNumeric?.has(name) === true) {
    if (attached === undefined && /^\d+$/u.test(args[state.index + 1] ?? "")) state.index += 1;
    return true;
  }
  return !spec.closed || spec.flags.has(name);
}

/**
 * Splits `args` into operands, validating every option against the tool's table; `undefined` when
 * an option is denied, unknown to a closed table, lacks its value, or names a path outside the
 * workspace. Tokens after `--` are the program's own arguments and are not read.
 */
function parseArgs(args: readonly string[], spec: ToolSpec, root: string): ParsedArgs | undefined {
  const state: ParseState = { operands: [], index: 0 };
  const context: ParseContext = { spec, root };
  for (; state.index < args.length; state.index += 1) {
    const token = args[state.index] ?? "";
    if (token === "--") {
      if (spec.separatorRefused === true) return undefined;
      break;
    }
    if (!token.startsWith("-") || token === "-") state.operands.push(token);
    else if (!consumeOption(token, args, state, context)) return undefined;
  }
  return { operands: state.operands };
}

// ---------------------------------------------------------------------------------------------
// Vetted tools
// ---------------------------------------------------------------------------------------------

const MAVEN_GOALS = set(
  "validate",
  "initialize",
  "generate-sources",
  "process-sources",
  "generate-resources",
  "process-resources",
  "compile",
  "process-classes",
  "generate-test-sources",
  "process-test-sources",
  "generate-test-resources",
  "process-test-resources",
  "test-compile",
  "process-test-classes",
  "test",
  "prepare-package",
  "package",
  "pre-integration-test",
  "integration-test",
  "post-integration-test",
  "verify",
  "install",
  "clean",
  "dependency:tree",
);
const GRADLE_TASKS =
  /^(?::?[\w.-]+:)*(?:test|check|build|compileJava|compileTestJava|compileKotlin|compileTestKotlin|assemble|clean|classes|testClasses|jar|spotlessCheck|dependencies)$/u;
const SHORTHAND_SCRIPTS = set("build", "lint", "typecheck");
const PM_COMMON_SUBCOMMANDS = set("run", "test", "t", "run-script", "ci", "install", "i");
const CARGO_SUBCOMMANDS = set("test", "build", "check", "clippy", "fmt");
const GO_SUBCOMMANDS = set("test", "build", "vet", "fmt");
const MAKE_TARGETS = set("test", "check", "build", "lint");
const GIT_READ_SUBCOMMANDS = set(
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "ls-files",
  "rev-parse",
  "describe",
  "grep",
  "shortlog",
  // Reserved subcommands whose read-only forms stay available (READ_ONLY_GIT_FORMS). The reserved
  // check runs before vetting, so only those forms reach this set; their writes stay refused.
  "branch",
  "stash",
  "remote",
  "tag",
  "worktree",
  "submodule",
  "config",
  "symbolic-ref",
  "reflog",
  "notes",
);
const NPX_TOOLS = set(
  "vitest",
  "jest",
  "mocha",
  "tsc",
  "eslint",
  "prettier",
  "playwright",
  "tsx",
  "ts-node",
  "next",
  "vite",
  "turbo",
  "nx",
);
const NPX: ToolSpec = {
  valueOptions: NO_OPTIONS,
  pathOptions: NO_OPTIONS,
  denied: set("-p", "--package", "-c", "--call", "--shell"),
  flags: set("--no-install", "--no", "-q", "--quiet"),
  closed: true,
};
const WRAPPER_SCRIPTS = set("mvnw", "gradlew");
const SYSTEM_BIN_DIRECTORIES = set("/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin");
const SCRIPT_SHELLS = set("bash", "sh", "zsh", "dash");

function mavenVetted(args: readonly string[], root: string): boolean {
  const parsed = parseArgs(args, MAVEN, root);
  return (
    parsed !== undefined &&
    parsed.operands.length > 0 &&
    parsed.operands.every((goal) => MAVEN_GOALS.has(goal))
  );
}

function gradleVetted(args: readonly string[], root: string): boolean {
  const parsed = parseArgs(args, GRADLE, root);
  return (
    parsed !== undefined &&
    parsed.operands.length > 0 &&
    parsed.operands.every((task) => GRADLE_TASKS.test(task))
  );
}

function packageManagerVetted(program: string, args: readonly string[], root: string): boolean {
  const spec = specOf(program);
  const parsed = spec === undefined ? undefined : parseArgs(args, spec, root);
  const [subcommand, ...rest] = parsed?.operands ?? [];
  if (subcommand === undefined) return false;
  if (program === "yarn" && subcommand === "workspace") return rest.length >= 2;
  if (PM_COMMON_SUBCOMMANDS.has(subcommand)) return true;
  return program !== "npm" && SHORTHAND_SCRIPTS.has(subcommand);
}

function npxVetted(args: readonly string[], root: string): boolean {
  const [tool] = parseArgs(args, NPX, root)?.operands ?? [];
  return tool !== undefined && NPX_TOOLS.has(tool);
}

function firstOperandVetted(parsed: ParsedArgs | undefined, allowed: ReadonlySet<string>): boolean {
  let [subcommand] = parsed?.operands ?? [];
  if (subcommand?.startsWith("+") === true) subcommand = parsed?.operands[1];
  return subcommand !== undefined && allowed.has(subcommand);
}

function makeVetted(args: readonly string[], root: string): boolean {
  const targets = (parseArgs(args, MAKE, root)?.operands ?? []).filter(
    (operand) => !ASSIGNMENT.test(operand),
  );
  return targets.length > 0 && targets.every((target) => MAKE_TARGETS.has(target));
}

/** Git global options: only `-C <inside>` and `-c <safe key>` can precede a vetted read. */
const SAFE_GIT_CONFIG_KEY = /^(?:color\.[\w.-]+|core\.(?:quotepath|abbrev|precomposeunicode))$/iu;
const SAFE_GIT_FLAGS = set(
  "--no-pager",
  "-P",
  "--no-optional-locks",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
);

interface GitCommand {
  readonly subcommand: string;
  readonly rest: readonly string[];
}

function gitGlobalValueAllowed(option: string, value: string, root: string): boolean {
  if (option === "-C" || option === "--git-dir" || option === "--work-tree")
    return pathInsideWorkspace(value, root);
  return option === "-c" && SAFE_GIT_CONFIG_KEY.test(value.split("=", 1)[0] ?? value);
}

function gitCommandOf(args: readonly string[], root: string): GitCommand | undefined {
  let index = 0;
  while (index < args.length) {
    const token = args[index] ?? "";
    if (!token.startsWith("-")) return { subcommand: token, rest: args.slice(index + 1) };
    if (SAFE_GIT_FLAGS.has(token)) index += 1;
    else if (GIT_OPTIONS_WITH_VALUE.has(token)) {
      const value = args[index + 1];
      if (value === undefined || !gitGlobalValueAllowed(token, value, root)) return undefined;
      index += 2;
    } else return undefined;
  }
  return undefined;
}

function gitExecutingOption(subcommand: string, option: string): boolean {
  const name = option.split("=", 1)[0] ?? option;
  if (name === "--output" || name === "--ext-diff" || name === "--textconv") return true;
  return subcommand === "grep" && (option.startsWith("-O") || name === "--open-files-in-pager");
}

function gitVetted(args: readonly string[], root: string): boolean {
  const command = gitCommandOf(args, root);
  return (
    command !== undefined &&
    GIT_READ_SUBCOMMANDS.has(command.subcommand) &&
    !command.rest.some((option) => gitExecutingOption(command.subcommand, option))
  );
}

function shortClusterHas(args: readonly string[], letter: string): boolean {
  return args.some((arg) => /^-[^-]/u.test(arg) && arg.slice(1).includes(letter));
}

function optionNamed(args: readonly string[], ...names: readonly string[]): boolean {
  return args.some((arg) => names.includes(arg.split("=", 1)[0] ?? arg));
}

const FIND_EXECUTING = [
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
];

/**
 * Inspection tools whose invocation is vetted unless an option makes them execute another command
 * or write a file: `find -exec`, `rg --pre`, `sort -o`, `uniq in out`, `tree -o`.
 */
const INSPECTION_TOOLS: Readonly<Record<string, (args: readonly string[]) => boolean>> = {
  find: (args) => !optionNamed(args, ...FIND_EXECUTING),
  rg: (args) => !optionNamed(args, "--pre", "--hostname-bin"),
  sort: (args) =>
    !optionNamed(args, "--output", "--compress-program") && !shortClusterHas(args, "o"),
  uniq: (args) => args.filter((arg) => !arg.startsWith("-") && !/^\d+$/u.test(arg)).length <= 1,
  tree: (args) => !shortClusterHas(args, "o"),
  file: (args) => !shortClusterHas(args, "C") && !optionNamed(args, "--compile"),
  date: (args) =>
    !shortClusterHas(args, "s") &&
    !optionNamed(args, "--set") &&
    args.every((arg) => arg.startsWith("-") || arg.startsWith("+")),
  pytest: () => true,
  ls: () => true,
  cat: () => true,
  head: () => true,
  tail: () => true,
  wc: () => true,
  grep: () => true,
  pwd: () => true,
  echo: () => true,
  which: () => true,
  env: () => true,
  printenv: () => true,
  diff: () => true,
  stat: () => true,
  du: () => true,
};

function nodeVetted(args: readonly string[], root: string): boolean {
  const [first] = args;
  if (first === "--test") return true;
  return (
    first !== undefined && /\.(?:m?js|c?js|ts)$/u.test(first) && pathInsideWorkspace(first, root)
  );
}

function pythonVetted(args: readonly string[]): boolean {
  return args[0] === "-m" && (args[1] === "pytest" || args[1] === "unittest");
}

/** `cd` is navigation: vetted only into a place inside the workspace (physically, links followed). */
function cdVetted(args: readonly string[], root: string): boolean {
  const [target, ...rest] = args;
  return (
    target !== undefined &&
    rest.length === 0 &&
    !target.startsWith("-") &&
    pathInsideWorkspace(target, root)
  );
}

/** The program as written must be a system binary or, for a wrapper script, a file in the workspace. */
function programPathTrusted(invocation: Invocation, root: string): boolean {
  const { path, program } = invocation;
  if (path === undefined) return true;
  if (WRAPPER_SCRIPTS.has(program)) return pathInsideWorkspace(path, root);
  return SYSTEM_BIN_DIRECTORIES.has(path.slice(0, path.lastIndexOf("/")));
}

/** `bash ./mvnw test`: the repository's own wrapper script run through a shell. */
function wrapperScriptViaShell(invocation: Invocation): Invocation | undefined {
  const [script, ...args] = invocation.args;
  if (!SCRIPT_SHELLS.has(invocation.program) || script === undefined) return undefined;
  const program = basename(script);
  return WRAPPER_SCRIPTS.has(program) ? { program, path: script, args } : undefined;
}

type Vet = (invocation: Invocation, root: string) => boolean;

const packageManager =
  (program: string): Vet =>
  ({ args }, root) =>
    packageManagerVetted(program, args, root);

const VETTED_PROGRAMS: Readonly<Record<string, Vet>> = {
  mvn: ({ args }, root) => mavenVetted(args, root),
  mvnw: ({ args }, root) => mavenVetted(args, root),
  gradle: ({ args }, root) => gradleVetted(args, root),
  gradlew: ({ args }, root) => gradleVetted(args, root),
  npm: packageManager("npm"),
  pnpm: packageManager("pnpm"),
  yarn: packageManager("yarn"),
  bun: packageManager("bun"),
  npx: ({ args }, root) => npxVetted(args, root),
  cargo: ({ args }, root) => firstOperandVetted(parseArgs(args, CARGO, root), CARGO_SUBCOMMANDS),
  go: ({ args }, root) => firstOperandVetted(parseArgs(args, GO, root), GO_SUBCOMMANDS),
  make: ({ args }, root) => makeVetted(args, root),
  git: ({ args }, root) => gitVetted(args, root),
  node: ({ args }, root) => nodeVetted(args, root),
  python: ({ args }) => pythonVetted(args),
  python3: ({ args }) => pythonVetted(args),
  cd: ({ args }, root) => cdVetted(args, root),
};

function vettedProgram(invocation: Invocation, root: string): boolean {
  const { program, args } = invocation;
  if (Object.hasOwn(VETTED_PROGRAMS, program))
    return VETTED_PROGRAMS[program]?.(invocation, root) === true;
  return Object.hasOwn(INSPECTION_TOOLS, program) && INSPECTION_TOOLS[program]?.(args) === true;
}

/** Whether one simple command (already split at list operators) is vetted. */
export function isVettedCommandSegment(segment: string, root: string): boolean {
  const words = shellWords(segment);
  const invocation = words === undefined ? undefined : invocationOf(words);
  if (invocation === undefined) return false;
  const effective = wrapperScriptViaShell(invocation) ?? invocation;
  return programPathTrusted(effective, root) && vettedProgram(effective, root);
}

// ---------------------------------------------------------------------------------------------
// Verification support: path-valued options that leave the workspace
// ---------------------------------------------------------------------------------------------

/**
 * Whether a check's path-valued option (`mvn -f`, `npm --prefix`, `make -C`) names a place outside
 * the workspace lexically, so the line can never be evidence for the task's own project.
 */
export function pathOptionLeavesWorkspace(tokens: readonly string[]): boolean {
  const spec = specOf(tokens[0] ?? "");
  if (spec === undefined) return false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "--") return false;
    const { name, attached } = optionName(token, spec);
    if (!spec.pathOptions.has(name)) continue;
    if (valueLeavesWorkspace(attached ?? tokens[index + 1] ?? "")) return true;
  }
  return false;
}

function valueLeavesWorkspace(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~") || value.split("/").includes("..");
}
