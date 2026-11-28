# MCP settings and integration review

This review covers the shipped MCP tool path from central Settings through configuration and
credential custody, transports, discovery, Chat and Coding Workbench authorization, through
connection recovery and the Activity Log. The [previous production audit](mcp-production-hardening-4129.md)
provides historical evidence. Current conclusions require checks against the current implementation.

## Acceptance scenarios

| Area | Observable outcome |
| --- | --- |
| Manual setup | A person with a server address or a local program from their provider can select the matching connection, understand each field and submit using the existing Settings flow. |
| JSON setup | A single definition and a mixed set of local and remote definitions can be reviewed and added together. The import identifies invalid entries and existing names before changing configuration. |
| Configuration | Manual setup and import both use the central registry, existing admission rules and encrypted credential custody. Imported entries cannot replace existing servers or grant tool permissions. |
| Credentials and transports | Saved credential values remain private. Local execution and remote requests retain the existing transport, ownership and connection policies. |
| Chat and Workbench | Both consumers use the shared catalog and connection ownership. Tool permission, cancellation and recovery remain bound to the correct consumer and configuration. |
| Verification | Invalid and concurrent requests have focused regressions, and the user journey is tested through the Settings entry point. Full verification runs after the implementation is complete. |
