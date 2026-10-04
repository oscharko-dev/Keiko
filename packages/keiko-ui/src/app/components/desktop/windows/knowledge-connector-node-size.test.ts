// Customer screenshots (1.1.11-1.1.13): a Knowledge Pod dragged onto the canvas became a
// 260x220 node, but the connector window used the default 290x190 "too small" threshold, so the
// node only ever showed "Zu klein für Knowledge Pod". The node must render its content.
import { describe, expect, it } from "vitest";
import { KNOWLEDGE_CONNECTOR_NODE_SIZE, WIN_TYPES } from "./WindowsRegistry";

// WindowFrame measures the content area inside its border before comparing it to `tiny`.
const WINDOW_FRAME_BORDER_PX = 2;

describe("Knowledge Pod canvas node size", () => {
  it("is large enough for the connector window to render its content", () => {
    const connector = WIN_TYPES.connector;
    expect(KNOWLEDGE_CONNECTOR_NODE_SIZE.w - WINDOW_FRAME_BORDER_PX).toBeGreaterThanOrEqual(
      connector.tiny.w,
    );
    expect(KNOWLEDGE_CONNECTOR_NODE_SIZE.h - WINDOW_FRAME_BORDER_PX).toBeGreaterThanOrEqual(
      connector.tiny.h,
    );
  });

  it("keeps a connector window at its minimum size rendering its content", () => {
    const connector = WIN_TYPES.connector;
    expect(connector.min.w - WINDOW_FRAME_BORDER_PX).toBeGreaterThanOrEqual(connector.tiny.w);
    expect(connector.min.h - WINDOW_FRAME_BORDER_PX).toBeGreaterThanOrEqual(connector.tiny.h);
  });
});
