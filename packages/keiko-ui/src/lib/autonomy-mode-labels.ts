/** Shared product mode labels; feature explanations remain with their respective surfaces. */
export const EN_AUTONOMY_MODE_LABELS = {
  "codingWorkbench.mode.governed-assist.label": "Ask for approval",
  "codingWorkbench.mode.supervised-coding.label": "Supervised workspace",
  "codingWorkbench.mode.autonomous-delivery.label": "Full access",
} as const;

export const DE_AUTONOMY_MODE_LABELS: Record<keyof typeof EN_AUTONOMY_MODE_LABELS, string> = {
  "codingWorkbench.mode.governed-assist.label": "Um Genehmigung bitten",
  "codingWorkbench.mode.supervised-coding.label": "Überwachter Workspace",
  "codingWorkbench.mode.autonomous-delivery.label": "Vollzugriff",
};
