import type { CSSProperties } from "react";

/**
 * User-agent default neutralisers for the native elements adopted in place of ARIA roles (#2721).
 *
 * S6819 asks a surface that carries an ARIA role to use the element that already owns it:
 * `role="status"` -> `<output>`, `role="list"` -> `<ul>`, `role="heading"` -> `<h1>`-`<h6>`,
 * `role="group"` -> `<fieldset>`. The role attribute carried no styling; the native element
 * arrives with user-agent defaults the `<div>`/`<span>` it replaces never had.
 *
 * These are inline styles rather than classes on purpose. `globals.css` is byte-pinned by the
 * #1300 visual proof and cannot absorb them, and a second global stylesheet would put global
 * class rules outside the design system's one governed entry point. A shared `CSSProperties`
 * constant is the idiom this package already uses for exactly this (`LOADING_STATE_STYLE`,
 * `FILTER_GROUP_STYLE`, `CHAT_TURN_CONTENT_VISIBILITY_STYLE`), and it removes the cascade
 * question entirely: the neutralisation applies to precisely the element it is written on.
 *
 * Because an inline style beats the surface's own class, each constant neutralises only the
 * user-agent defaults a class is unlikely to set. Apply the narrowest one that fits, and never
 * apply one whose properties the surface's own class already declares.
 */

/** `<output>` is `display:inline`; every surface migrated from a block-level element needs its box back. */
export const NATIVE_BLOCK_STYLE: CSSProperties = { display: "block" };

/** `<ul>`/`<menu>` ship a marker, a block margin and a 40px start padding. */
export const NATIVE_LIST_STYLE: CSSProperties = { listStyle: "none", margin: 0, padding: 0 };

/** As above, for a list whose own class declares the padding it needs. */
export const NATIVE_LIST_KEEP_PADDING_STYLE: CSSProperties = { listStyle: "none", margin: 0 };

/**
 * `<h1>`-`<h6>` ship a scaled font-size, a bold weight and block margins. Font-size and colour
 * are left alone: the surfaces that carried `role="heading"` declare their own type.
 */
export const NATIVE_HEADING_STYLE: CSSProperties = { margin: 0, fontWeight: "inherit" };

/**
 * `<fieldset>` ships a groove border, a 2px inline margin, inline padding and a
 * `min-inline-size:min-content` that stops it shrinking inside a flex row. Only the margin and
 * the min-size are neutralised here — a fieldset's own class almost always sets padding/border.
 */
export const NATIVE_FIELDSET_STYLE: CSSProperties = { margin: 0, minWidth: 0 };

/** As above, for a group whose own class declares neither padding nor border. */
export const NATIVE_FIELDSET_RESET_STYLE: CSSProperties = {
  margin: 0,
  minWidth: 0,
  padding: 0,
  border: 0,
};

/** `<dialog>` is absolutely positioned and auto-margined by default; role-migrated dialogs remain grid children. */
export const NATIVE_DIALOG_STYLE: CSSProperties = { margin: 0, position: "static" };
