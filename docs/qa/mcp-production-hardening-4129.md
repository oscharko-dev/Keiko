# MCP production hardening — PR #4129

This is an incremental audit receipt. Qualification remains in progress; this document does not
certify production readiness. Only MCP tools are in scope. The shared registry, encrypted vault,
managed protocol host and Activity Log remain the existing owners.

## Confirmed findings and repairs

| Finding                                                                                          | Impact                                                     | Reproduction and repair                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry names stopped at 64 characters while MCP supports 128                                   | Valid tools could not be admitted consistently             | A 128-character contract regression failed first. Registry and native identity limits now agree, without relaxing collision checks.                                                               |
| Central connections refused OAuth while Workbench used a separate path                           | An authenticated server could not be shared with Chat      | The managed connection now obtains server-owned credentials; Workbench receives its existing scoped relay. Central settings own sign-in, status, cancellation and revocation.                     |
| OAuth entries could not be edited centrally                                                      | Operators could not maintain their own server definition   | Editing preserves issuer, client ID, scope and central tool policy; OAuth configuration saves independently of sign-in.                                                                           |
| Legacy authorization URLs accepted ambiguous duplicate parameters and unsafe callback components | Confused callback and authorization matching               | Eight negative regressions failed before strict uniqueness and loopback callback validation were added.                                                                                           |
| Legacy OAuth credential identity omitted scope                                                   | Changed permissions could reuse an old credential record   | A scope-change regression failed first. The versioned credential key now binds scope; previous legacy records require a fresh sign-in.                                                            |
| Silent tool metadata changes were accepted between discovery and dispatch                        | An approved tool could change without a notification       | A failure-first regression changed the tool description. Every invocation now checks uncached, bounded declarations before dispatch and rejects drift. Concurrent metadata checks are serialized. |
| SDK defaults requested advertised scopes and appended `offline_access`                           | Server metadata could widen requested permissions          | Two regressions failed first. SDK discovery presented to the authorization flow is constrained to operator-selected scopes; extra returned scopes are refused.                                    |
| Tokens survived a failed authority-epoch commit in the new shared OAuth flow                     | A failed sign-in could leave usable credentials            | A failure-first test rejects the registry commit. Authorization tokens are now staged in memory and only persisted after that commit succeeds.                                                    |
| Cancelled shared authorization retained a generation listener                                    | Repeated attempts accumulated listeners and retained state | A failure-first listener-count regression now verifies cleanup. Shutdown also waits for owned callback listeners to close.                                                                        |

## Implemented boundaries

- OAuth uses the official MCP SDK inside `keiko-mcp`, with issuer/resource binding, PKCE S256,
  one-use callback state and a five-minute attempt lifetime. The callback listener binds IPv4
  loopback and validates its exact Host and path. The public attempt ID is separate from OAuth state.
- Metadata, registration, token and refresh requests use the existing hardened outbound gateway:
  HTTPS, bounded requests/responses, no redirects, DNS/proxy target pinning, no metadata/link-local
  destinations and explicit public/private target classification.
- Existing encrypted credential custody stores central OAuth state separately from opaque legacy
  runtime records. Resource, issuer, client ID and scope bind credential identity. Removing or
  changing a definition cleans incompatible central records.
- Credential rotation advances the server's persisted credential generation, invalidating old
  connection and approval authority. Static secrets and tokens materialized during refresh join
  the credential floor before metadata or results leave the connection boundary.
- Tool calls are never automatically replayed to recover a lost response or authentication failure.
  Unknown tools remain writing tools; server annotations do not grant authority.
- Settings include advanced header selection, encrypted environment-variable inputs/removal and
  central tool risk policy. Workbench links to that same settings surface. New labels are bilingual.
- Authorization lifecycle evidence uses the registered `mcp.authorization.state` operation and
  contains correlation IDs, opaque attempt IDs, state and completeness counts only.

## Qualification status

The first checkpoint (`c0b50fb58`) covers name compatibility. The shared OAuth/UI checkpoint
passed 370 focused MCP, registry and native-runtime tests (25 suites), 39 related UI tests
(five suites), root and UI typechecks, root and UI lint, format checking, and the full
Activity Log gate. The latter ran its complete registry/scenario inventory, error observability,
architecture, 78 negative architecture fixtures and release-impact checks. The ADR index and
updater UI evidence freshness also passed.

Local Sonar passed with zero unresolved findings on the changed files after two reported code
findings were repaired. The documented 12 GiB analyzer heap was needed: the default 4.5 GiB
attempt exhausted memory. An earlier report had failed because a source file changed during
analysis (72 actual versus 82 expected lines); neither failed attempt is counted as passing.

The app-browser setup connected the existing local model gateway through the real UI using
isolated configuration and credential state. Gemma was admitted for conversation; its tool-calling
probe returned unavailable, so real-model MCP and OpenCode execution are not yet qualified.
The browser created a synthetic stdio server through central settings and observed the real
`Connected · 2 tools` state. No synthetic write was dispatched during this discovery check.

Still outstanding: final complete core and coverage gates, generated evidence verification,
package-surface qualification, static UI build/editor release evidence, dedicated browser-suite wiring and the full interactive acceptance
matrix with a real model and OpenCode. The in-app browser is available; tests use isolated state and
synthetic writes. Production connections remain read-only. No integration or auto-merge is authorized.
