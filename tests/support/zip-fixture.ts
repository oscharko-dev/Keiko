import { Buffer } from "node:buffer";
import { zipTextEntries } from "../../packages/keiko-local-knowledge/src/parsers/parser-test-fixtures.js";

export { zipTextEntries };

/** A one-paragraph Word document whose body is `text`. */
export function docxOf(text: string): Uint8Array {
  return zipTextEntries([
    {
      name: "[Content_Types].xml",
      content:
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: "word/document.xml",
      content: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    },
  ]);
}

/** A one-page PDF with a text layer holding `text`. */
export function pdfOf(text: string, fontSize = 8): Uint8Array {
  const content = `BT /F1 ${String(fontSize)} Tf 10 72 Td (${text}) Tj ET`;
  return Buffer.from(
    [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
      `4 0 obj << /Length ${String(content.length)} >> stream`,
      content,
      "endstream endobj",
      "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
      "xref",
      "0 6",
      "0000000000 65535 f ",
      "0000000010 00000 n ",
      "0000000063 00000 n ",
      "0000000122 00000 n ",
      "0000000248 00000 n ",
      "0000000342 00000 n ",
      "trailer << /Root 1 0 R /Size 6 >>",
      "startxref",
      "412",
      "%%EOF",
    ].join("\n"),
    "latin1",
  );
}
