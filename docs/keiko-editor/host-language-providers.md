# Host Language Providers

Issue [#1382](https://github.com/oscharko-dev/Keiko/issues/1382) adds host-toolchain provider
detection for Java, Python, Go, Rust, and Shell language intelligence. Keiko does not install,
download, bundle, or auto-update these tools. Operators provision them on the host, place the
executables on `PATH`, explicitly enable each provider, and Keiko reports structured availability through
`GET /api/editor/language/capabilities`.

Core editing remains available when a provider is missing, disabled, policy-blocked, or resolves
inside the workspace. Missing providers only disable governed diagnostics, completion, hover, symbols,
and formatting for that language.

## Provider Inventory

| Language | Provider id  | Required host tools                  | Executable launched by Keiko | Advertised operations                               |
| -------- | ------------ | ------------------------------------ | ---------------------------- | --------------------------------------------------- |
| Python   | `python-lsp` | `pyright-langserver`                 | `pyright-langserver --stdio` | diagnostics, completion, hover, symbols             |
| Java     | `java-lsp`   | `java`, `jdtls`                      | `jdtls`                      | diagnostics, completion, hover, symbols, formatting |
| Go       | `go-lsp`     | `gopls`                              | `gopls`                      | diagnostics, completion, hover, symbols, formatting |
| Rust     | `rust-lsp`   | `rust-analyzer`                      | `rust-analyzer`              | diagnostics, completion, hover, symbols, formatting |
| Shell    | `shell-lsp`  | `bash-language-server`, `shellcheck` | `bash-language-server start` | diagnostics, completion, hover, symbols             |

Provider records are content-free: they include ids, language ids, operation names, availability, and
short unavailable reasons. They do not include resolved executable paths, workspace paths, source text,
stderr, or tool output.

## Detection Policy

For each provider, Keiko checks the required bare executable names against the host execution
allowlist and resolves them on `PATH`. Providers are disabled by default; an installed executable is
not reported available and is not launched until its per-provider policy flag is explicitly true-like.
A provider is reported as unavailable when any required tool:

- lacks an explicit provider enable flag;
- is absent from `PATH`;
- is blocked by command policy;
- resolves lexically or by realpath inside the workspace root;
- is disabled by its provider policy flag.

The launched LSP process uses the governed process manager: copy-only environment allowlist,
ephemeral `HOME` / `USERPROFILE`, workspace-external executable resolution, request deadlines, frame
byte caps, restart throttling, a global in-flight operation cap, and content-free lifecycle records.

## Enterprise Setup

Recommended enterprise provisioning:

1. Install language servers and toolchains through the organization's normal package-management path.
2. Pin tool versions, checksums, and license approvals in the enterprise workstation image or developer
   setup guide.
3. Keep provider binaries outside repository workspaces and outside writable project directories.
4. Provide only the required executables on `PATH`; do not route Keiko through `npm exec`, `npx`,
   shell wrappers, or workspace-local launch scripts.
5. For Java and Rust, keep code-executing indexing features disabled unless a separate security review
   has approved enforced network and filesystem isolation for the LSP indexing process.

Per-provider policy flags enable detection and execution without changing the host image:

```text
KEIKO_EDITOR_LSP_PYTHON=1
KEIKO_EDITOR_LSP_JAVA=1
KEIKO_EDITOR_LSP_GO=1
KEIKO_EDITOR_LSP_RUST=1
KEIKO_EDITOR_LSP_SHELL=1
```

Accepted true-like values are `1`, `true`, `on`, `yes`, and `enabled`. Any absent or non-true-like
value leaves the provider unavailable with `Host language provider is disabled by policy.`

## Troubleshooting

When a language provider is unavailable, inspect the editor status bar or the capabilities endpoint.
Common reasons:

- `Required host language tool is missing or resolves inside the workspace.`
- `Required host language tool is blocked by host execution policy.`
- `Host language provider is disabled by policy.`

The remedy is to provision the tool outside the workspace, explicitly enable the provider, or adjust
the host allowlist. Do not commit tool binaries, wrapper scripts, credentials, or local runtime logs to
the repository.
