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
      <path d={ring(12, 12, 2.5, -90, 60)} />
      <path d={spokes(12, 12, 4.0, 6.6, 8)} />
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
  mic: (
    <>
      <path d="M12 3.2 a3 3 0 0 1 3 3 V11 a3 3 0 0 1 -6 0 V6.2 a3 3 0 0 1 2 -2.8" />
      <path d="M5.5 11.5 a6.5 6.5 0 0 0 13 0 M12 18 v3" />
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
