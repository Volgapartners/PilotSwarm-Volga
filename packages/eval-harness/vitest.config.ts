import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testModelProvidersPath = path.join(
  __dirname,
  "../sdk/test/fixtures/model-providers.test.json",
);

// Timeout discipline:
//
//   * Default `testTimeout` (60s) applies to all unit/contract tests.
//     Unit tests should be deterministic and fast — a 60s ceiling catches
//     hangs without masking slow regressions.
//
//   * LIVE-gated tests (`*-live.test.ts`) carry their own per-it timeouts
//     derived from (max LiveDriver timeout × planned sequential cells)
//     plus setup/teardown headroom. See `test/*-live.test.ts` for the
//     explicit `it(name, fn, timeoutMs)` form on multi-trial / matrix
//     tests where the worst-case envelope exceeds 600s.
//
//   * `hookTimeout` (60s) bounds beforeAll/afterAll setup/cleanup.
//
// Why we DON'T use a single global testTimeout for LIVE:
// multi-trial and matrix LIVE tests run N sequential LLM calls,
// each capped at 240-300s. A single global timeout cannot bound
// these correctly without being either too tight (single-run tests
// timeout) or too loose (a stuck unit test wastes 10+ minutes).
// The right granularity is per-`it` for LIVE multi-cell tests.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      RUST_LOG: "error",
      PS_MODEL_PROVIDERS_PATH:
        process.env.PS_MODEL_PROVIDERS_PATH || testModelProvidersPath,
    },
  },
});
