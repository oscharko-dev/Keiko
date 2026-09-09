# Governed tool catalog

This private package owns concrete tool declarations and pure compilation. It depends only on
`keiko-contracts` and `keiko-security`. It performs no I/O, readiness checks, authority evaluation,
logging, invocation settlement, or handler execution.

`createInitialToolCatalog()` declares the six implemented legacy tools in `legacy-native@1`.
`compileToolProjection(catalog, profile)` validates and detaches the complete snapshot, then binds
its exact descriptor, profile, alias, schema, dialect and pinned runtime identities.
`gatewayToolDefinitions(catalog, profile)` materializes the verified projection as gateway wire
metadata. The conformance gate compares this wire output with the existing legacy schema owner
until that consumer migrates. No H1 search, research, skill, or child-agent handler is advertised.

The five dialects implement a deliberately closed JSON Schema core. Unsupported keywords are
rejected. The OpenCode 1.17.17 input projection additionally requires all declared arguments and
can omit `additionalProperties` only when its explicit source value is `true`, which preserves
the keyword's default semantics. Closed objects or schema-valued additional properties cannot
survive that runtime's removal of the keyword and are rejected. Binding owners remain responsible
for validating actual input and retaining hard denials; the catalog does not grant permission.

`createToolCatalog` checks descriptor version progression and any explicitly declared directional
identity compatibility against the actual previous and current descriptors. Compatibility binds
an exact profile and adapter, has an owner and removal issue, cannot widen bounds, and lasts at
most seven days relative to a supplied reference time. There is no reverse, transitive, latest,
or automatic conversion.

`verifyToolCatalogSnapshot` and projection compilation verify content identity only. They do not
reconstruct an absent historical descriptor or establish current compatibility eligibility.
**The #3413 dispatcher and runtime binding must call `assertCompatibilityTime` on every
selected compatibility entry at invocation, using their trusted injected clock, and require the
entry's exact from/to identity, profile and adapter to match the invocation.** Where both source
and destination descriptors are available, `assertIdentityCompatibility` also checks their
semantics and bounds. Reuse these exported pure checks; do not duplicate the mapping or clock.
An expired binding must follow the existing recovery-required contract, without replay or rebinding.

`validateToolResultEnvelope` checks closed status/reason vocabulary, exact optional binding
identity, bounded completed data against the descriptor's result schema, page/cursor syntax,
and complete serialized envelope size. `metrics.outputBytes` is the UTF-8 byte size of serialized
`data`; the whole envelope is independently capped. Cursor storage, expiry, replay protection,
output redaction, cancellation settlement and activity logging belong to the execution owner.

`npm run generate:tool-catalog` generates the body-free semantic manifest and separate migration
manifest. The latter reuses the frozen 43-source architecture inventory and records the one
exact, non-dispatch gateway readiness probe separately; it is excluded from semantic digests.
`check:tool-catalog-conformance` checks those bytes, legacy parity, and initial AST registry forms.
`check:tool-catalog-performance` measures fresh compilation and exact lookup with the #2952
sample/percentile conventions. Its observations are development evidence; #3415 owns final
threshold calibration and migration closeout.
