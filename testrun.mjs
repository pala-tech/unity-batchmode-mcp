#!/usr/bin/env zx

import { $, argv, fs } from "zx";

const PROJECT_PATH = process.cwd();
const TEST_RESULTS_FILE_DEFAULT = `${PROJECT_PATH}/results.xml`;
const LOG_FILE_DEFAULT = `${PROJECT_PATH}/batch.log`;

const UNITY_INSTALLS =
	process.env.UNITY_INSTALLS || "/Volumes/Archive2TB/UNITY/Installs";

async function readUnityVersion() {
	const content = await fs.readFile(
		"ProjectSettings/ProjectVersion.txt",
		"utf8"
	);
	const line =
		content.split(/\r?\n/).find((l) => l.startsWith("m_EditorVersion: ")) || "";
	return line.replace("m_EditorVersion: ", "").replace(/\s*$/, "");
}

function usage() {
	console.log(
		`Usage: ${process.argv[1]} [-n|--name <testFilter>] [-c|--category <testCategory>] [-p|--platform <EditMode|PlayMode>] [-r|--results <file>] [-l|--log <file>]`
	);
	console.log("Notes:");
	console.log(
		"  - Names and categories accept semicolon-separated lists or regex."
	);
	console.log(
		"  - You can also set TEST_FILTER, TEST_CATEGORY, TEST_PLATFORM, VERBOSE env vars."
	);
}

function coalesceFlag(...candidates) {
	for (const key of candidates) {
		if (key in argv && argv[key] != null && argv[key] !== "")
			return String(argv[key]);
	}
	return undefined;
}

async function main() {
	if (argv.h || argv.help) {
		usage();
		return;
	}

	const UNITY_VERSION = await readUnityVersion();
	const UNITY_BINARY = `${UNITY_INSTALLS}/${UNITY_VERSION}/Unity.app/Contents/MacOS/Unity`;

	const TEST_PLATFORM =
		coalesceFlag("p", "platform") || process.env.TEST_PLATFORM || "EditMode";
	const TEST_FILTER =
		coalesceFlag("n", "name", "filter", "f") || process.env.TEST_FILTER || "";
	const TEST_CATEGORY =
		coalesceFlag("c", "category") || process.env.TEST_CATEGORY || "";
	const RESULTS_PATH =
		coalesceFlag("r", "results") ||
		process.env.TEST_RESULTS_FILE ||
		TEST_RESULTS_FILE_DEFAULT;
	const LOG_PATH =
		coalesceFlag("l", "log") || process.env.LOG_FILE || LOG_FILE_DEFAULT;

	const extra = [];
	if (TEST_FILTER) {
		extra.push("-testFilter", TEST_FILTER);
	}
	if (TEST_CATEGORY) {
		extra.push("-testCategory", TEST_CATEGORY);
	}

	console.log("This script runs the tests for the Voxel Worlds project.");

	try {
		await $`${UNITY_BINARY} --burst-force-sync-compilation -burst-force-sync-compilation -runTests -batchmode -projectPath ${PROJECT_PATH} -testPlatform ${TEST_PLATFORM} -testResults ${RESULTS_PATH} -logFile ${LOG_PATH} ${extra}`;
	} catch {
		// Intentionally ignore non-zero exit; we will parse results/logs below
	}

	console.log("==== Test Summary ====");
	try {
		const xml = await fs.readFile(RESULTS_PATH, "utf8");
		const m = xml.match(/<test-run [^>]+>/g);
		if (m) console.log(m);
	} catch {}

	console.log("==== Test Failures (if any) ====");

	// First, let's get a summary of failed tests
	try {
		const xml = await fs.readFile(RESULTS_PATH, "utf8");

		// Count total tests and failures
		const totalMatch = xml.match(
			/<test-run[^>]+total="(\d+)"[^>]+failed="(\d+)"/
		);
		if (totalMatch) {
			const [, total, failed] = totalMatch;
			console.log(`Total tests: ${total}, Failed: ${failed}`);
		}

		// Extract failed test case names and details
		const failedTestCases = xml.match(/<test-case[^>]*result="Failed"[^>]*>/g);
		if (failedTestCases && failedTestCases.length > 0) {
			console.log("\nFailed test cases:");
			failedTestCases.forEach((testCase, index) => {
				const nameMatch = testCase.match(/name="([^"]*)"/);
				const idMatch = testCase.match(/id="([^"]*)"/);
				if (nameMatch) {
					console.log(
						`  ${index + 1}. ${nameMatch[1]}${
							idMatch ? ` (ID: ${idMatch[1]})` : ""
						}`
					);
				}
			});
		}

		// Extract failure messages and stack traces
		const failures = xml.match(/<failure>[\s\S]*?<\/failure>/g);
		if (failures && failures.length > 0) {
			console.log("\nFailure details:");
			let meaningfulFailureCount = 0;
			failures.forEach((failure, index) => {
				const messageMatch = failure.match(
					/<message><!\[CDATA\[([\s\S]*?)\]\]><\/message>/
				);
				const stackMatch = failure.match(
					/<stack-trace><!\[CDATA\[([\s\S]*?)\]\]><\/stack-trace>/
				);

				// Skip generic "One or more child tests had errors" messages
				if (
					messageMatch &&
					messageMatch[1].trim() === "One or more child tests had errors"
				) {
					return;
				}

				// Only show failures with meaningful content
				if (
					messageMatch &&
					messageMatch[1].trim() &&
					(messageMatch[1].trim() !== "One or more child tests had errors" ||
						stackMatch)
				) {
					meaningfulFailureCount++;
					console.log(`\n  Failure ${meaningfulFailureCount}:`);
					if (messageMatch) {
						console.log(`    Message: ${messageMatch[1].trim()}`);
					}
					if (stackMatch) {
						console.log(`    Stack: ${stackMatch[1].trim()}`);
					}
				}
			});

			if (meaningfulFailureCount === 0) {
				console.log(
					"  No meaningful failure details found (only generic suite failures)"
				);
			}
		}
	} catch (error) {
		console.log(`Error reading test results: ${error.message}`);
	}

	// Also try the original grep approach as fallback
	console.log("\n==== Raw failure grep results ====");
	await $`grep -nE 'result="Failed"' ${RESULTS_PATH}`.nothrow();
	await $`grep -nE '<failure>' -A10 ${RESULTS_PATH}`.nothrow();

	console.log("==== Log Highlights ====");
	await $`grep -iE 'Aborting|Scripts have compiler errors|error|failed|Test run completed|Saving results to|DEBUG|VERBOSE|INFO|ERROR|WARN' ${LOG_PATH}`.nothrow();

	console.log("==== Test Logs ====");
	const logs = await fs.readFile("./test-logs.json", "utf8");
	console.log(logs);
}

await main();
