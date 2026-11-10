import type { Page } from "@playwright/test";

interface NativeProgressNode {
  readonly backendNodeId: number;
  readonly attributes?: readonly string[];
  readonly children?: readonly NativeProgressNode[];
  readonly shadowRoots?: readonly NativeProgressNode[];
}

function progressFillNode(node: NativeProgressNode): NativeProgressNode | undefined {
  if (node.attributes?.includes("-webkit-progress-value")) return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = progressFillNode(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Measure the browser's actual fill; computed styles of this native pseudo return host styles. */
export async function nativeProgressFillRatio(page: Page): Promise<number> {
  const session = await page.context().newCDPSession(page);
  try {
    const { root } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "progress",
    });
    const { node } = await session.send("DOM.describeNode", { nodeId, depth: -1, pierce: true });
    const fill = progressFillNode(node);
    if (fill === undefined) throw new TypeError("Native progress fill is unavailable");
    const [{ model: track }, { model: value }] = await Promise.all([
      session.send("DOM.getBoxModel", { nodeId }),
      session.send("DOM.getBoxModel", { backendNodeId: fill.backendNodeId }),
    ]);
    return value.width / track.width;
  } finally {
    await session.detach();
  }
}
