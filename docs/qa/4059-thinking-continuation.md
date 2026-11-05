# Thinking continuation qualification — #4059

Baseline: `dev` at `793ab78af`, product 1.4.0. The confirmed defect was unconditional stripping of
prior assistant reasoning. No customer outage or live-provider compatibility is inferred from it.

## Implementation and work plan

1. Select the protocol only through explicit provider configuration
   `reasoningContinuation: "required-with-tools"`; do not infer it from a model alias. Include it in
   existing capability fingerprints and preserve it through setup/rediscovery.
2. Extend existing message serialization/accounting and the Coding sidecar. Keep exact completed
   state independent of UI display; enforce the credential floor and existing byte/context/spend
   limits, including requests without tools. Evidence contains counts and closed outcomes only.
3. Reuse the native context hook, gateway run registry and retained-session manifest for lifecycle
   and model-route ownership. Exclude aborted, unfinished and foreign-model assistant records and
   orphaned tool results before provider serialization. Preserve valid completed length responses
   and native compaction checkpoints. No separate reasoning/transcript/receipt store is introduced.
4. Keep one physical attempt's state intact. Reject missing, altered or oversized state, and do not
   concatenate a failed attempt's published reasoning with a repair or retry. Preserve ordinary
   provider behavior and retry before publication. Normalize known provider interrupted finishes
   as errors in both buffered and streamed parsing.
5. Qualify two tool/result rounds, an ordinary answer and a later tool-enabled user turn through
   existing readiness/spend/cancellation owners. Thinking uses `auto`/`none` tool choices; the
   [official DeepSeek API](https://api-docs.deepseek.com/api/create-chat-completion/) refuses forced
   named and `required` choices in thinking mode. Schema-valid observed output remains necessary.
6. Run local gates, publish a normal PR against `dev` with auto-merge disabled, settle independent
   and bot reviews, and integrate only after exact-head required checks. The owner explicitly
   authorized integration. Close #4059 only after verified merge.

## Executed evidence

The actual sidecar plus Gateway serializer is exercised against strict synthetic buffered and
fragmented SSE endpoints, including two tool rounds, a later user turn, ordinary assistant turns,
UI display off, credential-floor refusal, route changes, incomplete state, output bounds and
retry/repair ownership. The owning regression selection passed 1,902 tests across 21 files;
a separate presentation control also passes and proves the native content stays intact when hidden.

The read-only independent auditor reproduced 14 distinct defects/edge failures with private
failure-first source-bound probes and rechecked all 14 after repair. Those probes cover credential
floors in readiness, responses and tool-free incoming history; missing and oversized output state;
physical-attempt mixing; thinking tool-choice compatibility; and interrupted provider end states.

The auditor also ran the pinned actual OpenCode 2.1.4 binary under macOS Seatbelt, using the current
launch profile and generated context hook. Successful controls cover two actual native file-tool
rounds, a later user turn, cancellation after reasoning starts, a completed `length` continuation,
and manual native compaction. A retained-session control ends that process, retains/audits its
249,856-byte native database with five messages, checks it out into a new private run, and starts
a new process with new capabilities and server password. The native history is unchanged before
the new turn; the next request carries three exact original assistant reasoning records, two tool
calls and both original results. No Coding History excerpt reconstructs that state. A changed
route digest refuses checkout with `model-route-changed` and creates no destination database.

Typecheck/package graph, changed-file ESLint, formatting, architecture including the tool-catalog
conformance/performance checks, architecture negative fixtures, full Activity Log implementation
and the real local Sonar analyzer pass. The broad release-coverage chain and exact-head required CI
remain separate delivery preconditions; their final results belong in the PR.

## Limits and deployment guidance

These controls use synthetic local providers. Neither a live native DeepSeek deployment nor a
specific LiteLLM version/customer route is certified. The pinned 2.0.10 API/type contract was
inspected; its actual legacy executable was not run. Unsupported or untested readiness remains
unverified. Configure the actual deployed route and rerun its bounded complete round trip before
claiming deployment compatibility. See [LiteLLM troubleshooting](../troubleshooting/litellm-production-gateway.md).
