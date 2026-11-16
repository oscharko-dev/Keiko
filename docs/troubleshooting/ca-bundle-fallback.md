# Gateway CA bundle fallback

## Symptom

The Activity Log records `http.gateway.tls.ca-bundle-fallback`. A model request may still complete normally. This event alone is expected behavior and does not mean that certificate verification was disabled or that the model request failed.

## Root Cause

On an eligible direct HTTPS request, the platform trust store could not verify the peer certificate. Keiko retries the handshake with its assembled CA bundle. A configured corporate CA or the synthetic Jira lab CA can make this second, verified handshake succeed. After success, eligible requests to that origin reuse the verified CA path within the process; a later trust failure clears that preference.

## Diagnostic Steps

1. Inspect the canonical Activity Log for the request outcome and `http.gateway.tls.trust-failed`, rather than treating the fallback event as a failed request.
2. Check that the intended CA bundle is configured and readable by the running process. The Jira lab supplies its private `secrets/tls/ca.pem` through `KEIKO_CA_BUNDLE_PATH`.
3. If verification actually fails, check the certificate chain, hostname and validity interval. Keep certificates, credentials and live endpoints out of shared reports.

## Resolution

If the request succeeds, no repair is required. If `TLS_CA_FAILURE` or `http.gateway.tls.trust-failed` follows, install or configure the correct trusted CA chain and renew expired certificates, then retry normally. Preserve hostname and certificate verification. Do not disable TLS verification or change model readiness merely to suppress this event.

The fallback applies only where the existing transport permits it; it does not authorize replaying a mutation or overriding a single-attempt transport policy.
