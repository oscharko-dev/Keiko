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
  function star4(cx, cy, rO, rI) {
    var A = [-90, -45, 0, 45, 90, 135, 180, 225], o = [];
    for (var i = 0; i < 8; i++) { var p = pt(cx, cy, i % 2 ? rI : rO, A[i]); o.push(f(p[0]) + " " + f(p[1])); }
    return "M " + o.join(" L ") + " Z";
  }
  function gearPath(cx, cy, rOut, rIn, teeth, half, slope, gapHalf) {
    var start = 270 + gapHalf, end = 270 + 360 - gapHalf, nodes = [], i, c;
    for (i = 0; i < teeth; i++) { c = 270 + i * (360 / teeth); nodes.push([c - half - slope, rIn], [c - half, rOut], [c + half, rOut], [c + half + slope, rIn]); }
    nodes = nodes.map(function (nd) { var x = nd[0]; while (x <= start) x += 360; while (x >= start + 360) x -= 360; return [x, nd[1]]; })
      .filter(function (nd) { return nd[0] > start + 0.01 && nd[0] < end - 0.01; }).sort(function (a, b) { return a[0] - b[0]; });
    var pts = [[start, rOut]].concat(nodes, [[end, rOut]]);
    return "M " + pts.map(function (nd) { var p = pt(cx, cy, nd[1], nd[0]); return f(p[0]) + " " + f(p[1]); }).join(" L ");
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
    settings: P(gearPath(12, 12, 8.7, 6.4, 8, 8, 7, 6.7)) + '<circle cx="12" cy="12" r="2.7"/>',
    llm: P(box(3.5, 4.5, 17, 12, 3.2)) + P("M8.4 16.5 L6.3 19.8 L11.1 16.5") + P(star4(12, 10.2, 3.1, 1.15)),
    embedding: P("M4.8 19.2 L12 12") + P("M11.2 15.0 L12 12 L9.0 12.8") + '<circle cx="12" cy="12" r="1.5"/><circle cx="8.3" cy="6.8" r="1.4"/><circle cx="15.7" cy="7.8" r="1.4"/><circle cx="16.6" cy="14.6" r="1.4"/>',
    bell: P("M9.8 4.6 a5.5 5.5 0 0 1 7.7 4.4 c0 4.5 2 5.5 2 5.5 H4.5 s2 -1 2 -5.5 a5.5 5.5 0 0 1 1.1 -3.3") + P("M10 19 a2 2 0 0 0 4 0"),
    archive: P(box(3.5, 5, 17, 4, 1, 2.4)) + P("M5 9 v8 a2 2 0 0 0 2 2 h10 a2 2 0 0 0 2-2 V9") + P("M10 13 h4"),
    user: P(ring(12, 8, 3.6, -90, 44)) + P("M5.5 20 c.9 -3.7 3.4 -5.5 6.5 -5.5 s5.6 1.8 6.5 5.5"),
    sun: P(ring(12, 12, 4)) + P("M12 2.5 V5 M12 19 V21.5 M2.5 12 H5 M19 12 H21.5 M5.1 5.1 L6.9 6.9 M17.1 17.1 l1.8 1.8 M18.9 5.1 L17.1 6.9 M6.9 17.1 L5.1 18.9"),
    moon: P("M19.5 13.5 A8 8 0 1 1 10.5 4.2 a6.5 6.5 0 0 0 9.3 9.1"),
    spark: P("M13.2 3.6 L19 10 l-5.2 1.4 L12 17 l-1.8 -5.6 L5 10 l5.2 -1.4 z"),
    error: P(ring(12, 12, 8.6)) + P("M9 9 L15 15") + P("M15 9 L9 15"),
    alert: P("M12.85 6.2 L20 18.6 H4 L11.15 6.2") + P("M12 9 V14") + P("M12 16.8 h.01"),
    info: P(ring(12, 12, 8.6)) + P("M12 8.2 h.01") + P("M12 11.3 V16.3"),
    success: P(ring(12, 12, 8.6)) + P("M8.1 12.2 l2.6 2.6 L16 9.2"),
    mic: P("M12 3.2 a3 3 0 0 1 3 3 V11 a3 3 0 0 1 -6 0 V6.2 a3 3 0 0 1 2 -2.8") + P("M5.5 11.5 a6.5 6.5 0 0 0 13 0 M12 18 v3"),
    bolt: P("M13 3 L5 13 h5 l-1 8 8 -10 h-5 z"),
    min: P("M7 14 H10.4") + P("M13.6 14 H17"),
    max: P(box(7, 7, 10, 10, 2, 3)),
    restore: P("M9 9 V8 a2 2 0 0 1 2 -2 h6 a2 2 0 0 1 2 2 v6 a2 2 0 0 1 -2 2 h-1") + P(box(5, 9, 10, 10, 2, 3)),
    close: P("M7 7 L10.4 10.4") + P("M17 7 L13.6 10.4") + P("M7 17 L10.4 13.6") + P("M17 17 L13.6 13.6"),

    /* — AI · models · reasoning — */
    brain: P("M12 5.4 C 11.4 4.2 9.8 4 8.8 4.9 C 7.6 3.9 5.7 4.4 5.3 6.1 C 3.7 6.4 3 8.4 4 9.8 C 2.9 11 3 13 4.4 13.8 C 3.9 15.6 5.1 17.6 7 17.7 C 7.8 19.4 10.4 19.8 12 18.6") + P("M12 5.4 C 12.6 4.2 14.2 4 15.2 4.9 C 16.4 3.9 18.3 4.4 18.7 6.1 C 20.3 6.4 21 8.4 20 9.8 C 21.1 11 21 13 19.6 13.8 C 20.1 15.6 18.9 17.6 17 17.7 C 16.2 19.4 13.6 19.8 12 18.6") + P("M12 5.4 C 10.8 7 13.2 8.6 12 10.4 C 10.8 12.2 13.2 14 12 18.6") + P("M8.8 8 C 7.6 8.4 7.6 10 8.8 10.4") + P("M9 12.6 C 7.8 13 7.8 14.6 9 15") + P("M15.2 8 C 16.4 8.4 16.4 10 15.2 10.4") + P("M15 12.6 C 16.2 13 16.2 14.6 15 15"),
    brainHalf: P("M12 5.4 C 11.4 4.2 9.8 4 8.8 4.9 C 7.6 3.9 5.7 4.4 5.3 6.1 C 3.7 6.4 3 8.4 4 9.8 C 2.9 11 3 13 4.4 13.8 C 3.9 15.6 5.1 17.6 7 17.7 C 7.8 19.4 10.4 19.8 12 18.6") + P("M12 5.4 V18.6") + P("M8.8 8 C 7.6 8.4 7.6 10 8.8 10.4") + P("M9 12.6 C 7.8 13 7.8 14.6 9 15"),
    modelLarge: P(box(3.5, 4.5, 17, 12, 3.2)) + P("M8.4 16.5 L6.3 19.8 L11.1 16.5") + P(star4(11, 10.2, 3.1, 1.15)) + P(star4(16.4, 7.6, 1.5, 0.55)),
    modelSmall: P(box(5.5, 5.5, 13, 9.5, 3)) + P("M9.4 15 L7.8 17.9 L11.6 15") + P(star4(12, 9.9, 2.4, 0.9)),
    tokens: P("M7.5 6.5 H5.5 A1.5 1.5 0 0 0 4 8 V16 A1.5 1.5 0 0 0 5.5 17.5 H7.5") + P("M16.5 6.5 H18.5 A1.5 1.5 0 0 1 20 8 V16 A1.5 1.5 0 0 1 18.5 17.5 H16.5") + P("M9 12 h.01 M12 12 h.01 M15 12 h.01"),
    agent: P(box(5, 7, 14, 11, 3)) + P("M12 7 V4.2") + '<circle cx="12" cy="3.2" r="1"/>' + P("M9.6 12 h.01 M14.4 12 h.01") + P("M9.8 15 H14.2") + P("M5 11.5 H3.5 M19 11.5 H20.5"),
    twin: P(ring(9.6, 12, 5, 150, 34)) + P(ring(14.4, 12, 5, -30, 34)),
    memory: P(box(5.5, 5.5, 13, 13, 3)) + P(rct(9, 9, 6, 6, 1.5)) + P("M9 5.5 V3 M15 5.5 V3 M9 18.5 V21 M15 18.5 V21 M5.5 9 H3 M5.5 15 H3 M18.5 9 H21 M18.5 15 H21"),

    /* — voice · speech — */
    speak: P(box(3.5, 5, 17, 12, 3.2)) + P("M8.4 17 L6.3 20.3 L11.1 17") + P("M8.5 11 h.01 M12 11 h.01 M15.5 11 h.01"),
    waveform: P("M4 11 V13 M7 8.5 V15.5 M10 5.8 V18.2 M13 9 V15 M16 7 V17 M19 10.5 V13.5"),
    speaker: P("M4 9.5 H7 L11.5 5.5 V18.5 L7 14.5 H4 A1 1 0 0 1 3 13.5 V10.5 A1 1 0 0 1 4 9.5 Z") + P("M15 9.2 a4 4 0 0 1 0 5.6") + P("M17.3 6.9 a7.5 7.5 0 0 1 0 10.2"),
    mute: P("M4 9.5 H7 L11.5 5.5 V18.5 L7 14.5 H4 A1 1 0 0 1 3 13.5 V10.5 A1 1 0 0 1 4 9.5 Z") + P("M15 9.8 L20 14.8 M20 9.8 L15 14.8"),
    micOff: P("M12 3.2 a3 3 0 0 1 3 3 V11 a3 3 0 0 1 -6 0 V6.2 a3 3 0 0 1 2 -2.8") + P("M5.5 11.5 a6.5 6.5 0 0 0 13 0 M12 18 v3") + P("M4.5 4.5 L19.5 19.5"),
    headphones: P("M5 14 V12 a7 7 0 0 1 14 0 V14") + P(rct(3.3, 13.5, 3.6, 5.6, 1.6)) + P(rct(17.1, 13.5, 3.6, 5.6, 1.6)),
    textToSpeech: P("M4 7 H10 M7 7 V16") + P("M11.8 12 H14.8 M13.2 10.2 L15 12 L13.2 13.8") + P("M17.5 9.5 V14.5 M20 8 V16"),
    speechToText: P("M3 9.5 V14.5 M5.5 8 V16") + P("M8 12 H11 M9.4 10.2 L11.2 12 L9.4 13.8") + P("M14 7 H20 M17 7 V16"),
    translate: P("M4.5 16.5 L7.5 7.5 L10.5 16.5 M5.4 13.6 H9.6") + P("M13.5 8 H20 M16.75 7 V8") + P("M19.5 10.5 H13.8 C 14 14 15.6 16.2 17.5 17.4") + P("M15.8 13.2 C 16.8 15.2 18.4 16.7 20.2 17.6"),

    /* — governance · security — */
    shield: P("M11 3.7 L5 6 V11 c0 5 3.5 8.2 7 9.6 c3.5 -1.4 7 -4.6 7 -9.6 V6 L13 3.7"),
    shieldCheck: P("M11 3.7 L5 6 V11 c0 5 3.5 8.2 7 9.6 c3.5 -1.4 7 -4.6 7 -9.6 V6 L13 3.7") + P("M8.7 11.6 l2.3 2.3 L15.3 9.4"),
    shieldAlert: P("M11 3.7 L5 6 V11 c0 5 3.5 8.2 7 9.6 c3.5 -1.4 7 -4.6 7 -9.6 V6 L13 3.7") + P("M12 8 V12.3 M12 14.9 h.01"),
    lock: P(rct(5, 10.5, 14, 9, 2.6)) + P("M8 10.5 V8 a4 4 0 0 1 7.7 -1.5") + P("M12 13.8 V16.4"),
    unlock: P(rct(5, 10.5, 14, 9, 2.6)) + P("M8 10.5 V7.8 a4 4 0 0 1 7.4 -1.6") + P("M12 13.8 V16.4"),
    key: P(ring(8, 9, 3.4, 135, 32)) + P("M10.4 11.4 L18.6 19.6") + P("M17 18 L18.8 16.2 M14.5 15.5 L16.3 13.7"),
    policy: P("M9 4.6 H13.4 L18 9.2 V18.5 a1 1 0 0 1 -1 1 H7 a1 1 0 0 1 -1 -1 V5.6 a1 1 0 0 1 1 -1 H7") + P("M13.4 4.6 V8.2 a1 1 0 0 0 1 1 H18") + P("M8.8 13.2 l1.8 1.8 L15 11"),
    eval: P("M9.5 4 V9.8 L5.2 17.6 a1.6 1.6 0 0 0 1.4 2.4 H17.4 a1.6 1.6 0 0 0 1.4 -2.4 L14.5 9.8 V4") + P("M8 4 H16") + P("M7.4 14 H16.6"),
    auditTrail: P("M9 6.5 H19 M9 12 H18 M9 17.5 H15") + P("M4 6 l1.3 1.3 L7.4 4.7") + P("M4 11.5 l1.3 1.3 L7.4 10.2") + P("M4.3 17.5 h.01"),
    permission: P(ring(9.5, 8.5, 3.2, -90, 44)) + P("M4.5 19.5 c.7 -3.3 2.8 -5 5 -5 c1 0 2 .3 2.8 .9") + P("M14.5 16.5 l1.7 1.7 L20 14.5"),

    /* — AI control · feedback — */
    regenerate: P("M6 9.5 A6.8 6.8 0 0 1 18.2 8.2") + P("M18.6 4.2 L18.4 8.4 L14.3 7.7") + P("M18 14.5 A6.8 6.8 0 0 1 5.8 15.8") + P("M5.4 19.8 L5.6 15.6 L9.7 16.3"),
    stop: P(rct(6.5, 6.5, 11, 11, 2.5)),
    play: P("M8 6 L18.5 12 L8 18 Z"),
    pause: P("M9 5.5 V18.5 M15 5.5 V18.5"),
    thumbsUp: P(rct(3.5, 10.5, 3.5, 8.5, 1)) + P("M7 10.5 L11 4.3 a1.8 1.8 0 0 1 2.7 1.9 L13 9.8 H18.4 a1.8 1.8 0 0 1 1.8 2.2 L18.3 17 a1.8 1.8 0 0 1 -1.8 1.5 H7"),
    thumbsDown: P(rct(3.5, 5, 3.5, 8.5, 1)) + P("M7 13.5 L11 19.7 a1.8 1.8 0 0 0 2.7 -1.9 L13 14.2 H18.4 a1.8 1.8 0 0 0 1.8 -2.2 L18.3 7 a1.8 1.8 0 0 0 -1.8 -1.5 H7"),
    clock: P(ring(12, 12, 8.2, -90, 26)) + P("M12 7.4 V12 L15.4 13.8"),

    /* — connectivity · plugins — */
    plug: P("M8.5 4 V8 M15.5 4 V8") + P("M6.8 8 H17.2 V10.8 a5.2 5.2 0 0 1 -10.4 0 Z") + P("M12 16 V20.5"),
    puzzle: P("M9.2 5 a1.7 1.7 0 0 1 3.4 0 c0 .5 -.2 .9 -.4 1.3 H15.5 a1 1 0 0 1 1 1 V10.4 c.4 -.2 .8 -.4 1.3 -.4 a1.7 1.7 0 0 1 0 3.4 c-.5 0 -.9 -.2 -1.3 -.4 V16.5 a1 1 0 0 1 -1 1 H12.8 c.2 .4 .4 .8 .4 1.3 a1.7 1.7 0 0 1 -3.4 0 c0 -.5 .2 -.9 .4 -1.3 H7 a1 1 0 0 1 -1 -1 V13.6 c-.4 .2 -.8 .4 -1.3 .4 a1.7 1.7 0 0 1 0 -3.4 c.5 0 .9 .2 1.3 .4 V7.3 a1 1 0 0 1 1 -1 H9.6 c-.2 -.4 -.4 -.8 -.4 -1.3 Z"),
    link: P("M9.5 14.5 L14.5 9.5") + P("M11 7.8 L12.8 6 a3.4 3.4 0 0 1 4.8 4.8 L15.8 12.6") + P("M13 16.2 L11.2 18 a3.4 3.4 0 0 1 -4.8 -4.8 L8.2 11.4"),
    globe: P(ring(12, 12, 8.2, -90, 24)) + P("M3.9 12 H20.1") + P("M12 3.9 C 8.3 6.5 8.3 17.5 12 20.1 C 15.7 17.5 15.7 6.5 12 3.9"),
    cloud: P("M7.2 18 A4.3 4.3 0 0 1 7.4 9.4 A5.8 5.8 0 0 1 18.3 10.8 A3.6 3.6 0 0 1 17.6 18 H7.2"),
    database: P("M5 6.5 V17.5 a7 2.6 0 0 0 14 0 V6.5") + P("M5 6.5 a7 2.6 0 0 1 14 0 a7 2.6 0 0 1 -14 0") + P("M5 12 a7 2.6 0 0 0 14 0"),

    /* — data · viz — */
    barChart: P("M4 19.5 H20") + P("M7.5 19.5 V12.5 M12 19.5 V7.5 M16.5 19.5 V10.5"),
    lineChart: P("M4 4 V20 H20") + P("M5.5 16 L9 11.5 L13 14 L19 6.5"),
    pieChart: P(ring(12, 12, 8.2, -90, 24)) + P("M12 12 V3.9 M12 12 L19.4 14.6"),
    activity: P("M3 12 H7 L9.5 6 L13.5 18 L16 12 H21"),

    /* — utility — */
    eye: P("M3.6 12 C 7 8 17 8 20.4 12") + P("M20.4 12 C 17 16 7 16 3.6 12") + '<circle cx="12" cy="12" r="2.5"/>',
    eyeOff: P("M9.6 6.3 A9 9 0 0 1 12 6 C 16.5 6 19.5 9 20.4 12 A11 11 0 0 1 18.4 15") + P("M6.3 7.8 C 4.6 9 3.4 10.5 2.6 12 C 4 15 7 18 12 18 A9 9 0 0 0 14.4 17.7") + P("M14.5 14.7 A2.6 2.6 0 0 1 9.5 12.4") + P("M4.5 4.5 L19.5 19.5"),
    copy: P(box(8, 8, 12, 12, 2.8)) + P("M5.6 16 H5 A1.4 1.4 0 0 1 3.6 14.6 V5 A1.4 1.4 0 0 1 5 3.6 H14.6 A1.4 1.4 0 0 1 16 5 V5.6"),
    trash: P("M4.5 6.8 H19.5") + P("M9 6.8 V4.6 H15 V6.8") + P("M6.6 6.8 V19 a1.6 1.6 0 0 0 1.6 1.6 H15.8 a1.6 1.6 0 0 0 1.6 -1.6 V6.8") + P("M10 10.5 V16.5 M14 10.5 V16.5"),
    edit: P("M16.4 4.6 a2 2 0 0 1 3 3 L8 19 L4 20 L5 16 Z") + P("M14 7 L17 10"),
    download: P("M12 4 V15") + P("M7.5 10.5 L12 15 L16.5 10.5") + P("M5 19.5 H19"),
    upload: P("M12 16 V5") + P("M7.5 9.5 L12 5 L16.5 9.5") + P("M5 19.5 H19"),
    filter: P("M4.5 6 H19.5 L14 13 V18.5 L10 16.5 V13 Z"),
    ellipsis: P("M6 12 h.01 M12 12 h.01 M18 12 h.01"),
    external: P("M14 4.8 H19.2 V10") + P("M19.2 4.8 L11 13") + P("M17 13.5 V18 a1.6 1.6 0 0 1 -1.6 1.6 H6.6 A1.6 1.6 0 0 1 5 18 V9.2 A1.6 1.6 0 0 1 6.6 7.6 H11"),
    code: P("M8.5 8 L4.5 12 L8.5 16") + P("M15.5 8 L19.5 12 L15.5 16") + P("M13.5 5.5 L10.5 18.5"),

    /* — editor · IDE · run / debug — */
    run: P("M8 5.8 L18.2 12 L8 18.2 Z"),
    debug: P("M8.5 9.2 C 8.5 6.9 10 6 12 6 C 14 6 15.5 6.9 15.5 9.2 V12.4 C 15.5 15.8 14 17.6 12 17.6 C 10 17.6 8.5 15.8 8.5 12.4 Z") + P("M9.7 7.2 L8.3 5.2 M14.3 7.2 L15.7 5.2") + P("M8.5 10.4 H5.4 M8.5 13.4 H5.4 M15.5 10.4 H18.6 M15.5 13.4 H18.6") + P("M8.7 8.6 L6.2 7 M15.3 8.6 L17.8 7 M8.7 15.2 L6.2 16.8 M15.3 15.2 L17.8 16.8") + P("M12 8 V15.6"),
    breakpoint: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
    resume: P("M5.5 6 V18") + P("M9 6.5 L19 12 L9 17.5 Z"),
    stepOver: P("M6 11.5 A6 6 0 0 1 18 11.5") + P("M18 7.4 V11.6 H14") + '<circle cx="12" cy="16" r="1.4" fill="currentColor" stroke="none"/>',
    stepInto: P("M12 4 V12.6") + P("M8.2 9 L12 12.8 L15.8 9") + '<circle cx="12" cy="18" r="1.4" fill="currentColor" stroke="none"/>',
    stepOut: P("M12 12.8 V4.2") + P("M8.2 8 L12 4.2 L15.8 8") + '<circle cx="12" cy="18" r="1.4" fill="currentColor" stroke="none"/>',
    restart: P("M18.6 8.6 A7 7 0 1 0 19 12") + P("M19 4.6 V8.9 H14.7"),
    rollback: P("M5.4 12 A6.6 6.6 0 1 1 7.6 16.9") + P("M5.4 7.6 V12 H9.8"),
    build: P("M13.6 10.4 L6.2 17.8 a1.9 1.9 0 0 1 -2.7 -2.7 L10.9 7.7") + P("M9.7 6.5 L17.5 14.3 L19.4 12.4 a2.6 2.6 0 0 0 0 -3.7 L15.3 4.6 a2.6 2.6 0 0 0 -3.7 0 Z"),
    coverage: P(box(4.5, 4.5, 15, 15, 3)) + P("M7.8 11.8 l2.3 2.3 L16.2 8.6") + P("M8 16 H16"),
    profiler: P("M4.5 17 A8 8 0 1 1 19.5 17") + P("M12 12.5 L15.8 8.8") + '<circle cx="12" cy="12.5" r="1.3" fill="currentColor" stroke="none"/>' + P("M6.5 12 h.01 M17.5 12 h.01"),
    bug: P("M8.5 9.2 C 8.5 6.9 10 6 12 6 C 14 6 15.5 6.9 15.5 9.2 V12.4 C 15.5 15.8 14 17.6 12 17.6 C 10 17.6 8.5 15.8 8.5 12.4 Z") + P("M9.7 7.2 L8.3 5.2 M14.3 7.2 L15.7 5.2") + P("M8.5 10.4 H5.4 M8.5 13.4 H5.4 M15.5 10.4 H18.6 M15.5 13.4 H18.6") + P("M8.7 8.6 L6.2 7 M15.3 8.6 L17.8 7 M8.7 15.2 L6.2 16.8 M15.3 15.2 L17.8 16.8") + P("M12 8 V15.6"),

    /* — editor · tool windows — */
    project: P(box(3.5, 4.5, 17, 15, 2.5)) + P("M9.5 5 V19") + P("M5.8 8.5 H7.3 M5.8 11.5 H7.3 M5.8 14.5 H7.3"),
    structure: P("M8 5 H18 M8 9.5 H15 M11 14 H18 M11 18.5 H15") + '<circle cx="5" cy="5" r="1.3"/><circle cx="5" cy="9.5" r="1.3"/><circle cx="8" cy="14" r="1.3"/><circle cx="8" cy="18.5" r="1.3"/>',
    hierarchy: P(rct(9, 4, 6, 4, 1.2)) + P(rct(4, 16, 6, 4, 1.2)) + P(rct(14, 16, 6, 4, 1.2)) + P("M12 8 V10 M7 16 V13 H17 V16"),
    endpoints: '<circle cx="12" cy="12" r="2.4"/><circle cx="5" cy="6" r="1.8"/><circle cx="19" cy="6" r="1.8"/><circle cx="5" cy="18" r="1.8"/><circle cx="19" cy="18" r="1.8"/>' + P("M6.5 7 L10 10.6 M17.5 7 L14 10.6 M6.5 17 L10 13.4 M17.5 17 L14 13.4"),
    bookmark: P("M7 4.8 H17 a1 1 0 0 1 1 1 V19.6 L12 15.4 L6 19.6 V5.8 a1 1 0 0 1 1 -1 Z"),
    bookmarks: P("M6 4.8 H14 a1 1 0 0 1 1 1 V17.6 L10 14 L5 17.6 V5.8 a1 1 0 0 1 1 -1 Z") + P("M17 7 H18 a1 1 0 0 1 1 1 V19.2"),
    todo: P(box(4.5, 4.5, 15, 15, 3)) + P("M7.4 8.8 l1.4 1.4 L11.6 7.4") + P("M13.2 9 H16.6") + P("M7.4 15 l1.4 1.4 L11.6 13") + P("M13.2 15.2 H16.6"),
    problems: P("M7 4 H13 L17.5 8.5 V20 H7 Z") + P("M13 4 V8.5 H17.5") + P("M12 11 V14 M12 16.6 h.01"),
    inspect: P("M7 4 H13 L18 9 V12.4") + P("M13 4 V9 H18") + P("M7 4 V20 H10.6") + P(ring(13.8, 15, 2.8)) + P("M15.9 17.1 L18.6 19.8"),
    learn: P("M2.8 9 L12 5 L21.2 9 L12 13 Z") + P("M6 11 V15 C 6 16.6 9 17.8 12 17.8 C 15 17.8 18 16.6 18 15 V11") + P("M21.2 9 V13.5"),

    /* — editor · version control — */
    commit: P(ring(12, 12, 3.4)) + P("M3 12 H8.6 M15.4 12 H21"),
    pullRequest: '<circle cx="6.5" cy="6" r="2"/><circle cx="6.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/>' + P("M6.5 8 V16") + P("M17.5 16 V11 A3 3 0 0 0 14.5 8 H11.6") + P("M13.6 6 L11.2 8.4 L13.6 10.8"),
    merge: '<circle cx="6.5" cy="5.5" r="2"/><circle cx="17.5" cy="5.5" r="2"/><circle cx="12" cy="18.5" r="2"/>' + P("M6.5 7.5 C 6.5 12 9 13.5 12 16.5") + P("M17.5 7.5 C 17.5 12 15 13.5 12 16.5"),
    compare: '<circle cx="6.5" cy="6" r="2"/><circle cx="17.5" cy="18" r="2"/>' + P("M6.5 8 V13 a2.5 2.5 0 0 0 2.5 2.5 H15.5") + P("M13.4 13.4 L15.8 15.5 L13.4 17.6") + P("M17.5 16 V11 a2.5 2.5 0 0 0 -2.5 -2.5 H8.5") + P("M10.6 6.4 L8.2 8.5 L10.6 10.6"),
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
