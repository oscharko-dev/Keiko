// The writer port of the corpus generator (#4208). A writer produces the text around the facts and
// never the facts themselves: the generator inserts every fact sentence verbatim, so a writer cannot
// rewrite, soften or drop a truth. A writer is an object with an id and three asynchronous methods.
//
//   exchanges({ language, role, count, random, isClean })
//       `count` filler exchanges, `[{ user, assistant }]`: generic work talk that states no
//       preference, habit, decision, credential or third party.
//   paragraph({ language, role, hardness, random, isClean })
//       one user paragraph of three to five sentences containing FACT_MARKER exactly once, where the
//       generator will insert the fact. `hardness` is `embedded` (task context around the marker)
//       or `noisy` (small talk before and after it).
//   sentence({ language, role, kind, random, isClean })
//       one sentence of the assistant: `ack` (its neutral reply) or `lead-answer` (its reply to a
//       user turn that introduces a subject, before the turn that says something about it).
//
// `random` is the generator's seeded source; `isClean(text)` answers whether a text may appear in the
// corpus (it states none of the blueprint's facts and holds no value-shaped string). The generator
// re-checks everything a writer returns, so a writer may use `isClean` only to avoid wasted work.

/** Where the generator inserts a fact sentence into a paragraph written by a writer. */
export const FACT_MARKER = "[[FACT]]";
