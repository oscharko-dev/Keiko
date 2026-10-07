// Readers for the reproduction guide of the Coding Workbench live lab
// (docs/qa/coding-workbench-lab/README.md): its task-suite table, its exact task texts and its
// baseline table, as data. The guide and the task catalog must say the same, so the tests compare
// what these functions read with scripts/testing/coding-workbench-lab/tasks.json instead of
// restating either side.

/** The part of the guide from `heading` to the next second-level heading. */
function sectionOf(markdown, heading) {
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`the guide has no "${heading}" heading`);
  return markdown.slice(start).split(/\n## /u)[0];
}

function cellsOf(line) {
  return line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/**
 * The `#### <id>: <title>` blocks of the "Exact texts" section: mode, baseline, text status and
 * the first text block, whatever explanation sits between the facts line and the block.
 */
export function parseExactTexts(markdown) {
  const section = sectionOf(markdown, "### Exact texts");
  const texts = new Map();
  for (const block of section.split(/\n(?=#### )/u)) {
    const heading = /^#### (\S+): (.+)$/mu.exec(block);
    const facts = /^Mode: (.+)\. Baseline: `(.+)`\. Text: (\w+)\.$/mu.exec(block);
    const text = /```text\n([\s\S]*?)\n```/u.exec(block);
    if (heading === null || facts === null || text === null) continue;
    const [, id, title] = heading;
    const [, mode, baseline, textStatus] = facts;
    texts.set(id, { title, mode, baseline, textStatus, text: text[1] });
  }
  return texts;
}

/** The rows of the task-suite table: C1 and every `T<number>` task, with an optional letter suffix. */
export function parseTaskTable(markdown) {
  const rows = new Map();
  for (const line of markdown.split("\n")) {
    if (!/^\| (?:C1|T\d+[a-z]*)\s+\|/u.test(line)) continue;
    const [id, title, mode, baseline, textStatus, expected] = cellsOf(line);
    rows.set(id, { title, mode, baseline: baseline.replaceAll("`", ""), textStatus, expected });
  }
  return rows;
}

/** The baseline table: the patch (if any) that turns the fixture into each baseline. */
export function parseBaselines(markdown) {
  const table = sectionOf(markdown, "## Baselines and the planted defects");
  return new Map(
    table
      .split("\n")
      .filter((line) => line.startsWith("| `"))
      .map((line) => {
        const [name, how] = cellsOf(line);
        return [name.replaceAll("`", ""), /patches\/([\w.-]+\.patch)/u.exec(how)?.[1]];
      }),
  );
}
