/**
 * Internal positive predicates for server-owned workspace read lanes. Package-internal consumers
 * import the implementation directly; this narrow subpath keeps policy helpers out of the public
 * root API while allowing the server package to share the same owning boundary.
 */
export { isAllowedContainedPathParent, isCanonicalAllowedContainedPath } from "./realpath.js";
