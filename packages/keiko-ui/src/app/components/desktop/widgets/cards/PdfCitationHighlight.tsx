"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ClientDiagnosticCitationHighlight } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { bffRequestErrorKind } from "@/lib/http";
import {
  highlightBoxes,
  isPdfTextItem,
  locatePassageItems,
  type HighlightBox,
  type PdfViewportLike,
} from "./pdf-citation-highlight";
import styles from "./PdfCitationPreviewWindow.module.css";

/** The rendered page a highlight reads its text layer from. */
export interface HighlightedPage {
  readonly page: { getTextContent(): Promise<{ readonly items: readonly unknown[] }> };
  readonly viewport: PdfViewportLike;
}

export type CitationHighlightSettled = (highlight: ClientDiagnosticCitationHighlight) => void;

async function frameOnPage(
  rendered: HighlightedPage,
  passage: string,
): Promise<{ boxes: readonly HighlightBox[]; outcome: ClientDiagnosticCitationHighlight }> {
  const content = await rendered.page.getTextContent();
  const items = content.items.filter(isPdfTextItem);
  if (items.length === 0) return { boxes: [], outcome: { outcome: "no-text", boxCount: 0 } };
  const indices = locatePassageItems(items, passage);
  const boxes = indices === undefined ? [] : highlightBoxes(items, indices, rendered.viewport);
  return {
    boxes,
    outcome:
      boxes.length > 0
        ? { outcome: "framed", boxCount: boxes.length }
        : { outcome: "not-found", boxCount: 0 },
  };
}

// Reads the page's text layer and settles the highlight once per rendered page and passage.
function useHighlightBoxes(
  rendered: HighlightedPage,
  passage: string | undefined,
  onSettled: CitationHighlightSettled,
): readonly HighlightBox[] {
  const [boxes, setBoxes] = useState<readonly HighlightBox[]>([]);
  useEffect(() => {
    let disposed = false;
    if (passage === undefined) {
      setBoxes([]);
      onSettled({ outcome: "no-passage", boxCount: 0 });
      return undefined;
    }
    frameOnPage(rendered, passage)
      .then((framed) => {
        if (disposed) return;
        setBoxes(framed.boxes);
        onSettled(framed.outcome);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setBoxes([]);
        // i18n-exempt: body-free diagnostic message for the activity log, never rendered
        reportClientDiagnostic("PDF citation text layer failed", {
          errorKind: bffRequestErrorKind(error),
          errorEvidence: clientErrorEvidence(error),
        });
        onSettled({ outcome: "no-text", boxCount: 0 });
      });
    return (): void => {
      disposed = true;
    };
  }, [onSettled, passage, rendered]);
  return boxes;
}

/**
 * Frames the cited passage on its rendered page. Without a passage, or when the passage is not on
 * the page, nothing is drawn: the viewer never claims a location it cannot show.
 */
export function PdfCitationHighlight({
  rendered,
  passage,
  onSettled,
}: {
  readonly rendered: HighlightedPage;
  readonly passage: string | undefined;
  readonly onSettled: CitationHighlightSettled;
}): ReactNode {
  const boxes = useHighlightBoxes(rendered, passage, onSettled);
  // The boxes are positions on one page; their order is their identity.
  return boxes.map((box, index) => (
    <span
      key={index}
      className={styles.cmpCitationBox}
      data-citation-box=""
      aria-hidden="true"
      style={{
        left: `${String(box.left * 100)}%`,
        top: `${String(box.top * 100)}%`,
        width: `${String(box.width * 100)}%`,
        height: `${String(box.height * 100)}%`,
      }}
    />
  ));
}
