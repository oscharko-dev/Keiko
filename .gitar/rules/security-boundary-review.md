---
title: "Security boundary review"
description: "Require adversarial review for authentication, egress, secrets, redaction, persistence, and external effects"
when: "Pull requests that change security, authentication, authorization, CSRF, OIDC, sessions, secrets, redaction, network egress, connectors, persistence, migrations, retention, or external APIs"
actions: "Post a comment with the relevant trust-boundary trace and negative-test checklist; identify fail-open behavior, secret exposure, stale authorization, or unbounded external effects as blocking review findings"
---

# Security-boundary checks

- Trace validation, authorization, persistence, evidence, retry, and failure behavior end to end.
- Require bounded origins, redirects, methods, headers, bytes, timeouts, and credential scopes.
- Require deterministic malformed, hostile, expired, replayed, unauthorized, and dependency-failure
  tests.
- Verify retention, key rotation, idempotency, and reconciliation remain fail closed.
