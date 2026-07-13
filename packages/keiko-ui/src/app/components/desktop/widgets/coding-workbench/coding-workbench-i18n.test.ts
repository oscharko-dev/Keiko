import { describe, expect, it } from "vitest";

import { DE_MESSAGES } from "@/lib/i18n-messages.de";
import { EN_MESSAGES } from "@/lib/i18n-messages.en";
import { translateCodingWorkbench } from "./coding-workbench-i18n";

describe("Coding Workbench translations", () => {
  it("localizes English and German feature labels", () => {
    expect(translateCodingWorkbench("en", "codingWorkbench.header.summary")).toBe(
      "Start and supervise one governed coding run. Authority and outcomes remain server-owned.",
    );
    expect(translateCodingWorkbench("de", "codingWorkbench.header.summary")).toBe(
      "Starte und beaufsichtige einen gesteuerten Coding-Lauf. Autorität und Ergebnisse bleiben serverseitig.",
    );
  });

  it("interpolates runtime state and revision in both catalogs", () => {
    expect(
      translateCodingWorkbench("en", "codingWorkbench.announcement.runRevision", {
        revision: 7,
        state: "Running",
      }),
    ).toBe("Running. Revision 7.");
    expect(
      translateCodingWorkbench("de", "codingWorkbench.announcement.runRevision", {
        revision: 7,
        state: "Wird ausgeführt",
      }),
    ).toBe("Wird ausgeführt. Revision 7.");
  });

  it("keeps every Coding Workbench key out of eager locale catalogs", () => {
    expect(Object.keys(EN_MESSAGES)).not.toContainEqual(
      expect.stringMatching(/^codingWorkbench\./u),
    );
    expect(Object.keys(DE_MESSAGES)).not.toContainEqual(
      expect.stringMatching(/^codingWorkbench\./u),
    );
  });
});
