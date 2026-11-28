import { mkdtempSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { McpSettingsSnapshot } from "@oscharko-dev/keiko-contracts/runtime/mcp-servers";
import { expect, test } from "@playwright/test";
import { editorM11PairingFragment } from "./support/editor-m11-app-session.js";

// Deliberately retained until the owned MCP process is closed by the app. No productive data.
const directory = realpathSync(mkdtempSync(join(tmpdir(), "keiko-mcp-browser-")));
const counter = join(directory, "effects.jsonl");
const fixture = resolve("packages/keiko-mcp/src/__tests__/browser-server.fixture.ts");

test.afterEach(async ({ page }) => {
  const response = await page.request.get("/api/mcp/servers");
  if (!response.ok()) return; // The cleanup API is unavailable without a live app session.
  const snapshot = (await response.json()) as McpSettingsSnapshot;
  const servers = snapshot.servers.filter(
    (server) =>
      !["browser-fixture", "browser-import-local", "browser-import-remote"].includes(server.name),
  );
  if (servers.length === snapshot.servers.length) return;
  const removed = await page.request.put("/api/mcp/servers", {
    headers: { "X-Keiko-CSRF": "1" },
    data: { expectedRevision: snapshot.revision, servers, secrets: {} },
  });
  expect(removed.ok()).toBe(true);
});

test("central MCP settings preserve tool policy and lifecycle through real stdio @smoke", async ({
  page,
}) => {
  await page.goto(`/${editorM11PairingFragment("mcp-central")}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("region", { name: "Settings — selected", exact: true });
  await settings.getByRole("button", { name: "MCP", exact: true }).click();
  const panel = settings.getByRole("region", { name: "MCP servers", exact: true });
  await panel.getByRole("button", { name: "Add MCP server", exact: true }).click();
  await panel.getByRole("textbox", { name: "Server name" }).fill("browser-fixture");
  await panel.getByRole("combobox", { name: "Connection type", exact: true }).selectOption("local");
  await panel.getByRole("textbox", { name: "Start program", exact: true }).fill(process.execPath);
  await panel
    .getByRole("textbox", { name: "Arguments (optional)", exact: true })
    .fill(`${fixture}\n${counter}`);
  await panel.getByRole("button", { name: "Save and connect", exact: true }).click();
  await expect(panel.getByText("Connected · Tools: 2", { exact: true })).toBeVisible();
  expect(existsSync(counter) ? readFileSync(counter, "utf8") : "").toBe("");
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  await panel.getByText("Tool permissions", { exact: true }).click();
  await panel.getByRole("combobox", { name: "read_probe", exact: true }).selectOption("read");
  await panel.getByRole("button", { name: "Save and connect", exact: true }).click();
  await expect(panel.getByText("Connected · Tools: 2", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  await panel.getByText("Tool permissions", { exact: true }).click();
  await expect(panel.getByRole("combobox", { name: "read_probe", exact: true })).toHaveValue(
    "read",
  );
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await panel.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Enable", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Enable", exact: true }).click();
  await panel.getByRole("button", { name: "Check connection", exact: true }).click();
  await expect(panel.getByText("Connected · Tools: 2", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Remove", exact: true }).click();
  await panel.getByRole("button", { name: "Remove server", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "No servers yet", exact: true })).toBeVisible();
  expect(existsSync(counter) ? readFileSync(counter, "utf8") : "").toBe("");
});

test("German MCP setup checks a JSONC batch and confirms with the keyboard @smoke", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("keiko.locale", "de");
  });
  await page.goto(`/${editorM11PairingFragment("mcp-import")}`);
  await page.getByRole("button", { name: "Einstellungen", exact: true }).click();
  await page.getByRole("button", { name: "MCP", exact: true }).click();
  const panel = page.getByRole("region", { name: "MCP-Server", exact: true });
  const importer = panel.getByRole("button", { name: "JSON importieren", exact: true });
  await expect(importer).toBeEnabled();
  await panel.screenshot({ path: testInfo.outputPath("mcp-setup.png") });
  await importer.press("Enter");
  const json = panel.getByRole("textbox", { name: "JSON-Konfiguration" });
  await expect(json).toBeFocused();
  await expect(json).toHaveAccessibleDescription(/einen oder mehrere Server/u);

  const invalid = '{"mcp":{"browser-import-local":{"type":"local","command":["node"]}}}';
  await json.fill(invalid);
  await panel.getByRole("button", { name: "Server prüfen" }).press("Enter");
  await expect(panel.getByRole("alert")).toContainText("vollständigen Programmpfad");
  await expect(json).toHaveValue(invalid);
  await expect(panel.getByRole("button", { name: "Server hinzufügen", exact: true })).toHaveCount(
    0,
  );

  const file = panel.getByLabel("JSON-Datei auswählen");
  await file.setInputFiles({
    name: "mcp-settings.jsonc",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        mcp: {
          "browser-import-local": { type: "local", command: [process.execPath, fixture, counter] },
          "browser-import-remote": {
            type: "remote",
            url: "https://example.test/mcp",
            enabled: true,
          },
        },
      }),
    ),
  });
  await panel.getByRole("button", { name: "Server prüfen" }).press("Enter");
  const preview = panel.getByRole("region", { name: "Server zum Hinzufügen" });
  await expect(preview.getByRole("heading")).toBeFocused();
  await expect(preview.getByRole("listitem")).toHaveCount(2);
  await panel.screenshot({ path: testInfo.outputPath("mcp-json-preview.png") });
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: "Server hinzufügen", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel.getByText("Server hinzugefügt: 2.", { exact: false })).toBeVisible();
  await expect(importer).toBeFocused();
  const servers = panel.getByRole("list", { name: "Deine Server" });
  await expect(servers.getByRole("button", { name: "Aktivieren" })).toHaveCount(2);
  await expect(servers.getByRole("button", { name: "Verbindung prüfen" }).first()).toBeDisabled();
});
