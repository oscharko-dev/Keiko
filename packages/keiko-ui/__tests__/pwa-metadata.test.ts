import { describe, expect, it } from "vitest";

import { metadata } from "../src/app/layout";

describe("browser document metadata", () => {
  it("uses the requested product title in the browser tab", () => {
    expect(metadata.title).toBe("Keiko | Ex experientia disco");
  });

  it("does not advertise browser-managed PWA installation", () => {
    expect(metadata.manifest).toBeUndefined();
  });

  it("keeps browser favicon metadata available without a PWA install manifest", () => {
    expect(metadata.icons).toEqual({
      icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
      shortcut: ["/favicon.ico"],
    });
  });
});
