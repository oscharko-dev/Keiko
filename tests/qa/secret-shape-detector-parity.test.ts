// Cross-package secret-shape detector parity (KEIKO-0628).
//
// Three independently-maintained detectors each decide whether a string is "secret-shaped":
//   - keiko-contracts' looksLikeSecretShape() -- the narrow, high-precision, package-LEAF detector
//     (ADR-0019: contracts imports nothing). Consumed directly by workspace-persistence.ts.
//   - keiko-security's containsCredentialShape()/redact() -- the broader, server-side detector +
//     redactor that scrubs provider-derived text before it reaches a log line or serialised
//     artefact.
//   - workspace-persistence.ts's isSecretShapedString() -- the client-side localStorage
//     sanitizer, which layers looksLikeSecretShape() with its OWN independently-maintained marker
//     lists (CREDENTIAL_ASSIGNMENT_MARKERS, containsBearerSecret, containsUrlCredentials,
//     containsCredentialPath) to close PART of the gap to keiko-security's broader coverage.
//
// keiko-contracts is the dependency leaf (ADR-0019 direction 1) and must never import from
// keiko-security (arch:check rejects it), so the three cannot be unified into one implementation.
// This test is the mechanical guard against them drifting apart silently instead.
//
// The three detectors do NOT agree on every string. Some divergences are DOCUMENTED and
// INTENTIONAL -- looksLikeSecretShape's own file comment names exactly which shapes it defers to
// the capture layer -- and some are REAL, CURRENTLY-EXISTING GAPS this test exists to surface
// rather than paper over (e.g. neither looksLikeSecretShape nor workspace-persistence recognise a
// Google or Stripe key shape that keiko-security already redacts). Fixtures are grouped into
// CLASSES; every fixture in a class is asserted against that class's single, reviewed four-way
// verdict tuple {contracts, secDetect, secRedact, workspace}. Adding a fixture to an EXISTING class
// costs nothing. A string whose actual behaviour does not match any class's tuple fails loudly,
// forcing whoever added it to explicitly classify (and get reviewed) the new divergence instead of
// the test silently passing -- this is what keeps the corpus class-symmetric: a new secret shape
// wired into only one of the three detectors lands in a class by itself and its tuple exposes
// exactly which detector(s) it is missing from.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { looksLikeSecretShape } from "@oscharko-dev/keiko-contracts/runtime/memory";
import { containsCredentialShape, redact } from "@oscharko-dev/keiko-security";
// Import from the leaf module (not workspace-persistence.ts) so this root-suite test does not
// pull the desktop hook's WIN_TYPES/WIN_META imports into the root's stricter tsconfig.
import { isSecretShapedString } from "../../packages/keiko-ui/src/app/components/desktop/hooks/isSecretShapedString.js";

interface DetectorVerdicts {
  // keiko-contracts: looksLikeSecretShape(value)
  readonly contracts: boolean;
  // keiko-security: containsCredentialShape(value) -- the boolean DETECTOR
  readonly secDetect: boolean;
  // keiko-security: redact(value) !== value -- the REDACTOR actually changed something. Tracked
  // separately from secDetect: redaction.ts's own header comment documents that the redactor is
  // allowed to over-match prose ("fix: add basic retry" -> partially redacted) in a way the
  // DETECTOR must not, so the two are not interchangeable signals.
  readonly secRedact: boolean;
  // keiko-ui workspace-persistence.ts: isSecretShapedString(value)
  readonly workspace: boolean;
}

interface SecretShapeFixture {
  readonly id: string;
  readonly value: string;
}

interface SecretShapeClass {
  readonly className: string;
  readonly rationale: string;
  readonly verdicts: DetectorVerdicts;
  readonly fixtures: readonly SecretShapeFixture[];
}

// Synthetic JWT fixture for the cross-detector parity tests below — not a real token.
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"; // gitleaks:allow

