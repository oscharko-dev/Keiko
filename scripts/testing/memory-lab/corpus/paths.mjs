// Path guard shared by the lab runner and the corpus tools (#4207, #4208): generated mass and the
// sealed holdout live outside every git work tree, the main checkout of this worktree included, so
// the corpus tools use the one guard the anchor tooling uses (symbolic links followed through the
// deepest existing ancestor; a link into a checkout, even a dangling one, is refused).
export { assertOutsideCheckout } from "../anchor/private-files.mjs";
