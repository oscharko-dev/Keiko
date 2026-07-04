// Issue #502 — Pure renderer for the discussion-mode directive block (ADR-0107).
//
// When a discussion mode is selected, the model receives the mode's directives as an ADDITIVE,
// labeled prompt block. This module turns the content-free contract plan
// (`DISCUSSION_MODE_PLANS[mode].directives`) into deterministic prompt text via the fixed
// `DISCUSSION_DIRECTIVE_TEMPLATES`. It performs no IO and echoes no raw input: every line is one
// of the bounded, content-free templates the contract defines, so the block can never leak user
// or assistant text, credentials, or provider URLs.

import {
  DISCUSSION_DIRECTIVE_TEMPLATES,
  DISCUSSION_MODE_PLANS,
  type DiscussionMode,
} from "@oscharko-dev/keiko-contracts";

// Fixed label that opens the directive block. Exported so the prompt composer and the test suite
// can assert the block boundary directly (mirrors the CONVERSATION_*_BLOCK_HEADER constants).
export const CONVERSATION_DISCUSSION_BLOCK_HEADER = "Discussion mode directives:";

// Renders the selected mode's directives into a deterministic labeled block: the header line
// followed by one bulleted template line per directive, in the contract's declared directive
// order. Pure and content-free — driven entirely by the frozen contract plan + templates.
export function composeDiscussionDirectiveBlock(mode: DiscussionMode): string {
  const directiveLines = DISCUSSION_MODE_PLANS[mode].directives.map(
    (directive) => `- ${DISCUSSION_DIRECTIVE_TEMPLATES[directive]}`,
  );
  return [CONVERSATION_DISCUSSION_BLOCK_HEADER, ...directiveLines].join("\n");
}
