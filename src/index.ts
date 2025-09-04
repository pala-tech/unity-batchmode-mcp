import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

function readStartupArg(flag: string, envVar?: string): string | undefined {
  if (envVar && process.env[envVar]) return process.env[envVar];
  const idx = process.argv.findIndex((a) => a === flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const pref = `${flag}=`;
  const eq = process.argv.find((a) => a.startsWith(pref));
  if (eq) return eq.slice(pref.length);
  return undefined;
}

// Resolved at call-time so tests can set env before invoking
function resolveUnityEditorPath(): string | undefined {
  return (
    readStartupArg("--unity-editor", "UNITY_EDITOR_PATH") ||
    readStartupArg("--unityEditor", "UNITY_EDITOR_PATH")
  );
}

function resolveUnityProjectPath(): string | undefined {
  return (
    readStartupArg("--project", "UNITY_PROJECT_PATH") ||
    readStartupArg("--projectPath", "UNITY_PROJECT_PATH")
  );
}

const server = new McpServer({
  name: "unity-batchmode-mcp",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});


export type RunUnityTestsParams = {
  filter?: string;
  platform?: "EditMode" | "PlayMode";
};

export async function runUnityTests(params: RunUnityTestsParams): Promise<{ summary: string; exitCode: number }> {
  const unityEditorPath = resolveUnityEditorPath();
  const unityProjectPath = resolveUnityProjectPath();
  if (!unityEditorPath) {
    throw new Error("Missing Unity editor path. Provide via --unity-editor or UNITY_EDITOR_PATH.");
  }
  if (!unityProjectPath) {
    throw new Error("Missing Unity project path. Provide via --project or UNITY_PROJECT_PATH.");
  }

  const platform = params.platform ?? "EditMode";

  const resultsPath = path.resolve(unityProjectPath, "results.xml");
  const logPath = path.resolve(unityProjectPath, "batch.log");

  const args: string[] = [
    "--burst-force-sync-compilation",
    "-burst-force-sync-compilation",
    "-runTests",
    "-batchmode",
    "-projectPath",
    unityProjectPath,
    "-testPlatform",
    platform,
    "-testResults",
    resultsPath,
    "-logFile",
    logPath,
  ];

  if (params.filter && params.filter.trim().length > 0) {
    args.push("-testFilter", params.filter);
  }

  const summaryLines: string[] = [];
  summaryLines.push("Running Unity tests...\n");
  summaryLines.push(`Editor: ${unityEditorPath}`);
  summaryLines.push(`Project: ${unityProjectPath}`);
  summaryLines.push(`Platform: ${platform}`);
  if (params.filter) summaryLines.push(`Filter: ${params.filter}`);

  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const child = spawn(unityEditorPath, args, { stdio: ["ignore", "pipe", "pipe"] });

  let stdoutBuf = "";
  let stderrBuf = "";
  child.stdout.on("data", (d) => {
    stdoutBuf += String(d);
  });
  child.stderr.on("data", (d) => {
    stderrBuf += String(d);
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code: number) => resolve(code ?? 0));
  });

  // Attempt to parse the results file for a compact summary
  let summary = "";
  try {
    const xml = await fs.readFile(resultsPath, "utf8");
    const header = xml.match(/<test-run [^>]+>/);
    if (header) summary += `${header[0]}\n`;

    const totalMatch = xml.match(/<test-run[^>]+total="(\d+)"[^>]+failed="(\d+)"/);
    if (totalMatch) {
      const [, total, failed] = totalMatch;
      summary += `Total: ${total}, Failed: ${failed}\n`;
    }

    const failedCases = xml.match(/<test-case[^>]*result="Failed"[^>]*>/g) || [];
    if (failedCases.length > 0) {
      summary += `Failed cases (${failedCases.length}):\n`;
      for (const line of failedCases) {
        const name = line.match(/name="([^"]*)"/);
        if (name) summary += `  - ${name[1]}\n`;
      }
    }

    // Extract first meaningful failure details if present
    const failures = xml.match(/<failure>[\s\S]*?<\/failure>/g) || [];
    for (const f of failures) {
      const msg = f.match(/<message><!\[CDATA\[([\s\S]*?)\]\]><\/message>/);
      const stack = f.match(/<stack-trace><!\[CDATA\[([\s\S]*?)\]\]><\/stack-trace>/);
      if (msg && msg[1].trim() && msg[1].trim() !== "One or more child tests had errors") {
        summary += `\nFailure message: ${msg[1].trim()}\n`;
        if (stack) summary += `Stack: ${stack[1].trim()}\n`;
        break;
      }
    }
  } catch {
    summary += "No results.xml found or failed to parse.\n";
  }

  summary += `\nLog: ${logPath}`;
  summary += `\nExit code: ${exitCode}`;

  // Append small tail of stdout/stderr for quick insight
  const tail = (text: string, max = 1000) => (text.length > max ? text.slice(-max) : text);
  if (stdoutBuf.trim()) {
    summary += `\n\n[stdout tail]\n${tail(stdoutBuf)}`;
  }
  if (stderrBuf.trim()) {
    summary += `\n\n[stderr tail]\n${tail(stderrBuf)}`;
  }

  // If the process failed, try to grep 'error' lines from the Unity log
  if (exitCode !== 0) {
    try {
      const logText = await fs.readFile(logPath, "utf8");
      const lines = logText.split(/\r?\n/);
      const errorLines = lines.filter((line) => line.toLowerCase().includes("error"));
      if (errorLines.length > 0) {
        const max = 200;
        const tailErrors = errorLines.length > max ? errorLines.slice(-max) : errorLines;
        summary += `\n\n[log grep -i 'error' (${tailErrors.length}/${errorLines.length} matches)]\n`;
        summary += tailErrors.join("\n");
      } else {
        summary += `\n\n[log grep -i 'error']\nNo 'error' lines found.`;
      }
    } catch (e) {
      summary += `\n\n[log grep -i 'error']\nFailed to read log file: ${String(e)}`;
    }
  }

  return { summary, exitCode };
}

server.tool(
  "run_unity_tests",
  "Run Unity Tests",
  {
    filter: z.string().describe("Filter for -testFilter (e.g. fully qualified C# type)" ).optional(),
    platform: z.enum(["EditMode", "PlayMode"]).describe("Test platform").optional().default("EditMode"),
  },
  async ({ filter, platform }) => {
    const { summary, exitCode } = await runUnityTests({ filter, platform });
    return {
      content: [
        {
          type: "text",
          text: summary,
        },
      ],
      isError: exitCode !== 0,
    };
  }
);

export async function startServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
