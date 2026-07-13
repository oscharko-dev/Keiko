import type { ReactNode } from "react";
import styles from "./codingWorkbenchStyles";

export function PanelTitle({
  eyebrow,
  id,
  children,
}: {
  readonly eyebrow: string;
  readonly id: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div>
      <p className={styles.label}>{eyebrow}</p>
      <h3 id={id} className={styles.cardTitle}>
        {children}
      </h3>
    </div>
  );
}
