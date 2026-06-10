/* Ported 1:1 from the Claude-Design handoff (project/icons.jsx).
   Welle-2/3/4 components rely on the full set being present here — do not prune. */
import type { CSSProperties, ReactNode } from "react";

interface IcoProps {
  size?: number;
  sw?: number;
  vb?: number;
  fill?: string;
  style?: CSSProperties;
  children?: ReactNode;
  d?: string;
}

function Ico({ size = 18, sw = 1.6, vb = 24, fill, style, children, d }: IcoProps): ReactNode {
  const useFill = fill !== undefined;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${String(vb)} ${String(vb)}`}
      fill={useFill ? fill : "none"}
      stroke={useFill ? "none" : "currentColor"}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
    >
      {d !== undefined ? <path d={d} /> : children}
    </svg>
  );
}

export const Icons = {
  newChat: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <path d="M4 5h10M4 9h7" />
      <path d="M14.5 13.5l4-4a1.6 1.6 0 0 1 2.3 2.3l-6.2 6.2-3 .7.7-3 6.2-6.2" />
    </Ico>
  ),
  search: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.3-4.3" />
    </Ico>
  ),
  plugins: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </Ico>
  ),
  automations: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </Ico>
  ),
  mobile: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <rect x="7" y="3" width="10" height="18" rx="2.5" />
      <path d="M11 18h2" />
    </Ico>
  ),
  folder: (p: IcoProps): ReactNode => (
    <Ico
      {...p}
      d="M3.5 7a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.4.6l1 1a2 2 0 0 0 1.4.6H18.5a2 2 0 0 1 2 2v6.2a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7Z"
    />
  ),
  settings: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z" />
      <circle cx="12" cy="12" r="3" />
    </Ico>
  ),
  files: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
      <path d="M13 3v6h6" />
    </Ico>
  ),
  browser: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.3 2.3 2.3 14.7 0 17M12 3.5c-2.3 2.3-2.3 14.7 0 17" />
    </Ico>
  ),
  review: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <path d="M9 12l2 2 4-4" />
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    </Ico>
  ),
  terminal: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M7.5 9l3 3-3 3M13 15h4" />
    </Ico>
  ),
  agents: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <rect x="5" y="7" width="14" height="11" rx="3" />
      <path d="M12 7V4M9 12h.01M15 12h.01M2.5 12.5v2M21.5 12.5v2" />
    </Ico>
  ),
  git: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M6 8.5v7M17 11.5c0 3-3 3.5-6 4" />
    </Ico>
  ),
  plus: (p: IcoProps): ReactNode => <Ico {...p} d="M12 5v14M5 12h14" />,
  chevron: (p: IcoProps): ReactNode => <Ico {...p} d="M6 9l6 6 6-6" />,
  chevronR: (p: IcoProps): ReactNode => <Ico {...p} d="M9 6l6 6-6 6" />,
  mic: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
    </Ico>
  ),
  arrowUp: (p: IcoProps): ReactNode => <Ico {...p} d="M12 19V5M6 11l6-6 6 6" />,
  spark: (p: IcoProps): ReactNode => (
    <Ico {...p} d="M12 3l1.8 5.6L19 10l-5.2 1.4L12 17l-1.8-5.6L5 10l5.2-1.4z" />
  ),
  pin: (p: IcoProps): ReactNode => <Ico {...p} d="M9 3h6l-1 5 3 3-5 1-1 8-1-8-5-1 3-3z" />,
  brain: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
    </Ico>
  ),
  archive: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <rect x="3.5" y="5" width="17" height="4" rx="1" />
      <path d="M5 9v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" />
    </Ico>
  ),
  sidebar: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9.5 4.5v15" />
    </Ico>
  ),
  minimize: (p: IcoProps): ReactNode => <Ico {...p} d="M5 12h14" />,
  expand: (p: IcoProps): ReactNode => <Ico {...p} d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5" />,
  back: (p: IcoProps): ReactNode => <Ico {...p} d="M15 6l-6 6 6 6" />,
  fwd: (p: IcoProps): ReactNode => <Ico {...p} d="M9 6l6 6-6 6" />,
  drag: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <circle cx="9" cy="6" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="18" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="18" r="1.1" fill="currentColor" stroke="none" />
    </Ico>
  ),
  close: (p: IcoProps): ReactNode => <Ico {...p} d="M6 6l12 12M18 6L6 18" />,
  dots: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </Ico>
  ),
  check: (p: IcoProps): ReactNode => <Ico {...p} d="M5 12.5l4.5 4.5L19 6.5" />,
  reset: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <path d="M4 12a8 8 0 1 1 2.3 5.6" />
      <path d="M4 20v-4h4" />
    </Ico>
  ),
  file: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
      <path d="M13 3v6h6" />
    </Ico>
  ),
  diff: (p: IcoProps): ReactNode => <Ico {...p} d="M12 4v6M9 7h6M5 17h14" />,
  branch: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <circle cx="6" cy="6" r="2.3" />
      <circle cx="6" cy="18" r="2.3" />
      <circle cx="18" cy="8" r="2.3" />
      <path d="M6 8.3v7.4M18 10.3c0 4-4 3.7-7 4.7" />
    </Ico>
  ),
  cube: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </Ico>
  ),
  maximize: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <rect x="5" y="5" width="14" height="14" rx="2.5" />
    </Ico>
  ),
  restore: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M5 15V7a2 2 0 0 1 2-2h8" />
    </Ico>
  ),
  split: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M12 4.5v15" />
    </Ico>
  ),
  tile: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <rect x="3.5" y="4.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="4.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </Ico>
  ),
  cascade: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <rect x="4" y="4" width="12" height="12" rx="2" />
      <path d="M20 8v10a2 2 0 0 1-2 2H8" />
    </Ico>
  ),
  editor: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <path d="M8 9l-3 3 3 3M16 9l3 3-3 3M13.5 6l-3 12" />
    </Ico>
  ),
  gear: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M18 6l-1.4 1.4M7.4 16.6 6 18M18 18l-1.4-1.4M7.4 7.4 6 6" />
    </Ico>
  ),
  panelRight: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M14.5 4.5v15" />
    </Ico>
  ),
  layers: (p: IcoProps): ReactNode => (
    <Ico {...p} d="M12 3l8 4.5-8 4.5-8-4.5z M4 12l8 4.5 8-4.5 M4 16.5 12 21l8-4.5" />
  ),
  tokens: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <circle cx="9" cy="9" r="4.5" />
      <path d="M14 9.5a4.5 4.5 0 1 1-4 6.9" />
    </Ico>
  ),
  bolt: (p: IcoProps): ReactNode => <Ico {...p} d="M13 3 5 13h5l-1 8 8-10h-5z" />,
  add: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </Ico>
  ),
  bell: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <path d="M6.5 9a5.5 5.5 0 0 1 11 0c0 4.5 2 5.5 2 5.5H4.5s2-1 2-5.5" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </Ico>
  ),
  sun: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.1 5.1 6.9 6.9M17.1 17.1l1.8 1.8M18.9 5.1 17.1 6.9M6.9 17.1 5.1 18.9" />
    </Ico>
  ),
  moon: (p: IcoProps): ReactNode => (
    <Ico {...p} d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5z" />
  ),
  zoomOut: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2M8.3 11h5.4" />
    </Ico>
  ),
  zoomIn: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2M11 8.3v5.4M8.3 11h5.4" />
    </Ico>
  ),
  activity: (p: IcoProps): ReactNode => <Ico {...p} d="M3 12h3l2.5-7 5 14 2.5-7H21" />,
  localKnowledge: (p: IcoProps): ReactNode => (
    <Ico {...p}>
      <path d="M4 19V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12" />
      <path d="M4 19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2" />
      <path d="M9 7v14M9 11h6" />
    </Ico>
  ),
} as const;

export type IconName = keyof typeof Icons;
