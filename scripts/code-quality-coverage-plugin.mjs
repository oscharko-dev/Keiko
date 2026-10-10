// A receipt proves actual parser visitation even when a file is empty or has no policy findings.
export default {
  meta: { name: "keiko-coverage" },
  rules: {
    program: {
      meta: { type: "problem", schema: [], messages: { visited: "keiko-program-visited-v1" } },
      create(context) {
        return {
          Program(node) {
            context.report({ node, messageId: "visited" });
          },
        };
      },
    },
  },
};
