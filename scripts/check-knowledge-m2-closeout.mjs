import { runKnowledgeM2CloseoutGate } from "./lib/knowledge-m2-closeout.mjs";

const result = await runKnowledgeM2CloseoutGate({
  fail: (message) => {
    console.error(`knowledge-m2-closeout failed: ${message}`);
  },
});

if (!result.ok) process.exitCode = 1;
