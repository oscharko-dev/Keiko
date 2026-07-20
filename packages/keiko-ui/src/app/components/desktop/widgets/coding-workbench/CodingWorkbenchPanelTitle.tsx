import type { ReactNode, RefObject } from "react";
import styles from "./CodingWorkbenchWindow.module.css";

export function PanelTitle({
  eyebrow,
  id,
  children,
  headingRef,
  focusable = false,
}: {
  readonly eyebrow: string;
  readonly id: string;
  readonly children: ReactNode;
  readonly headingRef?: RefObject<HTMLHeadingElement | null>;
  readonly focusable?: boolean;
}): ReactNode {
  return (
    <div>
      <p className={styles.label}>{eyebrow}</p>
      <h3
        id={id}
        className={styles.cardTitle}
        ref={headingRef}
        tabIndex={focusable ? -1 : undefined}
      >
        {children}
      </h3>
    </div>
  );
}
