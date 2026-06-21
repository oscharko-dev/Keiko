/* ============================================================
   lift-icons.jsx — the Keiko "Lift" icon system (chosen signature).

   GRAMMAR
     · 24×24 grid, 20×20 live area (2px keyline trim)
     · stroke 1.6 @ 24px · round caps · round joins · no fills
     · currentColor (monochrome); colour is the host's job, on hover only
     · THE LIFT: every closed contour carries exactly one open seam —
       the lifted pen. Open/gestural glyphs belong by stroke quality,
       not a forced seam.
   ============================================================ */

const f = (n) => (+n).toFixed(2);
const pt = (cx, cy, r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};
// clockwise arc a0→a1 (deg)
const arc = (cx, cy, r, a0, a1) => {
  const [x0, y0] = pt(cx, cy, r, a0);
  const [x1, y1] = pt(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${f(x0)} ${f(y0)} A${r} ${r} 0 ${large} 1 ${f(x1)} ${f(y1)}`;
};
// ring with one seam (gap centred at `at` degrees; -90 = top)
const ring = (cx, cy, r, at = -90, gap = 34) => arc(cx, cy, r, at + gap / 2, at + gap / 2 + (360 - gap));
// rounded rect, open seam centred on the top edge
const box = (x, y, w, h, r, gap = 3) => {
  const a = x + (w - gap) / 2;
  const b = x + (w + gap) / 2;
  return (
    `M${f(b)} ${f(y)} H${f(x + w - r)} A${r} ${r} 0 0 1 ${f(x + w)} ${f(y + r)} ` +
    `V${f(y + h - r)} A${r} ${r} 0 0 1 ${f(x + w - r)} ${f(y + h)} H${f(x + r)} ` +
    `A${r} ${r} 0 0 1 ${f(x)} ${f(y + h - r)} V${f(y + r)} A${r} ${r} 0 0 1 ${f(x + r)} ${f(y)} H${f(a)}`
  );
};
// plain closed rounded rect (for secondary, non-seam shapes)
const rect = (x, y, w, h, r) =>
  `M${f(x + r)} ${f(y)} H${f(x + w - r)} A${r} ${r} 0 0 1 ${f(x + w)} ${f(y + r)} ` +
  `V${f(y + h - r)} A${r} ${r} 0 0 1 ${f(x + w - r)} ${f(y + h)} H${f(x + r)} ` +
  `A${r} ${r} 0 0 1 ${f(x)} ${f(y + h - r)} V${f(y + r)} A${r} ${r} 0 0 1 ${f(x + r)} ${f(y)} Z`;
const spokes = (cx, cy, r0, r1, n) =>
  [...Array(n)].map((_, i) => {
    const d = (i * 360) / n;
    const [ax, ay] = pt(cx, cy, r0, d);
    const [bx, by] = pt(cx, cy, r1, d);
    return `M${f(ax)} ${f(ay)} L${f(bx)} ${f(by)}`;
  }).join(" ");
// four-point sparkle (closed, gestural — like `spark`)
const star4 = (cx, cy, rO, rI) => {
  const A = [-90, -45, 0, 45, 90, 135, 180, 225];
  return "M " + A.map((a, i) => { const [x, y] = pt(cx, cy, i % 2 ? rI : rO, a); return `${f(x)} ${f(y)}`; }).join(" L ") + " Z";
};
// toothed cog — one Lift seam centred on the top tooth
const gearPath = (cx, cy, rOut, rIn, teeth, half, slope, gapHalf) => {
  const start = 270 + gapHalf, end = 270 + 360 - gapHalf;
  let nodes = [];
  for (let i = 0; i < teeth; i++) { const c = 270 + i * (360 / teeth); nodes.push([c - half - slope, rIn], [c - half, rOut], [c + half, rOut], [c + half + slope, rIn]); }
  nodes = nodes.map(([a, r]) => { let x = a; while (x <= start) x += 360; while (x >= start + 360) x -= 360; return [x, r]; })
    .filter(([a]) => a > start + 0.01 && a < end - 0.01).sort((p, q) => p[0] - q[0]);
  const pts = [[start, rOut], ...nodes, [end, rOut]];
  return "M " + pts.map(([a, r]) => { const [x, y] = pt(cx, cy, r, a); return `${f(x)} ${f(y)}`; }).join(" L ");
};

// ── the library — keys mirror packages/keiko-ui …/Icons.tsx where they exist ──
const LIFT = {
  // — search / create —
  search: (
    <>
      <path d={ring(10.5, 10.5, 6)} />
      <path d="M14.7 14.7 L20 20" />
    </>
  ),
  compose: (
    <>
      <path d="M4 6 H12.5" />
      <path d="M4 9.5 H9.5" />
      <path d="M14.4 13.6 l4-4 a1.6 1.6 0 0 1 2.3 2.3 l-6.2 6.2 -3 .7 .7 -3 z" />
    </>
  ),
  plus: <path d="M12 5 V19 M5 12 H19" />,
  check: <path d="M5 12.5 l4.5 4.5 L19 6.5" />,
  chevron: <path d="M6 9 l6 6 6 -6" />,
  chevronR: <path d="M9 6 l6 6 -6 6" />,
  send: <path d="M12 19 V5 M6 11 l6 -6 6 6" />,

  // — files / data —
  folder: (
    <>
      <path d="M3.6 7.4 V6.3 a1.5 1.5 0 0 1 1.5-1.5 H8 a1.5 1.5 0 0 1 1.1 .48 L10.3 7.4" />
      <path d={box(3.6, 7.4, 16.8, 11, 2.4)} />
    </>
  ),
  files: (
    <>
      <path d="M5.5 8 V5.5 a1.9 1.9 0 0 1 1.9-1.9 H12.8 L18.5 8.8 V18.5 a1.9 1.9 0 0 1-1.9 1.9 H7.4 a1.9 1.9 0 0 1-1.9-1.9 V11" />
      <path d="M12.8 3.6 V7.4 a1.4 1.4 0 0 0 1.4 1.4 H18.5" />
    </>
  ),
  terminal: (
    <>
      <path d={box(4, 5, 16, 14, 2.5, 3.4)} />
      <path d="M8 9.6 L11 12.6 L8 15.6" />
      <path d="M12.8 15.6 H16.4" />
    </>
  ),
  branch: (
    <>
      <path d={ring(6, 6.6, 2.3, -90, 90)} />
      <circle cx="6" cy="17.4" r="2.3" />
      <circle cx="17.4" cy="8.6" r="2.3" />
      <path d="M6 8.9 V15.1" />
      <path d="M17.4 10.9 c0 4 -4 3.7 -7 4.7" />
    </>
  ),
  server: (
    <>
      <path d={box(4, 4.5, 16, 6, 1.7, 2.6)} />
      <path d={rect(4, 13.5, 16, 6, 1.7)} />
      <path d="M7.4 7.5 h.01 M7.4 16.5 h.01 M12 7.5 H16 M12 16.5 H16" />
    </>
  ),

  // — window / layout —
  sidebar: (
    <>
      <path d={box(3.5, 4.5, 17, 15, 2.5)} />
      <path d="M9.5 5 V19" />
    </>
  ),
  panelRight: (
    <>
      <path d={box(3.5, 4.5, 17, 15, 2.5)} />
      <path d="M14.5 5 V19" />
    </>
  ),
  split: (
    <>
      <path d={box(3.5, 4.5, 17, 15, 2.5)} />
      <path d="M12 5 V19" />
    </>
  ),
  tile: (
    <>
      <path d={box(3.5, 4.5, 7, 7, 1.5, 2.2)} />
      <path d={rect(13.5, 4.5, 7, 7, 1.5)} />
      <path d={rect(3.5, 13.5, 7, 7, 1.5)} />
      <path d={rect(13.5, 13.5, 7, 7, 1.5)} />
    </>
  ),
  layers: (
    <>
      <path d="M13.4 4.55 L19.6 8 L12 12.2 L4.4 8 L10.6 4.55" />
      <path d="M4.4 12 L12 16.2 L19.6 12" />
      <path d="M4.4 16 L12 20.2 L19.6 16" />
    </>
  ),

  // — system —
  settings: (
    <>
      <path d={gearPath(12, 12, 8.7, 6.4, 8, 8, 7, 6.7)} />
      <circle cx="12" cy="12" r="2.7" />
    </>
  ),
  llm: (
    <>
      <path d={box(3.5, 4.5, 17, 12, 3.2)} />
      <path d="M8.4 16.5 L6.3 19.8 L11.1 16.5" />
      <path d={star4(12, 10.2, 3.1, 1.15)} />
    </>
  ),
  embedding: (
    <>
      <path d="M4.8 19.2 L12 12" />
      <path d="M11.2 15.0 L12 12 L9.0 12.8" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="8.3" cy="6.8" r="1.4" />
      <circle cx="15.7" cy="7.8" r="1.4" />
      <circle cx="16.6" cy="14.6" r="1.4" />
    </>
  ),
  error: (
    <>
      <path d={ring(12, 12, 8.6)} />
      <path d="M9 9 L15 15" />
      <path d="M15 9 L9 15" />
    </>
  ),
  alert: (
    <>
      <path d="M12.85 6.2 L20 18.6 H4 L11.15 6.2" />
      <path d="M12 9 V14" />
      <path d="M12 16.8 h.01" />
    </>
  ),
  info: (
    <>
      <path d={ring(12, 12, 8.6)} />
      <path d="M12 8.2 h.01" />
      <path d="M12 11.3 V16.3" />
    </>
  ),
  success: (
    <>
      <path d={ring(12, 12, 8.6)} />
      <path d="M8.1 12.2 l2.6 2.6 L16 9.2" />
    </>
  ),
  bell: (
    <>
      <path d="M9.8 4.6 a5.5 5.5 0 0 1 7.7 4.4 c0 4.5 2 5.5 2 5.5 H4.5 s2 -1 2 -5.5 a5.5 5.5 0 0 1 1.1 -3.3" />
      <path d="M10 19 a2 2 0 0 0 4 0" />
    </>
  ),
  archive: (
    <>
      <path d={box(3.5, 5, 17, 4, 1, 2.4)} />
      <path d="M5 9 v8 a2 2 0 0 0 2 2 h10 a2 2 0 0 0 2-2 V9" />
      <path d="M10 13 h4" />
    </>
  ),
  user: (
    <>
      <path d={ring(12, 8, 3.6, -90, 44)} />
      <path d="M5.5 20 c.9 -3.7 3.4 -5.5 6.5 -5.5 s5.6 1.8 6.5 5.5" />
    </>
  ),
  sun: (
    <>
      <path d={ring(12, 12, 4)} />
      <path d="M12 2.5 V5 M12 19 V21.5 M2.5 12 H5 M19 12 H21.5 M5.1 5.1 L6.9 6.9 M17.1 17.1 l1.8 1.8 M18.9 5.1 L17.1 6.9 M6.9 17.1 L5.1 18.9" />
    </>
  ),
  moon: <path d="M19.5 13.5 A8 8 0 1 1 10.5 4.2 a6.5 6.5 0 0 0 9.3 9.1" />,
  spark: <path d="M13.2 3.6 L19 10 l-5.2 1.4 L12 17 l-1.8 -5.6 L5 10 l5.2 -1.4 z" />,
  bolt: <path d="M13 3 L5 13 h5 l-1 8 8 -10 h-5 z" />,
  mic: (
    <>
      <path d="M12 3.2 a3 3 0 0 1 3 3 V11 a3 3 0 0 1 -6 0 V6.2 a3 3 0 0 1 2 -2.8" />
      <path d="M5.5 11.5 a6.5 6.5 0 0 0 13 0 M12 18 v3" />
    </>
  ),

  // ───────────────────── AI · models · reasoning ─────────────────────
  brain: (
    <>
      <path d="M12 5.4 C 11.4 4.2 9.8 4 8.8 4.9 C 7.6 3.9 5.7 4.4 5.3 6.1 C 3.7 6.4 3 8.4 4 9.8 C 2.9 11 3 13 4.4 13.8 C 3.9 15.6 5.1 17.6 7 17.7 C 7.8 19.4 10.4 19.8 12 18.6" />
      <path d="M12 5.4 C 12.6 4.2 14.2 4 15.2 4.9 C 16.4 3.9 18.3 4.4 18.7 6.1 C 20.3 6.4 21 8.4 20 9.8 C 21.1 11 21 13 19.6 13.8 C 20.1 15.6 18.9 17.6 17 17.7 C 16.2 19.4 13.6 19.8 12 18.6" />
      <path d="M12 5.4 C 10.8 7 13.2 8.6 12 10.4 C 10.8 12.2 13.2 14 12 18.6" />
      <path d="M8.8 8 C 7.6 8.4 7.6 10 8.8 10.4" />
      <path d="M9 12.6 C 7.8 13 7.8 14.6 9 15" />
      <path d="M15.2 8 C 16.4 8.4 16.4 10 15.2 10.4" />
      <path d="M15 12.6 C 16.2 13 16.2 14.6 15 15" />
    </>
  ),
  brainHalf: (
    <>
      <path d="M12 5.4 C 11.4 4.2 9.8 4 8.8 4.9 C 7.6 3.9 5.7 4.4 5.3 6.1 C 3.7 6.4 3 8.4 4 9.8 C 2.9 11 3 13 4.4 13.8 C 3.9 15.6 5.1 17.6 7 17.7 C 7.8 19.4 10.4 19.8 12 18.6" />
      <path d="M12 5.4 V18.6" />
      <path d="M8.8 8 C 7.6 8.4 7.6 10 8.8 10.4" />
      <path d="M9 12.6 C 7.8 13 7.8 14.6 9 15" />
    </>
  ),
  modelLarge: (
    <>
      <path d={box(3.5, 4.5, 17, 12, 3.2)} />
      <path d="M8.4 16.5 L6.3 19.8 L11.1 16.5" />
      <path d={star4(11, 10.2, 3.1, 1.15)} />
      <path d={star4(16.4, 7.6, 1.5, 0.55)} />
    </>
  ),
  modelSmall: (
    <>
      <path d={box(5.5, 5.5, 13, 9.5, 3)} />
      <path d="M9.4 15 L7.8 17.9 L11.6 15" />
      <path d={star4(12, 9.9, 2.4, 0.9)} />
    </>
  ),
  tokens: (
    <>
      <path d="M7.5 6.5 H5.5 A1.5 1.5 0 0 0 4 8 V16 A1.5 1.5 0 0 0 5.5 17.5 H7.5" />
      <path d="M16.5 6.5 H18.5 A1.5 1.5 0 0 1 20 8 V16 A1.5 1.5 0 0 1 18.5 17.5 H16.5" />
      <path d="M9 12 h.01 M12 12 h.01 M15 12 h.01" />
    </>
  ),
  agent: (
    <>
      <path d={box(5, 7, 14, 11, 3)} />
      <path d="M12 7 V4.2" />
      <circle cx="12" cy="3.2" r="1" />
      <path d="M9.6 12 h.01 M14.4 12 h.01" />
      <path d="M9.8 15 H14.2" />
      <path d="M5 11.5 H3.5 M19 11.5 H20.5" />
    </>
  ),
  twin: (
    <>
      <path d={ring(9.6, 12, 5, 150, 34)} />
      <path d={ring(14.4, 12, 5, -30, 34)} />
    </>
  ),
  memory: (
    <>
      <path d={box(5.5, 5.5, 13, 13, 3)} />
      <path d={rect(9, 9, 6, 6, 1.5)} />
      <path d="M9 5.5 V3 M15 5.5 V3 M9 18.5 V21 M15 18.5 V21 M5.5 9 H3 M5.5 15 H3 M18.5 9 H21 M18.5 15 H21" />
    </>
  ),

  // ───────────────────── voice · speech ─────────────────────
  speak: (
    <>
      <path d={box(3.5, 5, 17, 12, 3.2)} />
      <path d="M8.4 17 L6.3 20.3 L11.1 17" />
      <path d="M8.5 11 h.01 M12 11 h.01 M15.5 11 h.01" />
    </>
  ),
  waveform: <path d="M4 11 V13 M7 8.5 V15.5 M10 5.8 V18.2 M13 9 V15 M16 7 V17 M19 10.5 V13.5" />,
  speaker: (
    <>
      <path d="M4 9.5 H7 L11.5 5.5 V18.5 L7 14.5 H4 A1 1 0 0 1 3 13.5 V10.5 A1 1 0 0 1 4 9.5 Z" />
      <path d="M15 9.2 a4 4 0 0 1 0 5.6" />
      <path d="M17.3 6.9 a7.5 7.5 0 0 1 0 10.2" />
    </>
  ),
  mute: (
    <>
      <path d="M4 9.5 H7 L11.5 5.5 V18.5 L7 14.5 H4 A1 1 0 0 1 3 13.5 V10.5 A1 1 0 0 1 4 9.5 Z" />
      <path d="M15 9.8 L20 14.8 M20 9.8 L15 14.8" />
    </>
  ),
  micOff: (
    <>
      <path d="M12 3.2 a3 3 0 0 1 3 3 V11 a3 3 0 0 1 -6 0 V6.2 a3 3 0 0 1 2 -2.8" />
      <path d="M5.5 11.5 a6.5 6.5 0 0 0 13 0 M12 18 v3" />
      <path d="M4.5 4.5 L19.5 19.5" />
    </>
  ),
  headphones: (
    <>
      <path d="M5 14 V12 a7 7 0 0 1 14 0 V14" />
      <path d={rect(3.3, 13.5, 3.6, 5.6, 1.6)} />
      <path d={rect(17.1, 13.5, 3.6, 5.6, 1.6)} />
    </>
  ),
  textToSpeech: (
    <>
      <path d="M4 7 H10 M7 7 V16" />
      <path d="M11.8 12 H14.8 M13.2 10.2 L15 12 L13.2 13.8" />
      <path d="M17.5 9.5 V14.5 M20 8 V16" />
    </>
  ),
  speechToText: (
    <>
      <path d="M3 9.5 V14.5 M5.5 8 V16" />
      <path d="M8 12 H11 M9.4 10.2 L11.2 12 L9.4 13.8" />
      <path d="M14 7 H20 M17 7 V16" />
    </>
  ),
  translate: (
    <>
      <path d="M4.5 16.5 L7.5 7.5 L10.5 16.5 M5.4 13.6 H9.6" />
      <path d="M13.5 8 H20 M16.75 7 V8" />
      <path d="M19.5 10.5 H13.8 C 14 14 15.6 16.2 17.5 17.4" />
      <path d="M15.8 13.2 C 16.8 15.2 18.4 16.7 20.2 17.6" />
    </>
  ),

  // ───────────────────── governance · security ─────────────────────
  shield: <path d="M11 3.7 L5 6 V11 c0 5 3.5 8.2 7 9.6 c3.5 -1.4 7 -4.6 7 -9.6 V6 L13 3.7" />,
  shieldCheck: (
    <>
      <path d="M11 3.7 L5 6 V11 c0 5 3.5 8.2 7 9.6 c3.5 -1.4 7 -4.6 7 -9.6 V6 L13 3.7" />
      <path d="M8.7 11.6 l2.3 2.3 L15.3 9.4" />
    </>
  ),
  shieldAlert: (
    <>
      <path d="M11 3.7 L5 6 V11 c0 5 3.5 8.2 7 9.6 c3.5 -1.4 7 -4.6 7 -9.6 V6 L13 3.7" />
      <path d="M12 8 V12.3 M12 14.9 h.01" />
    </>
  ),
  lock: (
    <>
      <path d={rect(5, 10.5, 14, 9, 2.6)} />
      <path d="M8 10.5 V8 a4 4 0 0 1 7.7 -1.5" />
      <path d="M12 13.8 V16.4" />
    </>
  ),
  unlock: (
    <>
      <path d={rect(5, 10.5, 14, 9, 2.6)} />
      <path d="M8 10.5 V7.8 a4 4 0 0 1 7.4 -1.6" />
      <path d="M12 13.8 V16.4" />
    </>
  ),
  key: (
    <>
      <path d={ring(8, 9, 3.4, 135, 32)} />
      <path d="M10.4 11.4 L18.6 19.6" />
      <path d="M17 18 L18.8 16.2 M14.5 15.5 L16.3 13.7" />
    </>
  ),
  policy: (
    <>
      <path d="M9 4.6 H13.4 L18 9.2 V18.5 a1 1 0 0 1 -1 1 H7 a1 1 0 0 1 -1 -1 V5.6 a1 1 0 0 1 1 -1 H7" />
      <path d="M13.4 4.6 V8.2 a1 1 0 0 0 1 1 H18" />
      <path d="M8.8 13.2 l1.8 1.8 L15 11" />
    </>
  ),
  eval: (
    <>
      <path d="M9.5 4 V9.8 L5.2 17.6 a1.6 1.6 0 0 0 1.4 2.4 H17.4 a1.6 1.6 0 0 0 1.4 -2.4 L14.5 9.8 V4" />
      <path d="M8 4 H16" />
      <path d="M7.4 14 H16.6" />
    </>
  ),
  auditTrail: (
    <>
      <path d="M9 6.5 H19 M9 12 H18 M9 17.5 H15" />
      <path d="M4 6 l1.3 1.3 L7.4 4.7" />
      <path d="M4 11.5 l1.3 1.3 L7.4 10.2" />
      <path d="M4.3 17.5 h.01" />
    </>
  ),
  permission: (
    <>
      <path d={ring(9.5, 8.5, 3.2, -90, 44)} />
      <path d="M4.5 19.5 c.7 -3.3 2.8 -5 5 -5 c1 0 2 .3 2.8 .9" />
      <path d="M14.5 16.5 l1.7 1.7 L20 14.5" />
    </>
  ),

  // ───────────────────── AI control · feedback ─────────────────────
  regenerate: (
    <>
      <path d="M6 9.5 A6.8 6.8 0 0 1 18.2 8.2" />
      <path d="M18.6 4.2 L18.4 8.4 L14.3 7.7" />
      <path d="M18 14.5 A6.8 6.8 0 0 1 5.8 15.8" />
      <path d="M5.4 19.8 L5.6 15.6 L9.7 16.3" />
    </>
  ),
  stop: <path d={rect(6.5, 6.5, 11, 11, 2.5)} />,
  play: <path d="M8 6 L18.5 12 L8 18 Z" />,
  pause: <path d="M9 5.5 V18.5 M15 5.5 V18.5" />,
  thumbsUp: (
    <>
      <path d={rect(3.5, 10.5, 3.5, 8.5, 1)} />
      <path d="M7 10.5 L11 4.3 a1.8 1.8 0 0 1 2.7 1.9 L13 9.8 H18.4 a1.8 1.8 0 0 1 1.8 2.2 L18.3 17 a1.8 1.8 0 0 1 -1.8 1.5 H7" />
    </>
  ),
  thumbsDown: (
    <>
      <path d={rect(3.5, 5, 3.5, 8.5, 1)} />
      <path d="M7 13.5 L11 19.7 a1.8 1.8 0 0 0 2.7 -1.9 L13 14.2 H18.4 a1.8 1.8 0 0 0 1.8 -2.2 L18.3 7 a1.8 1.8 0 0 0 -1.8 -1.5 H7" />
    </>
  ),
  clock: (
    <>
      <path d={ring(12, 12, 8.2, -90, 26)} />
      <path d="M12 7.4 V12 L15.4 13.8" />
    </>
  ),

  // ───────────────────── connectivity · plugins ─────────────────────
  plug: (
    <>
      <path d="M8.5 4 V8 M15.5 4 V8" />
      <path d="M6.8 8 H17.2 V10.8 a5.2 5.2 0 0 1 -10.4 0 Z" />
      <path d="M12 16 V20.5" />
    </>
  ),
  puzzle: (
    <path d="M9.2 5 a1.7 1.7 0 0 1 3.4 0 c0 .5 -.2 .9 -.4 1.3 H15.5 a1 1 0 0 1 1 1 V10.4 c.4 -.2 .8 -.4 1.3 -.4 a1.7 1.7 0 0 1 0 3.4 c-.5 0 -.9 -.2 -1.3 -.4 V16.5 a1 1 0 0 1 -1 1 H12.8 c.2 .4 .4 .8 .4 1.3 a1.7 1.7 0 0 1 -3.4 0 c0 -.5 .2 -.9 .4 -1.3 H7 a1 1 0 0 1 -1 -1 V13.6 c-.4 .2 -.8 .4 -1.3 .4 a1.7 1.7 0 0 1 0 -3.4 c.5 0 .9 .2 1.3 .4 V7.3 a1 1 0 0 1 1 -1 H9.6 c-.2 -.4 -.4 -.8 -.4 -1.3 Z" />
  ),
  link: (
    <>
      <path d="M9.5 14.5 L14.5 9.5" />
      <path d="M11 7.8 L12.8 6 a3.4 3.4 0 0 1 4.8 4.8 L15.8 12.6" />
      <path d="M13 16.2 L11.2 18 a3.4 3.4 0 0 1 -4.8 -4.8 L8.2 11.4" />
    </>
  ),
  globe: (
    <>
      <path d={ring(12, 12, 8.2, -90, 24)} />
      <path d="M3.9 12 H20.1" />
      <path d="M12 3.9 C 8.3 6.5 8.3 17.5 12 20.1 C 15.7 17.5 15.7 6.5 12 3.9" />
    </>
  ),
  cloud: <path d="M7.2 18 A4.3 4.3 0 0 1 7.4 9.4 A5.8 5.8 0 0 1 18.3 10.8 A3.6 3.6 0 0 1 17.6 18 H7.2" />,
  database: (
    <>
      <path d="M5 6.5 V17.5 a7 2.6 0 0 0 14 0 V6.5" />
      <path d="M5 6.5 a7 2.6 0 0 1 14 0 a7 2.6 0 0 1 -14 0" />
      <path d="M5 12 a7 2.6 0 0 0 14 0" />
    </>
  ),

  // ───────────────────── data · viz ─────────────────────
  barChart: (
    <>
      <path d="M4 19.5 H20" />
      <path d="M7.5 19.5 V12.5 M12 19.5 V7.5 M16.5 19.5 V10.5" />
    </>
  ),
  lineChart: (
    <>
      <path d="M4 4 V20 H20" />
      <path d="M5.5 16 L9 11.5 L13 14 L19 6.5" />
    </>
  ),
  pieChart: (
    <>
      <path d={ring(12, 12, 8.2, -90, 24)} />
      <path d="M12 12 V3.9 M12 12 L19.4 14.6" />
    </>
  ),
  activity: <path d="M3 12 H7 L9.5 6 L13.5 18 L16 12 H21" />,

  // ───────────────────── utility ─────────────────────
  eye: (
    <>
      <path d="M3.6 12 C 7 8 17 8 20.4 12" />
      <path d="M20.4 12 C 17 16 7 16 3.6 12" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M9.6 6.3 A9 9 0 0 1 12 6 C 16.5 6 19.5 9 20.4 12 A11 11 0 0 1 18.4 15" />
      <path d="M6.3 7.8 C 4.6 9 3.4 10.5 2.6 12 C 4 15 7 18 12 18 A9 9 0 0 0 14.4 17.7" />
      <path d="M14.5 14.7 A2.6 2.6 0 0 1 9.5 12.4" />
      <path d="M4.5 4.5 L19.5 19.5" />
    </>
  ),
  copy: (
    <>
      <path d={box(8, 8, 12, 12, 2.8)} />
      <path d="M5.6 16 H5 A1.4 1.4 0 0 1 3.6 14.6 V5 A1.4 1.4 0 0 1 5 3.6 H14.6 A1.4 1.4 0 0 1 16 5 V5.6" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 6.8 H19.5" />
      <path d="M9 6.8 V4.6 H15 V6.8" />
      <path d="M6.6 6.8 V19 a1.6 1.6 0 0 0 1.6 1.6 H15.8 a1.6 1.6 0 0 0 1.6 -1.6 V6.8" />
      <path d="M10 10.5 V16.5 M14 10.5 V16.5" />
    </>
  ),
  edit: (
    <>
      <path d="M16.4 4.6 a2 2 0 0 1 3 3 L8 19 L4 20 L5 16 Z" />
      <path d="M14 7 L17 10" />
    </>
  ),
  download: (
    <>
      <path d="M12 4 V15" />
      <path d="M7.5 10.5 L12 15 L16.5 10.5" />
      <path d="M5 19.5 H19" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16 V5" />
      <path d="M7.5 9.5 L12 5 L16.5 9.5" />
      <path d="M5 19.5 H19" />
    </>
  ),
  filter: <path d="M4.5 6 H19.5 L14 13 V18.5 L10 16.5 V13 Z" />,
  ellipsis: <path d="M6 12 h.01 M12 12 h.01 M18 12 h.01" />,
  external: (
    <>
      <path d="M14 4.8 H19.2 V10" />
      <path d="M19.2 4.8 L11 13" />
      <path d="M17 13.5 V18 a1.6 1.6 0 0 1 -1.6 1.6 H6.6 A1.6 1.6 0 0 1 5 18 V9.2 A1.6 1.6 0 0 1 6.6 7.6 H11" />
    </>
  ),
  code: (
    <>
      <path d="M8.5 8 L4.5 12 L8.5 16" />
      <path d="M15.5 8 L19.5 12 L15.5 16" />
      <path d="M13.5 5.5 L10.5 18.5" />
    </>
  ),

  // ─────────────────── editor · IDE · run / debug ───────────────────
  run: <path d="M8 5.8 L18.2 12 L8 18.2 Z" />,
  debug: (
    <>
      <path d="M8.5 9.2 C 8.5 6.9 10 6 12 6 C 14 6 15.5 6.9 15.5 9.2 V12.4 C 15.5 15.8 14 17.6 12 17.6 C 10 17.6 8.5 15.8 8.5 12.4 Z" />
      <path d="M9.7 7.2 L8.3 5.2 M14.3 7.2 L15.7 5.2" />
      <path d="M8.5 10.4 H5.4 M8.5 13.4 H5.4 M15.5 10.4 H18.6 M15.5 13.4 H18.6" />
      <path d="M8.7 8.6 L6.2 7 M15.3 8.6 L17.8 7 M8.7 15.2 L6.2 16.8 M15.3 15.2 L17.8 16.8" />
      <path d="M12 8 V15.6" />
    </>
  ),
  bug: (
    <>
      <path d="M8.5 9.2 C 8.5 6.9 10 6 12 6 C 14 6 15.5 6.9 15.5 9.2 V12.4 C 15.5 15.8 14 17.6 12 17.6 C 10 17.6 8.5 15.8 8.5 12.4 Z" />
      <path d="M9.7 7.2 L8.3 5.2 M14.3 7.2 L15.7 5.2" />
      <path d="M8.5 10.4 H5.4 M8.5 13.4 H5.4 M15.5 10.4 H18.6 M15.5 13.4 H18.6" />
      <path d="M8.7 8.6 L6.2 7 M15.3 8.6 L17.8 7 M8.7 15.2 L6.2 16.8 M15.3 15.2 L17.8 16.8" />
      <path d="M12 8 V15.6" />
    </>
  ),
  breakpoint: <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />,
  resume: (
    <>
      <path d="M5.5 6 V18" />
      <path d="M9 6.5 L19 12 L9 17.5 Z" />
    </>
  ),
  stepOver: (
    <>
      <path d="M6 11.5 A6 6 0 0 1 18 11.5" />
      <path d="M18 7.4 V11.6 H14" />
      <circle cx="12" cy="16" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  stepInto: (
    <>
      <path d="M12 4 V12.6" />
      <path d="M8.2 9 L12 12.8 L15.8 9" />
      <circle cx="12" cy="18" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  stepOut: (
    <>
      <path d="M12 12.8 V4.2" />
      <path d="M8.2 8 L12 4.2 L15.8 8" />
      <circle cx="12" cy="18" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  restart: (
    <>
      <path d="M18.6 8.6 A7 7 0 1 0 19 12" />
      <path d="M19 4.6 V8.9 H14.7" />
    </>
  ),
  rollback: (
    <>
      <path d="M5.4 12 A6.6 6.6 0 1 1 7.6 16.9" />
      <path d="M5.4 7.6 V12 H9.8" />
    </>
  ),
  build: (
    <>
      <path d="M13.6 10.4 L6.2 17.8 a1.9 1.9 0 0 1 -2.7 -2.7 L10.9 7.7" />
      <path d="M9.7 6.5 L17.5 14.3 L19.4 12.4 a2.6 2.6 0 0 0 0 -3.7 L15.3 4.6 a2.6 2.6 0 0 0 -3.7 0 Z" />
    </>
  ),
  coverage: (
    <>
      <path d={box(4.5, 4.5, 15, 15, 3)} />
      <path d="M7.8 11.8 l2.3 2.3 L16.2 8.6" />
      <path d="M8 16 H16" />
    </>
  ),
  profiler: (
    <>
      <path d="M4.5 17 A8 8 0 1 1 19.5 17" />
      <path d="M12 12.5 L15.8 8.8" />
      <circle cx="12" cy="12.5" r="1.3" fill="currentColor" stroke="none" />
      <path d="M6.5 12 h.01 M17.5 12 h.01" />
    </>
  ),

  // ─────────────────── editor · tool windows ───────────────────
  project: (
    <>
      <path d={box(3.5, 4.5, 17, 15, 2.5)} />
      <path d="M9.5 5 V19" />
      <path d="M5.8 8.5 H7.3 M5.8 11.5 H7.3 M5.8 14.5 H7.3" />
    </>
  ),
  structure: (
    <>
      <path d="M8 5 H18 M8 9.5 H15 M11 14 H18 M11 18.5 H15" />
      <circle cx="5" cy="5" r="1.3" />
      <circle cx="5" cy="9.5" r="1.3" />
      <circle cx="8" cy="14" r="1.3" />
      <circle cx="8" cy="18.5" r="1.3" />
    </>
  ),
  hierarchy: (
    <>
      <path d={rect(9, 4, 6, 4, 1.2)} />
      <path d={rect(4, 16, 6, 4, 1.2)} />
      <path d={rect(14, 16, 6, 4, 1.2)} />
      <path d="M12 8 V10 M7 16 V13 H17 V16" />
    </>
  ),
  endpoints: (
    <>
      <circle cx="12" cy="12" r="2.4" />
      <circle cx="5" cy="6" r="1.8" />
      <circle cx="19" cy="6" r="1.8" />
      <circle cx="5" cy="18" r="1.8" />
      <circle cx="19" cy="18" r="1.8" />
      <path d="M6.5 7 L10 10.6 M17.5 7 L14 10.6 M6.5 17 L10 13.4 M17.5 17 L14 13.4" />
    </>
  ),
  bookmark: <path d="M7 4.8 H17 a1 1 0 0 1 1 1 V19.6 L12 15.4 L6 19.6 V5.8 a1 1 0 0 1 1 -1 Z" />,
  bookmarks: (
    <>
      <path d="M6 4.8 H14 a1 1 0 0 1 1 1 V17.6 L10 14 L5 17.6 V5.8 a1 1 0 0 1 1 -1 Z" />
      <path d="M17 7 H18 a1 1 0 0 1 1 1 V19.2" />
    </>
  ),
  todo: (
    <>
      <path d={box(4.5, 4.5, 15, 15, 3)} />
      <path d="M7.4 8.8 l1.4 1.4 L11.6 7.4" />
      <path d="M13.2 9 H16.6" />
      <path d="M7.4 15 l1.4 1.4 L11.6 13" />
      <path d="M13.2 15.2 H16.6" />
    </>
  ),
  problems: (
    <>
      <path d="M7 4 H13 L17.5 8.5 V20 H7 Z" />
      <path d="M13 4 V8.5 H17.5" />
      <path d="M12 11 V14 M12 16.6 h.01" />
    </>
  ),
  inspect: (
    <>
      <path d="M7 4 H13 L18 9 V12.4" />
      <path d="M13 4 V9 H18" />
      <path d="M7 4 V20 H10.6" />
      <path d={ring(13.8, 15, 2.8)} />
      <path d="M15.9 17.1 L18.6 19.8" />
    </>
  ),
  learn: (
    <>
      <path d="M2.8 9 L12 5 L21.2 9 L12 13 Z" />
      <path d="M6 11 V15 C 6 16.6 9 17.8 12 17.8 C 15 17.8 18 16.6 18 15 V11" />
      <path d="M21.2 9 V13.5" />
    </>
  ),

  // ─────────────────── editor · version control ───────────────────
  commit: (
    <>
      <path d={ring(12, 12, 3.4)} />
      <path d="M3 12 H8.6 M15.4 12 H21" />
    </>
  ),
  pullRequest: (
    <>
      <circle cx="6.5" cy="6" r="2" />
      <circle cx="6.5" cy="18" r="2" />
      <circle cx="17.5" cy="18" r="2" />
      <path d="M6.5 8 V16" />
      <path d="M17.5 16 V11 A3 3 0 0 0 14.5 8 H11.6" />
      <path d="M13.6 6 L11.2 8.4 L13.6 10.8" />
    </>
  ),
  merge: (
    <>
      <circle cx="6.5" cy="5.5" r="2" />
      <circle cx="17.5" cy="5.5" r="2" />
      <circle cx="12" cy="18.5" r="2" />
      <path d="M6.5 7.5 C 6.5 12 9 13.5 12 16.5" />
      <path d="M17.5 7.5 C 17.5 12 15 13.5 12 16.5" />
    </>
  ),
  compare: (
    <>
      <circle cx="6.5" cy="6" r="2" />
      <circle cx="17.5" cy="18" r="2" />
      <path d="M6.5 8 V13 a2.5 2.5 0 0 0 2.5 2.5 H15.5" />
      <path d="M13.4 13.4 L15.8 15.5 L13.4 17.6" />
      <path d="M17.5 16 V11 a2.5 2.5 0 0 0 -2.5 -2.5 H8.5" />
      <path d="M10.6 6.4 L8.2 8.5 L10.6 10.6" />
    </>
  ),
};

// window controls (Lift): the open seam IS the action mark
const CTL = {
  min: (
    <>
      <path d="M7 14 H10.4" />
      <path d="M13.6 14 H17" />
    </>
  ),
  max: <path d={box(7, 7, 10, 10, 2, 3)} />,
  restore: (
    <>
      <path d="M9 9 V8 a2 2 0 0 1 2 -2 h6 a2 2 0 0 1 2 2 v6 a2 2 0 0 1 -2 2 h-1" />
      <path d={box(5, 9, 10, 10, 2, 3)} />
    </>
  ),
  close: (
    <>
      <path d="M7 7 L10.4 10.4" />
      <path d="M17 7 L13.6 10.4" />
      <path d="M7 17 L10.4 13.6" />
      <path d="M17 17 L13.6 13.6" />
    </>
  ),
};

function LIcon({ name, size = 24, sw = 1.6, style }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
    >
      {LIFT[name] || CTL[name] || null}
    </svg>
  );
}

const CTL_LABEL = { min: "Minimize", max: "Full screen", restore: "Restore", close: "Close" };

function LCtl({ act, force, big }) {
  const S = big ? 44 : 28;
  const G = big ? 26 : 17;
  return (
    <button
      className="kx-ctl"
      data-dir="lift"
      data-act={act}
      data-force={force || undefined}
      style={{ width: S, height: S, borderRadius: big ? 11 : 8 }}
      aria-label={CTL_LABEL[act]}
    >
      <span className="kx-chip" style={big ? { inset: 5, borderRadius: 9 } : undefined} />
      <svg width={G} height={G} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {CTL[act]}
      </svg>
    </button>
  );
}

const LIFT_NAMES = Object.keys(LIFT);

Object.assign(window, { LIcon, LCtl, LIFT_NAMES, CTL_LABEL });
