import process from "node:process";
import workerpool from "workerpool";

import { Suite } from "../test/suite.js";
import { spawn } from "../terminal/term.js";
import { defaultShell } from "../terminal/shell.js";
import { TestCase } from "../test/testcase.js";

type WorkerResult = {
  error?: string;
  passed: boolean;
  duration: number;
};

const importSet = new Set<string>();

const runTest = async (testId: string, testSuite: Suite, importPath: string) => {
  process.setSourceMapsEnabled(true);
  globalThis.suite = testSuite;
  globalThis.tests = globalThis.tests ?? {};
  if (!importSet.has(importPath)) {
    await import(importPath);
    importSet.add(importPath);
  }
  const test = globalThis.tests[testId];
  const { shell, rows, columns } = test.suite.options ?? {};
  const terminal = await spawn({ shell: shell ?? defaultShell, rows: rows ?? 30, cols: columns ?? 80 });
  await Promise.resolve(test.testFunction({ terminal }));
};

export function runTestWorker(test: TestCase, importPath: string, timeout: number, pool: workerpool.Pool): Promise<WorkerResult> {
  return new Promise(async (resolve, reject) => {
    let startTime = Date.now();
    try {
      const poolPromise = pool.exec("testWorker", [test.id, getMockSuite(test), importPath], {
        on: (payload) => {
          if (payload.errorMessage) {
            resolve({
              passed: false,
              error: payload.errorMessage,
              duration: payload.duration,
            });
          } else if (payload.startTime) {
            startTime = payload.startTime;
          }
        },
      });
      if (timeout > 0) {
        poolPromise.timeout(timeout);
      }
      await poolPromise;
      resolve({
        passed: true,
        duration: Date.now() - startTime,
      });
    } catch (e) {
      const duration = startTime != null ? Date.now() - startTime : -1;
      if (typeof e === "string") {
        resolve({
          passed: false,
          error: e,
          duration,
        });
      } else if (e instanceof workerpool.Promise.TimeoutError) {
        resolve({
          passed: false,
          error: `Error: worker was terminated as the timeout (${timeout} ms) as exceeded`,
          duration,
        });
      } else if (e instanceof Error) {
        resolve({
          passed: false,
          error: e.stack ?? e.message,
          duration,
        });
      }
    }
  });
}

const getMockSuite = (test: TestCase): Suite => {
  let testSuite: Suite | undefined = test.suite;
  let newSuites: Suite[] = [];
  while (testSuite != null) {
    if (testSuite.type !== "describe") {
      newSuites.push(new Suite(testSuite.title, testSuite.type, testSuite.options));
    }
    testSuite = testSuite.parentSuite;
  }
  for (let i = 0; i < newSuites.length - 1; i++) {
    newSuites[i].parentSuite = newSuites[i + 1];
  }
  return newSuites[0];
};

const testWorker = async (testId: string, testSuite: Suite, importPath: string): Promise<void> => {
  const startTime = Date.now();
  workerpool.workerEmit({
    startTime,
  });
  try {
    await runTest(testId, testSuite, importPath);
  } catch (e) {
    let errorMessage;
    if (typeof e == "string") {
      errorMessage = e;
    } else if (e instanceof Error) {
      errorMessage = e.stack ?? e.message;
    }
    if (errorMessage) {
      const duration = Date.now() - startTime;
      workerpool.workerEmit({
        errorMessage,
        duration,
      });
    }
  }
};

if (!workerpool.isMainThread) {
  workerpool.worker({
    testWorker: testWorker,
  });
}
