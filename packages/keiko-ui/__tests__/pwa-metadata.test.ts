import { describe, expect, it } from "vitest";

import { metadata } from "../src/app/layout";

describe("PWA document metadata", () => {
  it("uses the requested product title in the browser tab", () => {
    expect(metadata.title).toBe("Keiko | Ex experientia disco");
  });

  it("keeps browser favicon metadata separate from PWA install artwork", () => {
    expect(metadata.icons).toEqual({
      icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
      shortcut: ["/favicon.ico"],
    });
  });
});
