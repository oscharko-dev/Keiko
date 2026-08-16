# Issue #3167 — Conversation Readiness Evidence

Computer-Use evidence for the gateway readiness and conversation-model eligibility contract.

## Surface covered

- Started the real Keiko 0.3.7 workspace in Google Chrome at `localhost:1983`.
- Used the visible **Run readiness check** control with the deterministic local
  `gpt-4o-mini` audit provider, so the journey consumed no external model credit.
- Confirmed Settings reports **Gateway connected**, one chat model, and the explicit
  **Conversation-eligible** status after the basic-chat probe succeeds.
- Opened a new chat through the visible launcher and confirmed its conversation record is bound
  to `gpt-4o-mini`.
- Repeated the connected Settings state in light and dark themes.

## Design-system mapping

- Readiness reuses the existing status-card, badge, button, and semantic token system.
- Eligibility is communicated with explicit text in addition to status color.
- Secondary probe degradation remains visible without overriding the successful basic-chat
  readiness fact.
- No new visual primitives, colors, or typographic rules are introduced.

## Verification evidence

- `01-gateway-connected-light.jpeg`: connected/eligible Settings state, light theme.
- `02-gateway-connected-dark.jpeg`: connected/eligible Settings state, dark theme.
- `03-verified-model-chat.jpeg`: a real newly opened chat bound to the verified model.
- Focused verification: 3 server files / 99 tests and 4 UI files / 228 tests passed.
- Computer-Use accessibility tree exposed Gateway connected, Conversation-eligible, the model
  picker, and the new chat controls.
- The captures contain no credential, secret, or provider request payload.

