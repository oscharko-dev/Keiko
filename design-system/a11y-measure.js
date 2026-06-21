/* ============================================================
   a11y-measure.js — live WCAG contrast measurement.
   No hand-typed ratios anywhere: every number on the audit page is
   computed in-browser by rasterising the actual token colour to sRGB
   and applying the WCAG 2.x relative-luminance formula.

   Modes are measured by toggling data-theme / data-hc on the ROOT
   element itself (saving + restoring the originals), then reading a
   probe in the live tree. This matters: CSS substitutes var() at the
   element where a custom property is DECLARED. Component tokens like
   --tag-text: var(--accent-on-tint) are declared at :root, so they are
   only re-resolved when the override lands on :root — a detached nested
   <div data-theme="light"> would NOT re-substitute them and would read
   stale dark-base values. Toggling the real root fixes that. All reads
   are synchronous, so the page never repaints mid-measure (no flicker).
   ============================================================ */
(function () {
  "use strict";

  var canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  var ctx = canvas.getContext("2d", { willReadFrequently: true });

  // Resolve ANY CSS colour string (oklch, oklab, color-mix, rgb…) to [r,g,b,a 0–255].
  function toRGBA(str) {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = str;          // ignored if invalid → stays #000
    ctx.fillRect(0, 0, 1, 1);
    var d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  }

  function over(fg, base) {
    var a = fg[3];
    return [
      Math.round(fg[0] * a + base[0] * (1 - a)),
      Math.round(fg[1] * a + base[1] * (1 - a)),
      Math.round(fg[2] * a + base[2] * (1 - a)),
      1
    ];
  }
  function lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function lum(rgb) { return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]); }
  function ratio(fg, bg) {
    var a = lum(fg), b = lum(bg), hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }

  var root = document.documentElement;
  var probe = null;
  function getProbe() {
    if (probe) return probe;
    probe = document.createElement("span");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:fixed;left:-9999px;top:0;width:0;height:0;pointer-events:none";
    document.body.appendChild(probe);
    return probe;
  }

  var MODES = ["dark", "light", "darkHC", "lightHC"];
  function setMode(m) {
    if (m === "light" || m === "lightHC") root.setAttribute("data-theme", "light");
    else root.setAttribute("data-theme", "dark");
    if (m === "darkHC" || m === "lightHC") root.setAttribute("data-hc", "more");
    else root.removeAttribute("data-hc");
  }
  function snapshot() { return [root.getAttribute("data-theme"), root.getAttribute("data-hc")]; }
  function restore(s) {
    if (s[0] === null) root.removeAttribute("data-theme"); else root.setAttribute("data-theme", s[0]);
    if (s[1] === null) root.removeAttribute("data-hc"); else root.setAttribute("data-hc", s[1]);
  }

  // Resolve a CSS colour expression to RGBA in whatever mode is currently set on root.
  function resolveLive(expr) {
    var p = getProbe();
    p.style.setProperty("color", "");
    p.style.setProperty("color", expr);
    return toRGBA(getComputedStyle(p).color);
  }
  // Public single-mode resolve (sets the mode on root, reads, restores).
  function resolve(expr, modeKey) {
    var s = snapshot();
    setMode(modeKey);
    var v = resolveLive(expr);
    restore(s);
    return v;
  }

  /* Measure one check across all four modes.
     check = { fg, bg, base?, min } — base is the opaque surface a
     translucent bg/fg is composited over (default --card). */
  function measure(check) {
    var baseExpr = check.base || "var(--card)";
    var out = { ratios: {}, min: Infinity, pass: true };
    var s = snapshot();
    MODES.forEach(function (m) {
      setMode(m);
      var fg = resolveLive(check.fg);
      var bgRaw = resolveLive(check.bg);
      var baseRGB = resolveLive(baseExpr);
      var bg = bgRaw[3] < 1 ? over(bgRaw, baseRGB) : bgRaw;
      var fgC = fg[3] < 1 ? over(fg, bg) : fg;
      var r = ratio(fgC, bg);
      out.ratios[m] = r;
      if (r < out.min) out.min = r;
    });
    restore(s);
    out.pass = out.min >= check.min;
    out.aaa = out.min >= (check.min >= 4.5 ? 7 : 4.5);
    return out;
  }

  window.KeikoA11y = { toRGBA: toRGBA, ratio: ratio, resolve: resolve, measure: measure, MODES: MODES };
})();
