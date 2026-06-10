import { describe, expect, it } from "vitest";

import { metadata } from "../src/app/layout";

describe("PWA document metadata", () => {
  it("uses the requested product title in the browser tab", () => {
    expect(metadata.title).toBe("Keiko | Ex experientia disco");
  });
});
