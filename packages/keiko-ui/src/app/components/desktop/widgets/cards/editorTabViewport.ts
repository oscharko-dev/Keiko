// GEN-MAINT-COMPLEXITY-001 — pure tab-viewport geometry extracted verbatim from EditorRuntimeWidget.
// These helpers compute how many document tabs fit in the tablist and which slice is visible; they
// take only primitive/array args and read no DOM or React state, so they live here as a testable leaf
// that EditorRuntimeWidget imports back.

const READABLE_TAB_TILE_WIDTH_PX = 112;
const TAB_SUMMARY_TRIGGER_WIDTH_PX = 58;

export function readableTabCapacity(tablistWidth: number, tabCount: number): number {
  if (tablistWidth <= 0 || tabCount <= 2) return tabCount;
  if (tablistWidth >= tabCount * READABLE_TAB_TILE_WIDTH_PX) return tabCount;
  const widthForTabs = Math.max(
    READABLE_TAB_TILE_WIDTH_PX,
    tablistWidth - TAB_SUMMARY_TRIGGER_WIDTH_PX,
  );
  return Math.max(1, Math.min(tabCount - 1, Math.floor(widthForTabs / READABLE_TAB_TILE_WIDTH_PX)));
}

export function visibleTabsForCapacity(
  documentTabs: readonly string[],
  startIndex: number,
  capacity: number,
): readonly string[] {
  if (capacity >= documentTabs.length) return documentTabs;
  const maxStart = Math.max(0, documentTabs.length - capacity);
  const start = Math.min(Math.max(0, startIndex), maxStart);
  return documentTabs.slice(start, start + capacity);
}
