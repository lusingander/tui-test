// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import path from "node:path";
import url from "node:url";
import os from "node:os";
import workerpool from "workerpool";
import chalk from "chalk";

import { Suite, getRootSuite } from "../test/suite.js";
import { transformFiles } from "./transform.js";
import { getRetries, getTimeout, loadConfig } from "../config/config.js";
import { runTestWorker } from "./worker.js";
import { Shell, setupZshDotfiles } from "../terminal/shell.js";
import { ListReporter } from "../reporter/list.js";
import { BaseReporter } from "../reporter/base.js";
import { TestCase, TestResult } from "../test/testcase.js";

/* eslint-disable no-var */

declare global {
  var suite: Suite;
  var tests: { [testId: string]: TestCase };
}

type ExecutionOptions = {
  updateSnapshot: boolean;
  testFilter?: string[];
};

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
export const maxWorkers = Math.max(Math.floor(os.cpus().length / 2), 1);
const pool = workerpool.pool(path.join(__dirname, "worker.js"), {
  workerType: "process",
  maxWorkers,
  forkOpts: { stdio: "inherit" },
});

const runSuites = async (
  allSuites: Suite[],
  filteredTestIds: Set<string>,
  reporter: BaseReporter,
  { updateSnapshot }: ExecutionOptions,
) => {
  const tasks: Promise<void>[] = [];
  const suites = [...allSuites];
  while (suites.length != 0) {
    const suite = suites.shift();
    if (!suite) break;
    tasks.push(
      ...suite.tests.map(async (test) => {
        if (!filteredTestIds.has(test.id)) {
          return;
        }
        for (let i = 0; i < Math.max(0, getRetries()) + 1; i++) {
          const testResult: TestResult = {
            status: "pending",
            duration: 0,
            snapshots: [],
          };
          const { error, status, duration, snapshots } = await runTestWorker(
            test,
            suite.source!,
            { timeout: getTimeout(), updateSnapshot },
            pool,
            reporter,
          );
          testResult.status = status;
          testResult.duration = duration;
          testResult.error = error;
          testResult.snapshots = snapshots;
          test.results.push(testResult);
          reporter.endTest(test, testResult);
          if (status == "expected" || status == "skipped") break;
        }
      }),
    );
    suites.push(...suite.suites);
  }
  return Promise.all(tasks);
};

const checkNodeVersion = () => {
  const nodeVersion = process.versions.node;
  const nodeMajorVersion = nodeVersion.split(".")[0];
  if (nodeMajorVersion.trim() != "18") {
    console.warn(
      chalk.yellow(
        `tact works best when using a supported node versions (which ${nodeVersion} is not). See https://aka.ms/tact-supported-node-versions for more details.\n`,
      ),
    );
  }
};

export const run = async (options: ExecutionOptions) => {
  checkNodeVersion();

  await transformFiles();
  const config = await loadConfig();
  const rootSuite = await getRootSuite(config);
  const reporter = new ListReporter();

  const suites = [rootSuite];
  while (suites.length != 0) {
    const importSuite = suites.shift();
    if (importSuite?.type === "file") {
      const transformedSuitePath = path.join(
        process.cwd(),
        ".tact",
        "cache",
        importSuite.title,
      );
      const parsedSuitePath = path.parse(transformedSuitePath);
      const extension = parsedSuitePath.ext.startsWith(".m") ? ".mjs" : ".js";
      const importablePath = `file://${path.join(parsedSuitePath.dir, `${parsedSuitePath.name}${extension}`)}`;
      importSuite.source = importablePath;
      globalThis.suite = importSuite;
      await import(importablePath);
    }
    suites.push(...(importSuite?.suites ?? []));
  }

  let allTests = rootSuite.allTests();

  // refine with only annotations
  if (allTests.find((test) => test.annotations.includes("only"))) {
    allTests = allTests.filter((test) => test.annotations.includes("only"));
  }

  // refine with test filters
  if (options.testFilter != null && options.testFilter.length > 0) {
    try {
      const patterns = options.testFilter.map(
        (filter) => new RegExp(filter.replaceAll("\\", "\\\\")),
      );
      allTests = allTests.filter((test) => {
        const testPath = path.resolve(test.filePath() ?? "");
        return patterns.find((pattern) => pattern.test(testPath)) != null;
      });
    } catch {
      console.error(
        "Error: invalid test filter supplied. Test filters must be valid regular expressions",
      );
      process.exit(1);
    }
  }

  const shells = Array.from(
    new Set(
      allTests
        .map((t) => t.suite.options?.shell)
        .filter((s): s is Shell => s != null),
    ),
  );
  if (shells.includes(Shell.Zsh)) {
    await setupZshDotfiles();
  }
  await reporter.start(allTests.length, shells);

  if (config.globalTimeout > 0) {
    setTimeout(() => {
      console.error(
        `Error: global timeout (${config.globalTimeout} ms) exceeded`,
      );
      process.exit(1);
    }, config.globalTimeout);
  }

  await runSuites(
    rootSuite.suites,
    new Set(allTests.map((test) => test.id)),
    reporter,
    options,
  );
  try {
    await pool.terminate(true);
  } catch {
    /* empty */
  }
  const failures = reporter.end(rootSuite);
  process.exit(failures);
};
