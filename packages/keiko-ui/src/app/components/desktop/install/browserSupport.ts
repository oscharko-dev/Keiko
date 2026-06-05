/**
 * Pure UA-string browser support detection for PWA install guidance.
 *
 * All logic is in the pure `detectSupport(ua)` function so it can be exercised
 * against fixture UA strings in unit tests — no live navigator.userAgent access.
 *
 * Matrix source: ADR-0024 D3 browser/platform matrix.
 */

export type SupportLevel = "supported" | "ios-add-to-home" | "manual";

/**
 * Derive the install-support level for the given user-agent string.
 *
 * Rules (all comparisons operate on the lowercased UA):
 *  1. `crios/`          → "manual"          (Chrome on iOS — WebView, no prompt)
 *  2. `chrome/` (not `mobile`, not `crios`) → "supported"
 *  3. `edg/`            → "supported"
 *  4. `chromium/`       → "supported"
 *  5. `firefox/`        → "manual"
 *  6. `safari/` on `iphone|ipad|ipod` → "ios-add-to-home"
 *  7. `safari/` on `macintosh`        → "manual"
 *  8. (else)            → "manual"
 */
export function detectSupport(ua: string): SupportLevel {
  const lc = ua.toLowerCase();

  // Chrome iOS (CriOS) — must be checked before generic `chrome/`
  if (lc.includes("crios/")) {
    return "manual";
  }

  // Chromium-family desktop/Android browsers with beforeinstallprompt support
  if (lc.includes("chrome/") && !lc.includes("mobile")) {
    return "supported";
  }

  if (lc.includes("edg/")) {
    return "supported";
  }

  if (lc.includes("chromium/")) {
    return "supported";
  }

  // Firefox — no install prompt
  if (lc.includes("firefox/")) {
    return "manual";
  }

  // Safari on iOS — Add to Home Screen via Share sheet
  if (
    lc.includes("safari/") &&
    (lc.includes("iphone") || lc.includes("ipad") || lc.includes("ipod"))
  ) {
    return "ios-add-to-home";
  }

  // Safari on macOS — no install support
  if (lc.includes("safari/") && lc.includes("macintosh")) {
    return "manual";
  }

  // All other browsers
  return "manual";
}
