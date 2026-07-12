# OIDC client dependency decision

Phase B uses exact dependency `openid-client@6.8.4` on the Node.js 22+ ESM hosted service. It owns
provider discovery, authorization URL construction, token-endpoint client authentication, ID-token
signature and claim validation, and Authorization Code exchange checks. Keiko does not implement a
parallel JOSE/JWT validator.

Every login uses transaction-specific state, nonce, and an S256 PKCE challenge. Callback exchange
passes the stored verifier, expected state, expected nonce, and required-ID-token check to the
library. This follows [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html), which recommends PKCE
for confidential clients, identifies S256 as the non-disclosing challenge method, and requires exact
redirect matching, plus [OIDC Core](https://openid.net/specs/openid-connect-core-1_0-18.html), which
requires nonce and ID-token issuer/audience/signature/time validation.

V1 is a confidential server client because ADR-0134 places the OIDC client secret in the hosted
secret boundary. Only `client_secret_basic` and `client_secret_post` are configurable. Public-client
authentication (`none`), refresh tokens, UserInfo, implicit/hybrid flows, and hand-rolled token
validation are out of scope.

V1 deliberately settles role removal without persisting provider tokens or adding provider-specific
introspection/logout protocols. A maintainer session has an absolute ceiling of 15 minutes, its idle
expiry cannot exceed that ceiling, and expiry requires a fresh Authorization Code flow. An operator
permission-policy version change invalidates every existing session immediately; logout revokes only
the exact presented session. Login initiation is additionally bounded before database work by
operator-configured per-source and global fixed-window limits plus global concurrency. The source is
resolved through the trusted-proxy policy and exists only as a process-keyed ephemeral HMAC.

## Negative-validation responsibility

The production adapter has one token path: `openid-client.authorizationCodeGrant`. It does not
decode, accept, or construct an identity from an unverified token response. The adapter-level test
seam proves that discovery receives the exact configured issuer, client id, confidential-client
authentication method, and asymmetric ID-token algorithm; authorization receives the fixed redirect,
state, nonce, and S256 challenge; and the grant receives the persisted state, nonce, and PKCE verifier
with `idTokenExpected: true`.

| Negative case                                                  | Owner                                                                   | Fail-closed evidence                                                                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Callback state, nonce, or PKCE mismatch                        | `openid-client@6.8.4`, using Keiko's one-time browser-bound transaction | The adapter always supplies `expectedState`, `expectedNonce`, and `pkceCodeVerifier`; a consumed transaction cannot be replayed.           |
| Redirect substitution                                          | Keiko before token exchange, then `openid-client` protocol handling     | The persisted redirect must exactly equal the configured callback before the grant is called.                                              |
| ID-token signature or configured asymmetric algorithm mismatch | `openid-client@6.8.4`                                                   | Discovery client metadata pins exactly `RS256`, `PS256`, or `ES256`; Keiko exposes no token-decoding bypass.                               |
| Issuer mismatch                                                | `openid-client@6.8.4`, plus Keiko identity check                        | Library validation runs during the grant; Keiko then requires the verified `iss` to exactly equal the configured issuer.                   |
| Audience or authorized-party (`azp`) mismatch                  | `openid-client@6.8.4`                                                   | The grant validates registered ID-token claims against the discovered configuration and configured client id before `claims()` is exposed. |
| Expired, not-yet-valid, or otherwise invalid token time claims | `openid-client@6.8.4`                                                   | The grant performs ID-token registered-claim validation; Keiko has no clock-skipping or raw-claims path.                                   |
| Missing ID token, issuer, or subject                           | Library plus Keiko adapter                                              | `idTokenExpected: true` is mandatory, and the adapter rejects missing/non-string `iss` or `sub`.                                           |

Local synthetic JWT fixtures are intentionally not a second validator: their result would duplicate
the dependency's conformance suite while risking divergence from its actual discovery/JWKS and claim
processing. Keiko instead pins the dependency exactly, tests every adapter input at its boundary, and
keeps all application authorization after the verified grant.
