# ADR-0037: The Figma Snapshot as the only communication boundary with Figma

## Status

Accepted (retroactive record, 2026-06-12). Documents the architecture shipped by Epic #750
(children #751–#760, #810–#812, #757) and hardened by PRs #849, #902 and the
production-readiness pass on branch `feature/figma-snapshot-extraction-production-ready`.

## Context

Keiko must turn large, complex Figma boards into a compact, high-fidelity representation that
downstream stages (Quality Intelligence test generation, accessibility baseline, design-to-code)
can consume deterministically. Boards are customer data behind a single read-only credential;
enterprise deployments sit behind forward proxies with TLS interception. Real boards routinely
exceed 17 000 nodes per screen with meaningful text at depth 7–18.

## Decision

1. **Snapshot = communication boundary.** Figma is contacted ONLY during the bounded
   snapshot-build (scoped node fetch via `GET /v1/files/:key/nodes` + screen render via
   `GET /v1/images`). Every downstream stage reads the stored snapshot record. There is no
   polling, no webhook, no Figma MCP, no OAuth — re-snapshot is an explicit on-demand full
   re-fetch. Concurrent builds for the same local evidence root, board scope, and requested version
   coalesce server-side into one build. Explicit version pins apply to both node and render requests.
   For latest imports, the connector checks available Figma revision metadata across scoped reads and
   rechecks it after obtaining render URLs. A detected change aborts the build before publication.
2. **PAT-only credential posture.** The read-only token comes from `FIGMA_ACCESS_TOKEN`
   (allowlisted in the CLI `.env` loader) or the encrypted vault
   (`packages/keiko-server/src/qualityIntelligence/figma/figmaTokenStore.ts`). The token string
   is materialised exclusively at the transport boundary (`X-Figma-Token` header in the two port
   adapters) and never appears in logs, errors, snapshots, or the browser.
3. **Per-screen BFS scoped pagination.** Discovery follows bounded nested sections. Screen trees
   expand breadth-first with independent budgets (`KEIKO_FIGMA_*`, defaults depth 8, 8,000 nodes and
   six fetches per screen, 16 deep screens, and concurrency two). Discovery and screen budget limits
   surface as coverage notices. Render downloads have per-image and aggregate byte limits. Invalid
   or skipped renders retain their structural IR when available.
4. **Immutable, integrity-hashed evidence record.** The snapshot stores redacted IR, rendered PNGs,
   and provenance. The existing drift hash excludes `fetchedAt`, prototype links and optional IR
   metadata for compatibility. New records also hash the complete stored record. The store verifies
   hashes on reads and checks each PNG against its recorded size and digest. Write ordering makes
   the JSON record the commit marker after the image set is durable. Existing records remain readable.
   Retention and orphan cleanup are restricted to owned evidence paths.
5. **Deterministic, model-free extraction pipeline.** `packages/keiko-quality-intelligence/src/domain/figma/`
   cleans the scoped tree into a lean per-screen IR (+ design tokens + inter-screen links),
   derives the navigation graph (#811), the accessibility baseline (#812), the structural test
   baseline (#754) and emits code through the pluggable `CodeTargetAdapter` seam (#755,
   html-css first slice). Everything is pure, locale-independent (code-unit sorting),
   depth-bounded (`MAX_TREE_DEPTH = 512`), breadth-bounded (`MAX_NAV_FLOWS = 500` + notice) and
   byte-identical on re-run. Model assistance is additive only and capability-routed (#810);
   without any model the structural layer still produces snapshot, tokens, test baseline and a
   code skeleton.
6. **Drift via board-stable identity (#735).** A QI run pins the snapshot runId it was generated
   from. Because the record is write-once, drift re-check resolves the LATEST snapshot of the
   same board scope (`listByScope(fileKey, nodeId)`) and compares the derived evidence fingerprints.
   Equal legacy drift hashes still allow changes in prototype links and accessibility metadata.
   Re-check reports unavailable evidence when the latest indexed record fails validation. Screen
   renames preserve the original atom identity while updating its fingerprint. Regenerate-stale
   re-ingests the latest snapshot. The generate path keeps exact pinning.

## Consequences

- Downstream features never block on Figma availability and never re-trigger egress implicitly.
- A snapshot is reproducible evidence: same board version → same hash; audits reference it.
- The two transport ports (`figmaHttpPort.ts`, `figmaRenderPort.ts`) are the single swappable
  seam for enterprise egress (see [ADR-0038](ADR-0038-outbound-egress.md)); they enforce
  per-request timeouts, response-size caps and `redirect: "manual"` so the PAT can never follow a
  cross-origin redirect.
- Error taxonomy is content-free and coded (`FigmaConnectorErrorCode`); proxy-blaming codes are
  reachable only when a proxy was genuinely in play.
- Known limitation: the positive multimodal vision path stays unwired until the model-gateway
  protocol supports image content (`ChatMessage.content` is a string); capability routing and
  IR-only degradation are in place.
