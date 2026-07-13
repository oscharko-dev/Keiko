# Managed Shell language provider verification evidence

This is the deterministic release profile for Epic #2094 / child #2277. It downloads nothing and
never executes a workspace script, shebang, command substitution, trap, startup profile, formatter,
package manager, plugin, or arbitrary command.

## Supported and security profile

- Bash Language Server `5.6.0`, Node 22, and ShellCheck `0.11.0`, all operator-provisioned outside
  the workspace.
- LSP 3.18 over bounded stdio; default-off, revision-guarded workspace activation.
- A per-process private PATH exposes only realpath-validated `node` and `shellcheck` links. The
  operator PATH, workspace binaries, `shfmt`, and package managers are unreachable to descendants.
- Closed settings only: `bash | posix`, ShellCheck mode and severity, up to 32 `SCdddd` exclusions,
  and up to 32 realpath-contained source paths.
- External sources, explainshell, background workspace analysis, shfmt, and editorconfig formatting
  are disabled. `HOME`, `BASH_ENV`, `ENV`, and arbitrary environment values are not inherited.
- Only diagnostics, completion, hover, document symbols, definition, and references are candidates;
  the negotiated subset is authoritative.

## Automated evidence

| Concern             | Proof                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No execution        | Hostile fixtures contain command substitutions, backticks, traps, hostile shebangs, profile files, absolute sourcing, and a 128 KiB heredoc; sentinels and source files remain unchanged. |
| Descendant trust    | Adapter and provider tests prove workspace PATH shadowing fails before spawn and the child PATH contains only links to the approved Node and ShellCheck realpaths.                        |
| Negotiation         | Fake conformance executes all six read-only candidates after live negotiation; formatting and rename remain absent even when the server advertises more.                                  |
| Limits              | Contract caps cover exclusions/include paths; a 700-item diagnostics storm truncates to 512; frame, queue, request deadline, and sanitizer caps remain shared.                            |
| Lifecycle           | Shell conformance proves cancellation, crash recovery with a fresh private PATH, warm reuse, private-path cleanup, targeted restart, and shared process-group termination.                |
| Content-free status | Shared lifecycle/evidence contracts expose only enums, revisions, counts, timestamps, latency buckets, and opaque provider ids; fixture text and stderr are absent.                       |

Run the hermetic profile:

```bash
npm exec vitest -- run packages/keiko-server/src/editor/lsp/providers/shellProvider.test.ts packages/keiko-server/src/editor/lsp/providers/shellProvider.conformance.test.ts packages/keiko-server/src/editor/lsp/lspNodeAdapter.test.ts packages/keiko-server/src/editor/lsp/lspProcessManager.test.ts packages/keiko-server/src/editor/lsp/lspSecurity.test.ts
```

The optional real smoke is enabled only when `KEIKO_TEST_BASH_LSP_BIN_DIR` names a pre-provisioned
directory containing the pinned `bash-language-server`, `node`, and `shellcheck` binaries. It skips
explicitly otherwise and never installs or downloads. Evidence is limited to versions, operation
counts, latency/resource counters, cancellation count, and pass/fail status.

Acceptance requires cold initialization and warm reuse within configured deadlines, zero pending
requests after cancellation, byte-identical fixtures, no sentinel side effects, no unexpected PATH
entry, bounded diagnostics, no network activity, and complete descendant termination on disposal.
