# MCP settings and integration review

This review covers the shipped MCP tool path from central Settings through configuration and
credential custody, transports, discovery, Chat and Coding Workbench authorization, through
connection recovery and the Activity Log. The [previous production audit](mcp-production-hardening-4129.md)
provides historical evidence. Current conclusions require checks against the current implementation.

## Acceptance scenarios

| Area                       | Observable outcome                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual setup               | A person with a server address or a local program from their provider can select the matching connection, understand each field and submit using the existing Settings flow.                    |
| JSON setup                 | A single definition and a mixed set of local and remote definitions can be reviewed and added together. The import identifies invalid entries and existing names before changing configuration. |
| Configuration              | Manual setup and import both use the central registry, existing admission rules and encrypted credential custody. Imported entries cannot replace existing servers or grant tool permissions.   |
| Credentials and transports | Saved credential values remain private. Local execution and remote requests retain the existing transport, ownership and connection policies.                                                   |
| Chat and Workbench         | Both consumers use the shared catalog and connection ownership. Tool permission, cancellation and recovery remain bound to the correct consumer and configuration.                              |
| Verification               | Invalid and concurrent requests have focused regressions, and the user journey is tested through the Settings entry point. Full verification runs after the implementation is complete.         |

## Confirmed repairs

- Setup now presents the manual and JSON entry points together and explains connection details in
  English and German. The input hints are available to keyboard and screen-reader users.
- The import previews single and mixed batches and uses one registry revision for confirmation.
  Imported servers require activation and discovery after saving.
- A configuration that mixes nested and direct server entries is refused as a whole. The JSON file
  picker exposes file-read and file-size errors through its accessible description.
- Settings rejects oversized serialized registries before changing the file or staging secrets.
  Stale same-server drafts require reopening, and save preserves the order of existing entries.
- Status inspection no longer reloads configuration once per server. The dedicated invocation
  paths continue to recheck current authority. OAuth client cache entries leave with their generation.
- The protocol client treats equivalent reordered declarations as the same catalog and keeps
  declaration reads serialized when a queued invocation is cancelled.

## Verification record

The independent review exercised protocol, Settings, credential and browser component tests. The
Chromium journeys use the production static export and the paired Settings route. The manual
journey starts a real fixture program and retains its tool policy across reconnection. The German
import journey rejects an invalid entry, opens a JSONC file, checks the separate preview, confirms
by keyboard and verifies that imported connections remain disabled.

The editor bundle evidence was regenerated and checked in the pinned Linux arm64 gate image
with Node 26.13.1 and npm 11.20.0. The local Chromium check used macOS arm64.