// Credential prefixes GitHub's PARTNER secret scanner alerts on from the prefix alone. A fixture
// for one of these must be assembled by concatenation so the contiguous form never exists in this
// file's source; the pin at the bottom of this file enforces that. See alert #20 (#2296).
const PARTNER_SCANNED_PREFIXES = ["sk-", "xoxb-", "ghp_", "AKIA"] as const;

const SECRET_SHAPE_CLASSES: readonly SecretShapeClass[] = [
  {
    className: "issuer-prefixed-token",
    rationale:
      "Self-identifying issuer-prefixed token shapes (COVERED per looksLikeSecretShape's own " +
      "comment): all three detectors, and the redactor, agree.",
    verdicts: { contracts: true, secDetect: true, secRedact: true, workspace: true },
    fixtures: [
      // Every fixture in this block is a SYNTHETIC secret shape — deliberately structural, never
      // active. gitleaks:allow on each line suppresses gitleaks' own detector so the CI secret
      // scanner does not misclassify a test fixture as a leak. The whole point of the parity
      // test IS to run these shapes through keiko-contracts / keiko-security / keiko-ui detectors
      // and pin their agreement.
      // PARTNER_SCANNED_PREFIXES values are assembled by concatenation so the contiguous form
      // never appears in this file's source. `gitleaks:allow` suppresses gitleaks only, and
      // GitHub's partner secret scanner is a separate detector that alerts on the prefix alone
      // (#2296, alert #20). The pin at the bottom of this file enforces the split.
      // The OpenAI body is split TWICE on purpose: as one 40-character literal it is itself
      // the shape of an AWS Secret Access Key, and sitting next to the AKIA line it completes
      // a credential PAIR that push protection blocks. Repairing one detector's trigger can
      // create another's, so no fixture here may leave a long opaque literal standing alone.
      { id: "openai-key", value: "sk-" + "abcdefghijklmnopqrstuvwxyz" + "0123456789ABCD" }, // gitleaks:allow
      { id: "aws-key", value: "AKIA" + "ABCDEFGHIJKLMNOP" }, // gitleaks:allow
      { id: "github-classic-pat", value: "ghp_" + "A".repeat(40) }, // gitleaks:allow
      { id: "slack-token", value: "xoxb-" + "1234567890-abcdefghijklmnop" }, // gitleaks:allow
      { id: "pem-header", value: "-----BEGIN RSA PRIVATE KEY-----" }, // gitleaks:allow
      {
        id: "pem-block",
        // gitleaks:allow — synthetic 6-byte body; not a real key.
        value: "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----",
      },
    ],
  },
  {
    className: "bearer-jwt-encoded",
    rationale:
      "contracts' own comment: EXCLUDED opaque 'Bearer <token>' '(catches only JWT-encoded " +
      "bearers)'. A Bearer-prefixed JWT is therefore the one Bearer shape looksLikeSecretShape " +
      "DOES catch (via its bare JWT pattern matching inside the string), so it lands with the " +
      "issuer-prefixed class's tuple rather than the opaque-bearer gap below.",
    verdicts: { contracts: true, secDetect: true, secRedact: true, workspace: true },
    fixtures: [{ id: "bearer-jwt", value: `Bearer ${JWT}` }],
  },
  {
    className: "contracts-only-bare-payload",
    rationale:
      "A bare JWT (no context word) and a Luhn-valid PAN are matched by looksLikeSecretShape's " +
      "own content-shape patterns, but keiko-security's containsCredentialShape()/redact() have " +
      "no unconditional bare-JWT or bare-PAN pattern -- both require a triggering context word " +
      "(bearer/basic/api-key/etc.) that these fixtures lack. workspace inherits contracts' verdict " +
      "because isSecretShapedString() calls looksLikeSecretShape() directly.",
    verdicts: { contracts: true, secDetect: false, secRedact: false, workspace: true },
    fixtures: [
      { id: "bare-jwt", value: JWT },
      { id: "pan-visa", value: "4111 1111 1111 1111" },
    ],
  },
  {
    className: "contracts-documented-exclusion",
    rationale:
      "looksLikeSecretShape's own comment: 'EXCLUDED: opaque \"Bearer <token>\" ..., " +
      "URL-embedded credentials (https://user:pass@host), generic password=, secret=, key= " +
      "form-encoded values. These classes are intentionally deferred to the capture layer (#207)'. " +
      "keiko-security detects and redacts all of these; workspace-persistence.ts closes the gap " +
      "with its OWN local reimplementation (containsBearerSecret, containsUrlCredentials, " +
      "CREDENTIAL_ASSIGNMENT_MARKERS) for exactly this shape set -- this is the mustFailBeforeFix " +
      "scenario KEIKO-0628 names: looksLikeSecretShape alone does NOT flag a bare bearer token.",
    verdicts: { contracts: false, secDetect: true, secRedact: true, workspace: true },
    fixtures: [
      { id: "bearer-opaque", value: "Bearer abcdEFGH12345678ijklMNOP" }, // gitleaks:allow
      { id: "generic-api-key-assignment", value: "api_key=abcdEFGH12345678ijklMNOP" }, // gitleaks:allow
      { id: "generic-password-assignment", value: "password=abcdEFGH12345678ijklMNOP" }, // gitleaks:allow
      { id: "token-assignment", value: "token=abcdEFGH12345678ijklMNOP" }, // gitleaks:allow
      // gitleaks:allow — synthetic userinfo fixture; the URL is example.com and the "password" is a placeholder.
      { id: "url-userinfo", value: "https://user:abcdEFGH12345678ijklMNOP@example.com/path" },
    ],
  },
  {
    className: "workspace-marker-list-gap",
    rationale:
      "REAL, CURRENTLY-EXISTING GAP (not a documented exclusion): keiko-security detects and " +
      "redacts a 'Basic <creds>' auth header and a generic 'x-api-key: <value>' header, but " +
      "workspace-persistence.ts's local reimplementation has no Basic-scheme marker (only " +
      "containsBearerSecret, which matches the literal word 'bearer') and no 'x-api-key:' entry in " +
      "CREDENTIAL_ASSIGNMENT_MARKERS (only the '=' assignment forms). If this class is ever closed, " +
      "tighten (never loosen) this tuple to workspace: true and move the fixtures to the exclusion " +
      "class above -- do not delete the pin.",
    verdicts: { contracts: false, secDetect: true, secRedact: true, workspace: false },
    fixtures: [
      { id: "basic-auth-header", value: "Basic dXNlcm5hbWU6cGFzc3dvcmQ=" }, // gitleaks:allow
      { id: "generic-api-key-header", value: "x-api-key: abcdEFGH12345678ijklMNOP" }, // gitleaks:allow
    ],
  },
  {
    className: "provider-specific-pattern-gap",
    rationale:
      "REAL, CURRENTLY-EXISTING GAP: keiko-security has explicit GOOGLE_API_KEY_PATTERN / " +
      "STRIPE_KEY_PATTERN entries in its detector and redactor; looksLikeSecretShape has neither " +
      "(its 'sk-' pattern requires a hyphen, not Stripe's 'sk_live_' underscore), so " +
      "workspace-persistence.ts -- which composes looksLikeSecretShape plus its own markers, none " +
      "of which cover these prefixes either -- also misses them. This is the exact class of drift " +
      "KEIKO-0628's impact statement warns about: a shape known server-side and invisible " +
      "client-side.",
    verdicts: { contracts: false, secDetect: true, secRedact: true, workspace: false },
    fixtures: [
      { id: "google-api-key", value: "AIzaSyD" + "a".repeat(28) },
      { id: "stripe-key", value: "sk_live_" + "a".repeat(24) },
    ],
  },
  {
    className: "redact-only-no-detector",
    rationale:
      "REAL, CURRENTLY-EXISTING GAP: keiko-security's redact() strips a German IBAN and a German " +
      "phone number via dedicated replace passes, but neither pattern is included in " +
      "CREDENTIAL_SHAPE_PATTERNS, so containsCredentialShape() -- the boolean detector this parity " +
      "test otherwise treats as keiko-security's verdict -- returns false for both. Any consumer " +
      "that gates on the DETECTOR rather than calling redact() and diffing (exactly what " +
      "looksLikeSecretShape and isSecretShapedString both are) inherits this same blind spot.",
    verdicts: { contracts: false, secDetect: false, secRedact: true, workspace: false },
    fixtures: [
      { id: "german-iban", value: "DE89 3704 0044 0532 0130 00" },
      { id: "german-phone", value: "+49 30 1234567" },
    ],
  },
  {
    className: "workspace-only-path-heuristic",
    rationale:
      "workspace-persistence.ts's containsCredentialPath() recognises a local .env/.npmrc/" +
      ".aws/credentials/.ssh/id_* filesystem path as credential-shaped even though none of the " +
      "path TEXT itself matches any generic secret-shape pattern. This is an intentional, " +
      "client-only heuristic (a persisted path is meaningful on the user's filesystem in a way it " +
      "is not to the server's generic string redactor), not a gap in the dangerous direction.",
    verdicts: { contracts: false, secDetect: false, secRedact: false, workspace: true },
    fixtures: [
      { id: "dotnpmrc-path", value: "/Users/dev/.npmrc" },
      { id: "dotenv-path", value: "/Users/dev/project/.env" },
      { id: "aws-credentials-path", value: "/Users/dev/.aws/credentials" },
      { id: "ssh-key-path", value: "/Users/dev/.ssh/id_rsa" },
    ],
  },
  {
    className: "redactor-documented-overmatch",
    rationale:
      "redaction.ts's own header comment gives 'fix: add basic retry' as the canonical example of " +
      "prose the DETECTOR must not reject while explaining the REDACTOR is allowed to over-match " +
      "it ('over-matching in the redactor costs a masked token in a log line'). secDetect, " +
      "contracts and workspace correctly agree these are safe; secRedact is true purely from the " +
      "redactor's documented, accepted false positive on the bare word 'basic'/'bearer' followed by " +
      "another word -- this is why secRedact is tracked as its own axis instead of being folded " +
      "into a single 'security' boolean.",
    verdicts: { contracts: false, secDetect: false, secRedact: true, workspace: false },
    fixtures: [
      { id: "commit-message-basic-retry", value: "fix: add basic retry logic to the client" },
      { id: "prose-basic-example", value: "this is a basic example of a retry loop" },
      { id: "prose-bearer-of-news", value: "the bearer of good news arrived" },
    ],
  },
  {
    className: "safe-non-secret",
    rationale: "Ordinary prose, identifiers and paths with no secret shape: all four agree false.",
    verdicts: { contracts: false, secDetect: false, secRedact: false, workspace: false },
    fixtures: [
      { id: "prose-api-key-mention", value: "the api_key rotation runbook needs an update" },
      { id: "dash-identifier", value: "task-1234567890abcdef" },
      { id: "uuid", value: "550e8400-e29b-41d4-a716-446655440000" },
      { id: "short-greeting", value: "hello world" },
      { id: "repo-path", value: "/Users/dev/projects/keiko/src/index.ts" },
      { id: "version-string", value: "keiko v0.3.17 released on 2026-08-20" },
      { id: "commit-sha", value: "8b224e02d0aa6538ea016dd7ece60f53db356189" },
      { id: "camelcase-identifier", value: "sanitizeGenericConfigValue" },
      { id: "filename", value: "workspace-persistence.ts" },
      { id: "numbers-sentence", value: "we shipped 128 fixes across 4 sprints this quarter" },
    ],
  },
];

