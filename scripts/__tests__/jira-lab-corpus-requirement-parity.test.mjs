// #4179: the requirement inventory reads the same business content from every supported format.
// The lab corpus is rendered as Word, Excel and PowerPoint by the existing writer, parsed by the
// production parsers, and compared with the Markdown control: identifiers, priorities, criteria and
// content digests must be equal, so a format conversion never looks like a requirement change.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildParserOptions,
  docxParser,
  pptxParser,
  xlsxParser,
} from "@oscharko-dev/keiko-local-knowledge";
import { deriveRequirementInventory } from "@oscharko-dev/keiko-quality-intelligence";
import { buildCorpus } from "../testing/jira-chat-lab/requirements/corpus.mjs";
import { writeCorpusDocuments } from "../testing/jira-chat-lab/requirements/corpus-documents.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const PARSERS = { docx: docxParser, xlsx: xlsxParser, pptx: pptxParser };

async function inventoryOf(extension, path) {
  const result = await PARSERS[extension].parseAsync(
    {
      documentId: "doc-1",
      bytes: new Uint8Array(readFileSync(path)),
      extension,
      mediaType: "",
    },
    buildParserOptions(),
  );
  const sections = (result.sections ?? []).map(({ sectionPath, characterStart, characterEnd }) => ({
    sectionPath,
    characterStart,
    characterEnd,
  }));
  return deriveRequirementInventory({
    text: result.normalizedText,
    documentKey: "doc-1",
    sections,
  });
}

const shape = (inventory) =>
  new Map(
    inventory.entries.map((entry) => [
      entry.id,
      {
        title: entry.title,
        priority: entry.priority,
        statement: entry.statement,
        criteria: entry.acceptanceCriteria.map((criterion) => criterion.text),
        digest: entry.digest,
      },
    ]),
  );

describe.each([1, 2])("the lab corpus in every format (version %i)", (version) => {
  async function renderings() {
    const directory = mkdtempSync(join(tmpdir(), "keiko-corpus-parity-"));
    directories.push(directory);
    const paths = writeCorpusDocuments(directory, version);
    const control = deriveRequirementInventory({
      text: buildCorpus(version).markdown,
      documentKey: "doc-1",
    });
    return { paths, control };
  }

  it.each(["docx", "xlsx", "pptx"])(
    "finds every requirement of the %s rendering with the Markdown control's content",
    async (extension) => {
      const { paths, control } = await renderings();
      const path = paths.find((candidate) => candidate.endsWith(`.${extension}`));
      const truth = buildCorpus(version).truth;

      const inventory = await inventoryOf(extension, path);

      const sorted = (ids) => [...ids].sort();
      const wanted = sorted(truth.map((item) => item.id));
      expect(sorted(control.entries.map((entry) => entry.id))).toEqual(wanted);
      expect(sorted(inventory.entries.map((entry) => entry.id))).toEqual(wanted);
      expect(inventory.totalCount).toBe(truth.length);
      const expected = shape(control);
      for (const [id, content] of shape(inventory)) {
        expect(content, id).toEqual(expected.get(id));
      }
    },
  );
});
