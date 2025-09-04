import 'dotenv/config';
import { test } from "node:test";
import assert from "node:assert/strict";
import { runUnityTests } from "../src/index.ts";

test(
  "unity-batchmode-mcp (TS): run_unity_tests via stdio",
  { timeout: 700_000 },
  async () => {
    // Call the library function directly instead of spawning via npx
    const { summary, exitCode } = await runUnityTests({});

    // eslint-disable-next-line no-console
    console.log("\n=== run_unity_tests summary ===\n");
    // eslint-disable-next-line no-console
    console.log(summary);
    // eslint-disable-next-line no-console
    console.log("\n=== end summary ===\n");

    assert.equal(exitCode, 0, "Unity exited with non-zero code");
  }
);
