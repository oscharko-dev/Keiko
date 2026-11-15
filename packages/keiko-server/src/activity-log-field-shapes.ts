/**
 * The shape most Activity Log fields share: an optional, body-free count. One declaration for every
 * operation registered in the server, so a count field is one line and cannot drift between logs.
 */
export const OPTIONAL_COUNT_FIELD = {
  type: "integer",
  dataClass: "count",
  required: false,
} as const;