function verdictsFor(value: string): DetectorVerdicts {
  return {
    contracts: looksLikeSecretShape(value),
    secDetect: containsCredentialShape(value),
    secRedact: redact(value) !== value,
    workspace: isSecretShapedString(value),
  };
}

function allFixtures(): readonly {
  readonly klass: SecretShapeClass;
  readonly fixture: SecretShapeFixture;
}[] {
  return SECRET_SHAPE_CLASSES.flatMap((klass) =>
    klass.fixtures.map((fixture) => ({ klass, fixture })),
  );
}

describe("secret-shape detector parity (keiko-contracts / keiko-security / workspace-persistence, KEIKO-0628)", () => {
  it("has at least one fixture in every declared class (corpus sanity)", () => {
    for (const klass of SECRET_SHAPE_CLASSES) {
      expect(klass.fixtures.length, `class "${klass.className}" must not be empty`).toBeGreaterThan(
        0,
      );
    }
  });

  it.each(allFixtures().map(({ klass, fixture }) => ({ klass, fixture })))(
    "$klass.className / $fixture.id matches its class's reviewed verdict tuple",
    ({ klass, fixture }) => {
      expect(verdictsFor(fixture.value), klass.rationale).toEqual(klass.verdicts);
    },
  );

  it("pins the exact mustFailBeforeFix scenario: a bare Bearer token is NOT caught by looksLikeSecretShape alone", () => {
    // KEIKO-0628's own acceptance proof: "a bare 'Bearer <token>' string ... fails today
    // (looksLikeSecretShape has no Bearer/generic-key-value coverage per its own 'intentionally
    // deferred' comment), proving the parity test actually detects the documented gap". Pinned
    // directly (independent of the class table above) so this exact regression can never silently
    // disappear if the class table is later refactored.
    const bearer = "Bearer abcdEFGH12345678ijklMNOP";
    expect(looksLikeSecretShape(bearer)).toBe(false);
    expect(containsCredentialShape(bearer)).toBe(true);
    expect(isSecretShapedString(bearer)).toBe(true);
  });

  it("workspace's detector is a superset of contracts' for every fixture (isSecretShapedString calls looksLikeSecretShape)", () => {
    // Structural invariant, not per-fixture opinion: isSecretShapedString() ORs in
    // looksLikeSecretShape(trimmed) as its first condition, so this must hold for ANY string, not
    // just the corpus above. A failure here means workspace-persistence.ts stopped consulting
    // keiko-contracts' detector.
    for (const { fixture } of allFixtures()) {
      if (looksLikeSecretShape(fixture.value)) {
        expect(isSecretShapedString(fixture.value), fixture.id).toBe(true);
      }
    }
  });

  it("never stores a partner-scannable credential prefix as one contiguous source literal", () => {
    // Incident pin (#2296, repository secret-scanning alert #20 `openai_api_key`). GitHub's
    // partner secret scanner is a DIFFERENT detector from gitleaks: a `gitleaks:allow` comment
    // suppresses gitleaks only, so a fixture written as one contiguous literal still raises a
    // repository secret-scanning alert. The neighbouring `slack-token` and `github-classic-pat`
    // fixtures were already split across a concatenation for exactly this reason; the `openai-key`
    // fixture was not, and alert #20 fired on it. This pin closes the CLASS rather than the single
    // instance -- it reads this file's own source, so any future fixture that reintroduces a
    // contiguous partner-scannable literal fails here instead of in the repository's alert list.
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    for (const prefix of PARTNER_SCANNED_PREFIXES) {
      const contiguous = new RegExp(`"${prefix}[A-Za-z0-9_-]{16,}"`, "u");
      expect(
        contiguous.test(source),
        `a "${prefix}..." fixture is a contiguous literal; split it across a concatenation`,
      ).toBe(false);
    }
  });

  it("keiko-security's redactor actually changes every value its own detector flags", () => {
    // Within-package consistency, using only the corpus's TRUE-positive fixtures for secDetect --
    // the redactor is known (and documented) to over-match some SAFE prose containing a bare
    // "basic"/"bearer" word (see the redactor-documented-overmatch class), so this check is
    // intentionally one-directional and never runs over a fixture where secDetect is false.
    for (const { fixture } of allFixtures()) {
      if (containsCredentialShape(fixture.value)) {
        expect(redact(fixture.value), fixture.id).not.toBe(fixture.value);
      }
    }
  });
});
