# Restore a governed Node.js debug launch

## Restore an unavailable debug capsule backend

| Field             | Value                       |
| ----------------- | --------------------------- |
| Severity          | High                        |
| Surface           | Local UI / Run engine       |
| Stable identifier | `DEBUG_CAPSULE_UNAVAILABLE` |

**Symptom**

The local UI rejects a debug start with `DEBUG_CAPSULE_UNAVAILABLE`; no adapter or workspace process
starts.

**Root Cause**

No currently probed backend can enforce one execution-root capsule with `network: "none"`, a
qualified descendant scope, immutable provisioning mounts, and the private runtime mount. Native
macOS and Windows execution are intentionally unsupported; those hosts require a qualified,
digest-pinned container backend.

**Diagnostic Steps**

Run the hermetic planner tests. They disclose capability classes only and never endpoint paths.

```bash
npm exec vitest -- run packages/keiko-sandbox/src/debug-capsule.test.ts packages/keiko-server/src/editor/dap/debugLaunchReachability.spike.test.ts
```

A passing fail-closed case confirms an unavailable or unqualified backend. A planner assertion
failure indicates provisioning or attestation drift.

**Resolution**

Provision the approved Bubblewrap backend on Linux. OCI argv planning remains fail-closed in the
current production launcher until container-id and cgroup inspection and teardown are qualified; a
digest-pinned image alone does not enable debugging. Do not enable host networking, publish a port,
or run the adapter on the host as a workaround. See
[ADR-0136](../adr/ADR-0136-governed-debug-adapter-session-management.md).

## Restore a rejected launch target

| Field             | Value                                                       |
| ----------------- | ----------------------------------------------------------- |
| Severity          | High                                                        |
| Surface           | Local UI / Workspace                                        |
| Stable identifier | `INVALID_TARGET`, `WORKSPACE_ESCAPE`, `WORKSPACE_UNTRUSTED` |

**Symptom**

Starting a file or package-script debug target fails with one of the stable identifiers above.

**Root Cause**

The server re-derived the opaque target from current workspace state and found an untrusted or stale
catalog entry, an unsupported file extension, a non-regular file, an absolute path, or a lexical or
realpath escape. Symlink targets outside the workspace fail closed.

**Diagnostic Steps**

Confirm that the selected file is a workspace-relative regular `.js`, `.mjs`, `.cjs`, `.ts`,
`.mts`, or `.cts` file, or refresh the visible command catalog after changing `package.json`.

```bash
npm exec vitest -- run packages/keiko-server/src/editor/dap/debugLaunchCatalog.test.ts
```

**Resolution**

Trust the intended workspace through the normal local-human control, select a current catalog id, or
move the target to a regular contained file. Do not replace the target with argv, a shell command, or
an absolute path.

## Restore the private debug endpoint

| Field             | Value                                                      |
| ----------------- | ---------------------------------------------------------- |
| Severity          | High                                                       |
| Surface           | Run engine                                                 |
| Stable identifier | `PRIVATE_ENDPOINT_INVALID`, `PRIVATE_ENDPOINT_UNSUPPORTED` |

**Symptom**

The capsule starts but the session fails before protocol initialization with a private-endpoint
identifier.

**Root Cause**

The host runtime directory, capsule mount, or socket topology failed owner, `0700`, realpath,
component-containment, length, mount-identity, or endpoint-type validation. Host and in-capsule
socket paths are intentionally distinct and are never sent to the browser.

On POSIX, Node does not expose a portable `SO_PEERCRED` verification API. V1 therefore binds the
peer boundary to the same Keiko service identity and a private `0700` runtime directory: after the
debuggee creates its socket and immediately before Keiko connects, the runtime directory's realpath,
device, inode, mode, and owner are compared to the spawn envelope. A replacement fails closed.

**Diagnostic Steps**

Run the endpoint and plan tests; diagnostics expose only the stable code and qualification status.

```bash
npm exec vitest -- run packages/keiko-server/src/editor/dap/dapPrivateEndpoint.test.ts packages/keiko-server/src/editor/dap/debugLaunchPlan.test.ts
```

**Resolution**

Recreate the Keiko-owned private runtime directory and retry with the approved capsule backend. Do
not broaden directory permissions or replace the private endpoint with TCP.

## Restore approved runtime and npm configuration

| Field             | Value                  |
| ----------------- | ---------------------- |
| Severity          | High                   |
| Surface           | Run engine / Workspace |
| Stable identifier | `INVALID_CAPSULE_PLAN` |

**Symptom**

The launch is rejected before spawn with `INVALID_CAPSULE_PLAN`.

**Root Cause**

An approved adapter, Node, npm, shell, PATH, environment, immutable mount, image digest, activation
revision, or provisioning identity drifted. Workspace `script-shell`, npm configuration, lifecycle
hook substitution, planted executables, and extra launch arguments are rejected.

**Diagnostic Steps**

Verify only the approved operator-managed runtime locations and run the closed-policy tests.

```bash
npm exec vitest -- run packages/keiko-tools/src/debug-launch-policy.test.ts packages/keiko-server/src/editor/dap/debugLaunchPlan.test.ts
```

Content-free diagnostics intentionally omit argv, paths, script bodies, environment values, socket
names, and program output.

**Resolution**

Restore the approved immutable artifacts, including the two distinct empty npm configuration
artifacts, refresh activation, and select the target again. The closed npm tuple uses the approved
shell and ignores project configuration while redirecting user and global configuration to those
separate immutable files. Never add workspace PATH entries, ambient npm configuration, host
networking, or free-form browser execution fields to bypass validation.

## Configure operator-owned DAP provisioning

The BFF reads the optional `KEIKO_DAP_OPERATOR_PROVISIONING_JSON` deployment environment value at
startup. It is deliberately ignored by repository-local `.env` discovery: set it only in the
operator-controlled service environment. Missing, malformed, or stale data leaves debugging
unavailable; it never falls back to an ambient executable, PATH, browser value, or workspace file.

The value is a strict JSON document with `schemaVersion: 1`, an `adapter` section
(`executableName`, fixed `executableArgs`, `trustedRoots`, and an approved `PATH`), and a `launch`
section naming the immutable Node, npm, shell, empty npm-config, sandbox-backend, and runtime-closure
artifacts. Every host path must be absolute and live beneath its explicit operator-approved root;
the two npm configuration artifacts must project exactly to
`/opt/keiko-debug/npm-user-config` and `/opt/keiko-debug/npm-global-config`. The BFF derives the
preflight, launch-context, and target-revalidation ports from this declaration itself. Functions,
unknown keys, protected environment variables, relative paths, duplicate values, and caller-supplied
process arguments are rejected before the DAP service is composed.

Do not place the declaration in a workspace or send it through an HTTP route. It is configuration
for the local Keiko service process, not a user preference. The local human must still explicitly
enable the existing workspace `debuggingEnabled` setting after all provisioning and deployment gates
are available.
