import { startServer } from "./index.js";

startServer().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
