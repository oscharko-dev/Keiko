import { expect, test, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RUNTIME_ROOT = "/__pdfjs-legacy-runtime";
const PDF_MAIN = readFileSync(resolve("node_modules/pdfjs-dist/legacy/build/pdf.mjs"), "utf8");
const PDF_WORKER = readFileSync(
  resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
  "utf8",
);

const REMOVE_NEW_RUNTIME_APIS = String.raw`
{
  const remove = (owner, key) => {
    if (owner == null) return;
    Reflect.deleteProperty(owner, key);
    if (typeof owner[key] !== "undefined") {
      Object.defineProperty(owner, key, { configurable: true, value: undefined, writable: true });
    }
  };
  const targets = [
    [globalThis.Promise, "try"], [globalThis.Promise, "withResolvers"],
    [globalThis.URL, "parse"],
    [globalThis.Map?.prototype, "getOrInsert"],
    [globalThis.Map?.prototype, "getOrInsertComputed"],
    [globalThis.WeakMap?.prototype, "getOrInsert"],
    [globalThis.WeakMap?.prototype, "getOrInsertComputed"],
    [globalThis.Response?.prototype, "bytes"], [globalThis.Blob?.prototype, "bytes"],
    [globalThis.Uint8Array, "fromBase64"], [globalThis.Uint8Array, "fromHex"],
    [globalThis.Uint8Array?.prototype, "setFromBase64"],
    [globalThis.Uint8Array?.prototype, "setFromHex"],
    [globalThis.Uint8Array?.prototype, "toBase64"],
    [globalThis.Uint8Array?.prototype, "toHex"],
    [globalThis.Math, "sumPrecise"],
  ];
  for (const [owner, key] of targets) remove(owner, key);
  if (targets.some(([owner, key]) => owner != null && typeof owner[key] !== "undefined")) {
    throw new Error("browser host API removal was incomplete");
  }
}
`;

const ASSERT_LEGACY_APIS = String.raw`
{
  const restored = [
    [globalThis.Promise, "try"], [globalThis.Promise, "withResolvers"],
    [globalThis.URL, "parse"],
    [globalThis.Map?.prototype, "getOrInsertComputed"],
    [globalThis.WeakMap?.prototype, "getOrInsertComputed"],
    [globalThis.Response?.prototype, "bytes"], [globalThis.Blob?.prototype, "bytes"],
    [globalThis.Uint8Array, "fromBase64"],
    [globalThis.Uint8Array?.prototype, "setFromBase64"],
    [globalThis.Uint8Array?.prototype, "toBase64"],
    [globalThis.Math, "sumPrecise"],
  ];
  const missing = restored.filter(([owner, key]) => typeof owner?.[key] !== "function");
  if (missing.length > 0) {
    throw new Error("PDF.js legacy runtime did not restore: " + missing.map(([, key]) => key).join(","));
  }
}
`;

function tinyPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "latin1");
  const rows = offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `);
  body +=
    `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${rows.join("\n")}\n` +
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\n` +
    `startxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function browserDocument(): string {
  return `<!doctype html><meta charset="utf-8"><output id="result">loading</output>
    <script type="module">
      ${REMOVE_NEW_RUNTIME_APIS}
      try {
        const pdfjs = await import("${RUNTIME_ROOT}/pdf.mjs");
        ${ASSERT_LEGACY_APIS}
        pdfjs.GlobalWorkerOptions.workerSrc = "${RUNTIME_ROOT}/pdf.worker.mjs";
        const task = pdfjs.getDocument({ url: "${RUNTIME_ROOT}/tiny.pdf" });
        const documentProxy = await task.promise;
        const page = await documentProxy.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        document.querySelector("#result").textContent =
          "parsed:" + documentProxy.numPages + ":" + viewport.width + "x" + viewport.height;
        await task.destroy();
      } catch (error) {
        document.querySelector("#result").textContent = "failed:" + String(error?.stack ?? error);
      }
    </script>`;
}

async function installRuntimeRoutes(
  page: Page,
  counts: { pdf: number; worker: number },
): Promise<void> {
  await page.route(`**${RUNTIME_ROOT}/**`, async (route: Route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/pdf.mjs")) {
      await route.fulfill({ body: PDF_MAIN, contentType: "text/javascript" });
    } else if (pathname.endsWith("/pdf.worker.mjs")) {
      counts.worker += 1;
      await route.fulfill({
        body: `${REMOVE_NEW_RUNTIME_APIS}\n${PDF_WORKER}\n${ASSERT_LEGACY_APIS}`,
        contentType: "text/javascript",
      });
    } else if (pathname.endsWith("/tiny.pdf")) {
      counts.pdf += 1;
      await route.fulfill({ body: tinyPdf(), contentType: "application/pdf" });
    } else {
      await route.fulfill({ body: browserDocument(), contentType: "text/html" });
    }
  });
}

test("@smoke PDF.js legacy main and worker parse a real PDF without new host APIs", async ({
  page,
}) => {
  const counts = { pdf: 0, worker: 0 };
  await installRuntimeRoutes(page, counts);
  await page.goto(`${RUNTIME_ROOT}/index.html`);

  await expect(page.locator("#result")).toHaveText("parsed:1:72x72");
  expect(counts.pdf).toBe(1);
  expect(counts.worker).toBe(1);
});
