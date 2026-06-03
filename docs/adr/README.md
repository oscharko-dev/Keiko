# Decision Summary

This page keeps only the product decisions needed by reviewers. It is not an implementation history.

## Current Decisions

| Area | Decision |
| --- | --- |
| Product surface | Keiko is delivered as an npm package with a local UI and CLI. |
| Runtime model access | Models are configured at runtime through an OpenAI-compatible gateway. |
| Local-first operation | The UI binds to loopback and stores runtime state locally. |
| User control | Keiko does not commit, push, open pull requests, merge, or apply patches without explicit local action. |
| Workspace boundary | Repository reads and writes are bounded by the selected project path. |
| Command boundary | Verification uses allowlisted commands without shell execution. |
| Patch safety | Generated patches are dry-run by default and must be reviewed before application. |
| Evidence | Supported surfaces write redacted local evidence for human review. |
| Credentials | API tokens are local secrets and are never logged, serialized, or returned to the browser. |
| Evaluation | Pilot decisions require offline thresholds plus human-reviewed live model runs. |
| Package architecture | [ADR-0019](ADR-0019-modular-package-architecture.md) defines the modular workspace package architecture while preserving one customer-facing npm product package. |

For operational details, use the README, the local UI guide, the security boundaries, and the pilot guide.
