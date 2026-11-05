import { OPENCODE_NATIVE_SHELL_ENV_DENYLIST } from "./opencodeNativePolicyPlugin.js";

export const OPENCODE_NATIVE_LAUNCH_SECRETS_PLUGIN_FILE = "keiko_launch_secrets";
export const OPENCODE_NATIVE_LAUNCH_SECRETS_PLUGIN_ID = "keiko.launch-secrets";

/**
 * What a child could use against the run: the runtime's API password, the server-owned binding with
 * each relayed MCP server's capability, and the run's two capabilities. The other bindings of the
 * shell's denylist name no authority, and their values can legitimately repeat in another variable,
 * which the read-back below would mistake for a survivor.
 */
const OPENCODE_NATIVE_LAUNCH_SECRET_NAMES = Object.freeze([
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_CONFIG_CONTENT",
  "KEIKO_MODEL_GATEWAY_CAPABILITY",
  "KEIKO_TOOL_FACADE_CAPABILITY",
]);

/** `kern.argmax`, the most the kernel answers; it refuses a larger buffer as an invalid argument. */
const PROCESS_ARGUMENTS_BUFFER_BYTES = 1_024 * 1_024;

/**
 * macOS answers `sysctl(KERN_PROCARGS2)` for any process of the same user, reading the argument and
 * environment strings from the target's stack, and no Seatbelt rule gates that call (proved on the
 * pinned runtime with a default-deny profile). A shell child could therefore read the runtime's
 * password and the run's capabilities straight from its exec environment, then drive routes of the
 * runtime's API the per-action policy never sees. The runtime can only receive them there, so this
 * generated plugin overwrites the values in place as soon as the runtime loads, before any shell
 * exists, the way database clients clear a password from their arguments. The runtime keeps working
 * from its own copy of the environment, and a child can read neither (a task port for a hardened
 * process is refused).
 *
 * The plugin reads the same kernel answer back and fails if a value is still there. A failed plugin
 * fails the run's readiness, so a runtime where this stops working (another JavaScript engine, a
 * changed stack layout) is refused rather than left exposed. It is native-only and macOS-only, the
 * one place the native profile is qualified.
 *
 * The runtime also starts children itself, a formatter or a local MCP server, by spreading
 * `process.env`, and the shell hook sees none of them. A formatter is the repository's own code at
 * Full access (#4271). So the bindings stop being enumerable, here and for every later reader: the
 * runtime still reads each one by name when it reloads its configuration, and a spread omits them.
 * `process.env` itself refuses such a property, so a plain object takes its place. Unlike the
 * overwrite this holds on every platform. The plugin checks the spread and fails if a name survived.
 */
export function createGeneratedOpenCodeLaunchSecretsPlugin(): string {
  return [
    'import { CString, FFIType, dlopen, ptr, read } from "bun:ffi";',
    `const NAMES = new Set(${JSON.stringify(OPENCODE_NATIVE_LAUNCH_SECRET_NAMES)});`,
    `const BUFFER_BYTES = ${String(PROCESS_ARGUMENTS_BUFFER_BYTES)};`,
    "const CTL_KERN = 1;",
    "const KERN_PROCARGS2 = 49;",
    "const MAX_ENTRIES = 65_536;",
    "function overwriteValues(libc) {",
    "  const values = [];",
    "  const entries = read.ptr(libc.symbols._NSGetEnviron());",
    "  for (let index = 0; index < MAX_ENTRIES; index += 1) {",
    "    const entry = read.ptr(entries, index * 8);",
    "    if (!entry) return values;",
    "    const text = new CString(entry).toString();",
    "    const separator = text.indexOf('=');",
    "    if (separator <= 0 || !NAMES.has(text.slice(0, separator))) continue;",
    "    const value = text.slice(separator + 1);",
    "    if (value.length === 0) continue;",
    "    values.push(value);",
    "    libc.symbols.memset(entry + separator + 1, 0, Buffer.byteLength(value));",
    "  }",
    "  throw new Error('environment-unbounded');",
    "}",
    "function assertUnreadable(libc, values) {",
    "  const answer = Buffer.alloc(BUFFER_BYTES);",
    "  const size = new BigUint64Array([BigInt(BUFFER_BYTES)]);",
    "  const mib = new Int32Array([CTL_KERN, KERN_PROCARGS2, process.pid]);",
    "  if (libc.symbols.sysctl(ptr(mib), 3, ptr(answer), ptr(size), null, 0) !== 0) throw new Error('process-arguments-unavailable');",
    "  const visible = answer.subarray(0, Number(size[0]));",
    "  if (values.some((value) => visible.includes(value))) throw new Error('launch-secret-readable');",
    "}",
    "function protectLaunchSecrets() {",
    "  const libc = dlopen('/usr/lib/libSystem.B.dylib', {",
    "    _NSGetEnviron: { args: [], returns: FFIType.ptr },",
    "    memset: { args: [FFIType.ptr, FFIType.i32, FFIType.u64], returns: FFIType.ptr },",
    "    sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },",
    "  });",
    "  try { assertUnreadable(libc, overwriteValues(libc)); } finally { libc.close(); }",
    "}",
    `const INHERITED = new Set(${JSON.stringify(OPENCODE_NATIVE_SHELL_ENV_DENYLIST)});`,
    "const isWithheld = (name) => INHERITED.has(name) || name.startsWith('KEIKO_');",
    "function withholdFromChildren() {",
    "  const environment = {};",
    "  for (const name of Object.keys(process.env)) {",
    "    const enumerable = !isWithheld(name);",
    "    Object.defineProperty(environment, name, { value: process.env[name], enumerable, writable: true, configurable: true });",
    "  }",
    "  process.env = environment;",
    "  if (Object.keys({ ...process.env }).some((name) => isWithheld(name))) throw new Error('launch-secret-inherited');",
    "}",
    "export default {",
    `  id: ${JSON.stringify(OPENCODE_NATIVE_LAUNCH_SECRETS_PLUGIN_ID)},`,
    "  async setup() {",
    "    withholdFromChildren();",
    "    if (process.platform === 'darwin') protectLaunchSecrets();",
    "  },",
    "};",
  ].join("\n");
}
