import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const RUN_TESTS = join(REPO_ROOT, "scripts", "run-tests.sh");
const STUB_BIN = join(import.meta.dirname, "fixtures", "run-tests-bin");
const CONTRACT_ENV = join(import.meta.dirname, "fixtures", "run-tests.env");
const CONTRACT_LOG = join(import.meta.dirname, ".run-tests-contract.log");

describe("scripts/run-tests.sh", () => {
  it("reaches eval-harness tests during a full set -u run", async () => {
    await rm(CONTRACT_LOG, { force: true });
    try {
      const shell = [
        "contents=$(sed \"s|^ENV_FILE=\\\".env\\\"$|ENV_FILE=\\\"$RUN_TESTS_CONTRACT_ENV\\\"|\" \"$0\")",
        "builtin source /dev/stdin <<< \"$contents\"",
      ].join("\n");
      await execFileAsync("/bin/bash", ["-c", shell, RUN_TESTS], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PATH: `${STUB_BIN}:${process.env.PATH ?? ""}`,
          RUN_TESTS_CONTRACT_ENV: CONTRACT_ENV,
          RUN_TESTS_CONTRACT_LOG: CONTRACT_LOG,
        },
      });

      const log = await readFile(CONTRACT_LOG, "utf8");
      expect(log).toContain(`npm|${REPO_ROOT}|run --silent test --workspace=pilotswarm-eval-harness`);
      expect(log).toContain(`npx|${join(REPO_ROOT, "packages", "sdk")}|vitest --run`);
    } finally {
      await rm(CONTRACT_LOG, { force: true });
    }
  });
});
