// Attack class: FORBIDDEN PACKAGE DEPENDENCY (external npm package, not a workspace sibling).
// ADR-0175 D1: the pure catalog compiler depends only on keiko-contracts and keiko-security.
// The existing sibling fixture in this directory (bad-import.ts) proves a Node core-module
// import is rejected; this one proves a THIRD-PARTY provider SDK import is rejected the same
// way, distinctly, by the same AST import-policy rule
// (scripts/check-import-policy.mjs "adr-0175-tool-catalog-pure-imports").
import OpenAI from "openai";
export const violation = OpenAI;
