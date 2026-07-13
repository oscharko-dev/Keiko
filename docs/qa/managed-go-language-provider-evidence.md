# Managed Go language provider verification evidence

This is the deterministic release profile for Epic #2094 / child #2275. It downloads nothing and
does not execute `go test`, `go generate`, project binaries, vulnerability scanning, or documentation
servers.

## Supported and security profile

- gopls `v0.21.1`; Go `1.26.5`, with patched Go `1.25.12` as the supported previous major.
- LSP 3.18 over bounded stdio; default-off, revision-guarded workspace activation.
- Forced child and gopls environment: `GOENV=off`, `GOPROXY=off`, `GOSUMDB=off`,
  `GOTOOLCHAIN=local`, `GOVCS=off`.
- Controlled settings only: validated build tags, `-mod=vendor|readonly`, optional `-trimpath`,
  target GOOS/GOARCH, contained directory filters and `go.work`, and staticcheck.
- Disabled network-adjacent features: vulnerability checking, external hover links, provider-side
  subdirectory watching, and module-cache import indexing.
- Rename and code-action edits are bounded review artifacts and never write files.

## Automated evidence

| Concern             | Proof                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Negotiation         | Shared fake conformance executes every gopls candidate only after live capability negotiation.                                                                                      |
| Offline denial      | The fake spawn receives hostile ambient Go values and proves they are absent or replaced by immutable offline values.                                                               |
| Build variants      | Provider tests pin deterministic build-tag, module-mode, trim-path, target, directory-filter, and workspace-file projection.                                                        |
| Lifecycle           | Warm-pool tests prove one initialization, serialized reuse, targeted revision restart, crash throttling, cancellation, and disposal.                                                |
| Input/output limits | Runtime contracts bound tags and filters; configuration containment rejects missing and symlink-escaping paths; frame and sanitizer tests cap responses.                            |
| Performance/memory  | Content-free health tracks latency buckets and failures; frame, document, queue, result, and configuration caps bound retained data. The operator smoke records external child RSS. |

Run the hermetic profile:

```bash
npm exec vitest -- run packages/keiko-server/src/editor/lsp/providers/goProvider.test.ts packages/keiko-server/src/editor/lsp/providers/goProvider.conformance.test.ts packages/keiko-server/src/editor/lsp/providers/providerConfigurationSafety.test.ts packages/keiko-server/src/editor/lsp/hostLanguageOperation.pool.test.ts packages/keiko-server/src/editor/lsp/lspProcessManager.test.ts packages/keiko-server/src/editor/lsp/lspSecurity.test.ts
```

The optional real smoke is enabled only when `KEIKO_TEST_GOPLS_BIN_DIR` names a pre-provisioned
directory containing the pinned `go` and `gopls` binaries. It skips explicitly otherwise and never
installs or downloads. Record only versions, fixture hash, operation counts, latency histogram,
maximum child RSS, cancellation count, and pass/fail status.

Acceptance requires cold initialization and warm reuse within configured deadlines, zero pending
requests after cancellation, a negotiated subset only, byte-identical fixtures after edit previews,
no network activity, and resource use within the deployment's approved process budget.
