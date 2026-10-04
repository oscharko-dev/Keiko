import { describe, expect, it } from "vitest";

import { translateEditorAgent } from "./editor-agent-i18n";

describe("editor agent translations", () => {
  it("keeps manual conflict and rename messages with substituted counts", (): void => {
    expect(translateEditorAgent("en", "conflict.title.invalidEdits")).toBe("Invalid edits");
    expect(translateEditorAgent("de", "conflict.title.invalidEdits")).toBe("Ungültige Änderungen");
    expect(translateEditorAgent("de", "conflict.title.versionMismatch")).toBe(
      "Abweichende Dateiversion",
    );
    expect(translateEditorAgent("en", "editor.rename.incompleteUnreadable", { count: 2 })).toBe(
      "2 file(s) could not be read and carry no changes.",
    );
    expect(translateEditorAgent("de", "editor.rename.incompleteUnreadable", { count: 2 })).toBe(
      "2 Datei(en) konnten nicht gelesen werden und enthalten keine Änderungen.",
    );
  });
  it("localizes chat creation failures in English and German", (): void => {
    expect(translateEditorAgent("en", "chat.creation.openFailed")).toBe("Could not open chat.");
    expect(translateEditorAgent("de", "chat.creation.openFailed")).toBe(
      "Der Chat konnte nicht geöffnet werden.",
    );
    expect(translateEditorAgent("en", "chat.creation.titleSaveFailed")).toBe(
      "The chat opened, but its title could not be saved.",
    );
    expect(translateEditorAgent("de", "chat.creation.titleSaveFailed")).toBe(
      "Der Chat wurde geöffnet, aber sein Titel konnte nicht gespeichert werden.",
    );
    expect(translateEditorAgent("de", "chat.restoration.opening")).toBe("Der Chat wird geöffnet…");
    expect(translateEditorAgent("de", "chat.restoration.notFoundTitle")).toBe(
      "Chat nicht gefunden",
    );
    expect(translateEditorAgent("de", "chat.restoration.notFoundBody")).toBe(
      "Diese Unterhaltung wurde gelöscht oder ist nicht mehr verfügbar.",
    );
    expect(translateEditorAgent("en", "chat.restoration.opening")).toBe("Opening chat...");
    expect(translateEditorAgent("en", "chat.restoration.notFoundTitle")).toBe("Chat not found");
    expect(translateEditorAgent("en", "chat.restoration.notFoundBody")).toBe(
      "This conversation was deleted or is no longer available.",
    );
  });
});
