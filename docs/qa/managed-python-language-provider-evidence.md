# Managed Python language provider verification evidence

This profile is the release evidence contract for Epic #2094 / child #2276. It is deterministic,
body-free, and does not download tools or dependencies. The operator supplies the approved Pyright
runtime outside the workspace.

## Supported profile

- Provider: Pyright `1.1.410`, `pyright-langserver --stdio`.
- Protocol: LSP 3.18 over bounded stdio JSON-RPC.
- Default: disabled; activation and runtime identity are workspace-scoped and revision guarded.
- Configuration: `pyrightconfig.json` > `[tool.pyright]` in `pyproject.toml` > governed workspace
  settings. Project files are inspected only when regular, contained, and at most 1 MiB.
- Network/download behavior: no downloads; no provider-specific egress; no arbitrary Python
  environment passthrough.
- Refactoring: rename and code actions return bounded review artifacts only. They do not write.

## Automated profile

| Concern               | Deterministic proof                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Advertised operations | `pythonProvider.conformance.test.ts` negotiates and executes every candidate against the shared fake protocol server.                                                                                                                       |
| Cold/warm lifecycle   | The same conformance run uses one initialized process for all operations; pool tests prove one spawn plus `didOpen`/`didChange` reuse and targeted disposal.                                                                                |
| Latency               | `lspProcessManager.test.ts` injects the clock and verifies content-free count, total, maximum, and bucket metrics.                                                                                                                          |
| Cancellation/deadline | Manager and JSON-RPC tests prove `AbortSignal`, `$/cancelRequest`, timeout, pending-request cleanup, and bounded initialization.                                                                                                            |
| Large/hostile input   | Contract and route limits reject oversized documents; frame tests reject oversized responses before body allocation; result sanitizers cap every returned family.                                                                           |
| Memory                | Frame, document, configuration, operation, and result caps bound retained product data. Production acceptance additionally records child RSS externally because Keiko deliberately does not grant the LSP process an introspection channel. |
| Security              | Provider tests prove no `PYTHONPATH`, `VIRTUAL_ENV`, runtime id, executable path, or escaping configuration enters the protocol boundary. Existing executable-containment tests reject workspace and symlinked binaries.                    |
| Review-only edits     | The conformance fixture snapshots the Python file before all rename/code-action operations and proves byte equality afterward.                                                                                                              |

Run the hermetic profile:

```bash
npm exec vitest -- run packages/keiko-server/src/editor/lsp/providers/pythonProvider.test.ts packages/keiko-server/src/editor/lsp/providers/pythonProvider.conformance.test.ts packages/keiko-server/src/editor/lsp/hostLanguageOperation.pool.test.ts packages/keiko-server/src/editor/lsp/lspProcessManager.test.ts packages/keiko-server/src/editor/lsp/lspJsonRpcClient.test.ts packages/keiko-server/src/editor/languageRoutes.test.ts
```

## Operator real-server smoke

The smoke is optional in developer environments and mandatory before approving a new Pyright
version for production. It must run offline with an already provisioned executable. Record only the
version, fixture hash, operation counts, latency histogram, maximum child RSS, cancellation count,
and pass/fail status. Never record source, diagnostics, paths, or provider stderr.

Use deterministic small, large (up to Keiko's document cap), cross-file navigation, rename, and
code-action fixtures. Acceptance requires:

- all operations are a negotiated subset of the provider candidate list;
- one cold initialize and at least one warm reuse complete within configured deadlines;
- cancellation leaves zero pending requests;
- returned results remain within contract caps;
- child RSS remains within the deployment's approved process budget;
- restart replaces only Python and leaves another warm provider untouched;
- the fixture tree remains byte-identical after rename and code-action previews.

Rollback is configuration-only: deactivate Python or restore the previous revision, then perform a
targeted Python restart. No project code, dependency files, or generated configuration may change.
