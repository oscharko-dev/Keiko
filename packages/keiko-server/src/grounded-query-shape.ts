// Compatibility seam for server-local callers. Query-shape ownership lives in the workflows
// planner so ring composition and lexical narrowing cannot drift apart.
export { directDefinitionSymbol } from "@oscharko-dev/keiko-workflows";
