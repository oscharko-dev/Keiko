// Fileless code blocks use bounded, deterministic syntax cues. Explicit language choices win.
const LANGUAGE_CUES: readonly (readonly [string, readonly RegExp[]])[] = [
  [
    "typescript",
    [
      /\binterface[ \t]{1,16}\w/u,
      /\b(?:import|export)[ \t]{1,16}type\b/u,
      /\breadonly[ \t]{1,16}\w{1,128}[ \t]{0,16}:/u,
      /:[ \t]{0,16}(?:string|number|boolean)\b/u,
    ],
  ],
  ["java", [/\bpublic[ \t]{1,16}(?:class|interface)\b/u, /\bimport[ \t]{1,16}java\./u]],
  ["go", [/^package[ \t]{1,16}\w/u, /^func[ \t]{1,16}\w{1,128}\(/u]],
  ["rust", [/\bfn[ \t]{1,16}\w{1,128}\(/u, /\blet[ \t]{1,16}mut\b/u]],
  ["python", [/^(?:async )?def[ \t]{1,16}\w{1,128}\(/u, /^from[ \t]{1,16}\w{1,128} import /u]],
  ["shell", [/^#![^\n]{0,128}\b(?:bash|sh)\b/u, /^(?:echo|printf)\b/u, /^export \w{1,128}=/u]],
  ["sql", [/^SELECT\b/iu, /^CREATE TABLE\b/iu, /^INSERT INTO\b/iu]],
  ["html", [/<!doctype html/iu, /<\/(?:div|span|body|html|p|section)>/iu]],
  ["css", [/^[.#][\w-]{1,128}[ \t]{0,16}\{/u]],
  ["json", [/^[{[][ \t]{0,16}"/u]],
  [
    "javascript",
    [
      /\b(?:const|let|var)[ \t]{1,16}\w{1,128}[ \t]{0,16}=/u,
      /\bfunction[ \t]{1,16}\w{1,128}[ \t]{0,16}\(/u,
      /=>/u,
      /^import .{1,128} from /u,
    ],
  ],
  ["yaml", [/^[\w-]{1,128}:[ \t]{0,16}$/u]],
  ["markdown", [/^#{1,6} \S/u, /^[-*] \[[ x]\]/u]],
];

export function detectComposerCodeLanguage(source: string): string | undefined {
  const sample = source.slice(0, 4_096);
  const lines = sample.split("\n").map((line) => line.trim());
  return LANGUAGE_CUES.find(([, cues]) =>
    cues.some((cue) => lines.some((line) => cue.test(line))),
  )?.[0];
}
