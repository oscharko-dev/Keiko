/* global document, window */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* lift-glyphs.js — the Lift icon library as plain SVG strings, for static
   pages. Use <span class="ico" data-licon="search" data-size="20"></span>;
   the script fills it. Geometry mirrors lift-icons.jsx exactly. */
(function () {
  function f(n) { return (+n).toFixed(2); }
  function pt(cx, cy, r, d) { var a = (d * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
  function arc(cx, cy, r, a0, a1) {
    var p0 = pt(cx, cy, r, a0), p1 = pt(cx, cy, r, a1), large = a1 - a0 > 180 ? 1 : 0;
    return "M" + f(p0[0]) + " " + f(p0[1]) + " A" + r + " " + r + " 0 " + large + " 1 " + f(p1[0]) + " " + f(p1[1]);
  }
  function ring(cx, cy, r, at, gap) { at = at == null ? -90 : at; gap = gap == null ? 34 : gap; return arc(cx, cy, r, at + gap / 2, at + gap / 2 + (360 - gap)); }
  function box(x, y, w, h, r, gap) {
    gap = gap == null ? 3 : gap; var a = x + (w - gap) / 2, b = x + (w + gap) / 2;
    return "M" + f(b) + " " + f(y) + " H" + f(x + w - r) + " A" + r + " " + r + " 0 0 1 " + f(x + w) + " " + f(y + r) +
      " V" + f(y + h - r) + " A" + r + " " + r + " 0 0 1 " + f(x + w - r) + " " + f(y + h) + " H" + f(x + r) +
      " A" + r + " " + r + " 0 0 1 " + f(x) + " " + f(y + h - r) + " V" + f(y + r) + " A" + r + " " + r + " 0 0 1 " + f(x + r) + " " + f(y) + " H" + f(a);
  }
  function rct(x, y, w, h, r) {
    return "M" + f(x + r) + " " + f(y) + " H" + f(x + w - r) + " A" + r + " " + r + " 0 0 1 " + f(x + w) + " " + f(y + r) +
      " V" + f(y + h - r) + " A" + r + " " + r + " 0 0 1 " + f(x + w - r) + " " + f(y + h) + " H" + f(x + r) +
      " A" + r + " " + r + " 0 0 1 " + f(x) + " " + f(y + h - r) + " V" + f(y + r) + " A" + r + " " + r + " 0 0 1 " + f(x + r) + " " + f(y) + " Z";
  }
  function spokes(cx, cy, r0, r1, n) {
    var o = [];
    for (var i = 0; i < n; i++) { var d = (i * 360) / n, a = pt(cx, cy, r0, d), b = pt(cx, cy, r1, d); o.push("M" + f(a[0]) + " " + f(a[1]) + " L" + f(b[0]) + " " + f(b[1])); }
    return o.join(" ");
  }
  function P(d) { return '<path d="' + d + '"/>'; }

  var G = {
    search: P(ring(10.5, 10.5, 6)) + P("M14.7 14.7 L20 20"),
    compose: P("M4 6 H12.5") + P("M4 9.5 H9.5") + P("M14.4 13.6 l4-4 a1.6 1.6 0 0 1 2.3 2.3 l-6.2 6.2 -3 .7 .7 -3 z"),
    plus: P("M12 5 V19 M5 12 H19"),
    check: P("M5 12.5 l4.5 4.5 L19 6.5"),
    chevron: P("M6 9 l6 6 6 -6"),
    chevronR: P("M9 6 l6 6 -6 6"),
    send: P("M12 19 V5 M6 11 l6 -6 6 6"),
    folder: P("M3.6 7.4 V6.3 a1.5 1.5 0 0 1 1.5-1.5 H8 a1.5 1.5 0 0 1 1.1 .48 L10.3 7.4") + P(box(3.6, 7.4, 16.8, 11, 2.4)),
    files: P("M5.5 8 V5.5 a1.9 1.9 0 0 1 1.9-1.9 H12.8 L18.5 8.8 V18.5 a1.9 1.9 0 0 1-1.9 1.9 H7.4 a1.9 1.9 0 0 1-1.9-1.9 V11") + P("M12.8 3.6 V7.4 a1.4 1.4 0 0 0 1.4 1.4 H18.5"),
    terminal: P(box(4, 5, 16, 14, 2.5, 3.4)) + P("M8 9.6 L11 12.6 L8 15.6") + P("M12.8 15.6 H16.4"),
    branch: P(ring(6, 6.6, 2.3, -90, 90)) + '<circle cx="6" cy="17.4" r="2.3"/><circle cx="17.4" cy="8.6" r="2.3"/>' + P("M6 8.9 V15.1") + P("M17.4 10.9 c0 4 -4 3.7 -7 4.7"),
    server: P(box(4, 4.5, 16, 6, 1.7, 2.6)) + P(rct(4, 13.5, 16, 6, 1.7)) + P("M7.4 7.5 h.01 M7.4 16.5 h.01 M12 7.5 H16 M12 16.5 H16"),
    sidebar: P(box(3.5, 4.5, 17, 15, 2.5)) + P("M9.5 5 V19"),
    panelRight: P(box(3.5, 4.5, 17, 15, 2.5)) + P("M14.5 5 V19"),
    split: P(box(3.5, 4.5, 17, 15, 2.5)) + P("M12 5 V19"),
    tile: P(box(3.5, 4.5, 7, 7, 1.5, 2.2)) + P(rct(13.5, 4.5, 7, 7, 1.5)) + P(rct(3.5, 13.5, 7, 7, 1.5)) + P(rct(13.5, 13.5, 7, 7, 1.5)),
    layers: P("M13.4 4.55 L19.6 8 L12 12.2 L4.4 8 L10.6 4.55") + P("M4.4 12 L12 16.2 L19.6 12") + P("M4.4 16 L12 20.2 L19.6 16"),
    settings: P(ring(12, 12, 2.5, -90, 60)) + P(spokes(12, 12, 4.0, 6.6, 8)),
    bell: P("M9.8 4.6 a5.5 5.5 0 0 1 7.7 4.4 c0 4.5 2 5.5 2 5.5 H4.5 s2 -1 2 -5.5 a5.5 5.5 0 0 1 1.1 -3.3") + P("M10 19 a2 2 0 0 0 4 0"),
    archive: P(box(3.5, 5, 17, 4, 1, 2.4)) + P("M5 9 v8 a2 2 0 0 0 2 2 h10 a2 2 0 0 0 2-2 V9") + P("M10 13 h4"),
    user: P(ring(12, 8, 3.6, -90, 44)) + P("M5.5 20 c.9 -3.7 3.4 -5.5 6.5 -5.5 s5.6 1.8 6.5 5.5"),
    sun: P(ring(12, 12, 4)) + P("M12 2.5 V5 M12 19 V21.5 M2.5 12 H5 M19 12 H21.5 M5.1 5.1 L6.9 6.9 M17.1 17.1 l1.8 1.8 M18.9 5.1 L17.1 6.9 M6.9 17.1 L5.1 18.9"),
    moon: P("M19.5 13.5 A8 8 0 1 1 10.5 4.2 a6.5 6.5 0 0 0 9.3 9.1"),
    spark: P("M13.2 3.6 L19 10 l-5.2 1.4 L12 17 l-1.8 -5.6 L5 10 l5.2 -1.4 z"),
    mic: P("M12 3.2 a3 3 0 0 1 3 3 V11 a3 3 0 0 1 -6 0 V6.2 a3 3 0 0 1 2 -2.8") + P("M5.5 11.5 a6.5 6.5 0 0 0 13 0 M12 18 v3"),
    bolt: P("M13 3 L5 13 h5 l-1 8 8 -10 h-5 z"),
    min: P("M7 14 H10.4") + P("M13.6 14 H17"),
    max: P(box(7, 7, 10, 10, 2, 3)),
    restore: P("M9 9 V8 a2 2 0 0 1 2 -2 h6 a2 2 0 0 1 2 2 v6 a2 2 0 0 1 -2 2 h-1") + P(box(5, 9, 10, 10, 2, 3)),
    close: P("M7 7 L10.4 10.4") + P("M17 7 L13.6 10.4") + P("M7 17 L10.4 13.6") + P("M17 17 L13.6 13.6"),
  };

  function svg(name, size) {
    size = size || 22;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (G[name] || "") + "</svg>";
  }
  function render(root) {
    (root || document).querySelectorAll("[data-licon]").forEach(function (el) {
      if (el.dataset.liconDone) return;
      el.innerHTML = svg(el.getAttribute("data-licon"), parseInt(el.getAttribute("data-size") || "22", 10));
      el.dataset.liconDone = "1";
    });
  }
  window.LiftGlyph = { svg: svg, render: render, names: Object.keys(G) };
  if (document.readyState !== "loading") render();
  else document.addEventListener("DOMContentLoaded", function () { render(); });
})();
