// Wire shapes for the authenticated local app-session channel (ADR-0141).
//
// Promoted to `keiko-contracts` in W1.5 (#2478) alongside the browser client, exactly as the W1.4
// consequence scheduled (the single contracts measured-surface change is batched there). This
// facade keeps the in-package import site stable while the UI, the trusted launcher, and the
// server all validate one shared definition. The bearer is an HttpOnly cookie and is never
// represented in these shapes.

export {
  CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS,
  CODING_APP_SESSION_CHANNEL_CONTRACT_VERSION,
  CODING_APP_SESSION_CHANNEL_KIND_MAX_CHARS,
  CODING_APP_SESSION_CHANNEL_MAX_UTF8_BYTES,
  codingAppSessionAcknowledgement,
  contentFreeCodingAppSessionChannelSnapshot,
  validateCodingAppSessionChannelContent,
  validateCodingAppSessionChannelSnapshot,
} from "@oscharko-dev/keiko-contracts";
export type {
  CodingAppSessionAcknowledgement,
  CodingAppSessionChannelContent,
  CodingAppSessionChannelSnapshot,
} from "@oscharko-dev/keiko-contracts";
