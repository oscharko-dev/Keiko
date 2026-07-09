# Coding Workbench Codex Subscription Profiles

Issue #1995 adds a dedicated ChatGPT/Codex subscription profile path for Coding Workbench. This
path is intentionally separate from OpenAI Platform API-key access.

## Model Gateway API Keys

OpenAI API keys remain Model Gateway provider credentials. They are configured through the existing
Gateway setup flow, sealed through the Keiko credential-vault policy, and routed through the
Coding Sidecar Gateway when a coding profile uses `keiko-model-gateway` or
`openai-api-key-through-gateway`.

OpenCode and other sidecar runtimes must continue to receive only Model Gateway-compatible provider
configuration. They must not receive ChatGPT access tokens, refresh tokens, Codex auth cache files,
or ChatGPT account identifiers.

## ChatGPT/Codex Subscription Access

ChatGPT/Codex subscription access is represented by the separate
`chatgpt-codex-subscription-profile` model source and the `codex-cli-adapter` runtime source. The
profile exposes only content-free status and policy metadata:

- auth status such as `connected`, `missing`, `expired`, `revoked`,
  `disabled-by-deployment`, `unsupported-headless`, or `failed-login`;
- auth method labels for browser login, device-code login, or access-token setup;
- state scope, state-root label, and whether deployment policy disables the profile;
- supported runtime binary provenance labels.

The browser-visible contract never carries raw tokens, refresh tokens, auth-cache contents, private
account labels, or filesystem paths. Access-token setup is represented as a local instruction with
`credentialTransport: "stdin"`; Keiko does not accept the token in the API request body.

## State And Binary Provenance

The default Codex auth state label is `keiko-codex-runtime-state`, not global `~/.codex`. If a
deployment uses an OS credential store, the profile reports `os-credential-store`. The contracts also
pin `usesGlobalCodexHome: false` so global Codex auth cache use cannot be silently introduced by a
caller.

Codex runtime binary provenance is restricted to two labels:

- `managed-sidecar-runtime` for a bundled, product-owned runtime staged through the portable
  sidecar payload mechanism;
- `policy-allowed-local-install` for individual/open-source deployments where policy explicitly
  permits a local user-provided Codex install.

This issue defines the profile, setup/status flow, state policy, binary provenance vocabulary, and
adapter selection seam. Runtime process lifecycle, health, kill, and restart behavior remains owned
by the Coding runtime manager child issue.

## Regulated Deployments

Regulated deployments can disable ChatGPT/Codex subscription login entirely with deployment policy.
The server projection reports `disabled-by-deployment`, and setup calls return
`CODEX_SUBSCRIPTION_UNAVAILABLE`. In that posture, users must use managed Gateway profiles such as
LiteLLM, Azure, or other approved providers instead of local ChatGPT/Codex subscription auth.
