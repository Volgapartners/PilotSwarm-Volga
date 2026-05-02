import { randomBytes } from "node:crypto";
import type { Driver, DriverOptions } from "./types.js";
import type { EvalSample, ObservedResult, ObservedToolCall } from "../types.js";
import { createEvalToolTracker } from "../fixtures/eval-tools.js";
import { extractObservedCalls } from "../observers/tool-tracker.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCtor = new (...args: any[]) => any;

export interface LiveDriverDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createEnv?: (suite: string) => any;
  WorkerCtor?: AnyCtor;
  ClientCtor?: AnyCtor;
  /**
   * Optional plugin directories threaded into the SDK Worker config as
   * `pluginDirs`. Used by the prompt-testing module to inject mutated
   * `.agent.md` variants without modifying the baseline plugin tree.
   */
  pluginDirs?: string[];
}

type CreateEnv = NonNullable<LiveDriverDeps["createEnv"]>;

async function resolveSdkCtors(
  deps: LiveDriverDeps,
): Promise<{ WorkerCtor: AnyCtor; ClientCtor: AnyCtor }> {
  if (deps.WorkerCtor && deps.ClientCtor) {
    return { WorkerCtor: deps.WorkerCtor, ClientCtor: deps.ClientCtor };
  }
  const mod = await import("pilotswarm-sdk");
  return {
    WorkerCtor: (deps.WorkerCtor ?? mod.PilotSwarmWorker) as AnyCtor,
    ClientCtor: (deps.ClientCtor ?? mod.PilotSwarmClient) as AnyCtor,
  };
}

async function resolveCreateEnv(injected?: CreateEnv): Promise<CreateEnv> {
  if (injected) return injected;
  try {
    // @ts-expect-error - SDK test helper is intentionally private and untyped.
    const mod = await import("../../../sdk/test/helpers/local-env.js");
    if (typeof mod.createTestEnv === "function") return mod.createTestEnv as CreateEnv;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `LiveDriver requires the PilotSwarm SDK test helper. Run from inside the monorepo, OR pass deps.createEnv to LiveDriver constructor to provide your own env factory. (${message})`,
    );
  }
  throw new Error(
    "LiveDriver requires the PilotSwarm SDK test helper. Run from inside the monorepo, OR pass deps.createEnv to LiveDriver constructor to provide your own env factory.",
  );
}

/**
 * Experimental monorepo-only live driver.
 *
 * This driver currently depends on the SDK package's private test environment
 * helper via `createEnv`; standalone package consumers should provide their own
 * dependency wiring or wait for a public SDK environment helper.
 */
export class LiveDriver implements Driver {
  private defaultOptions: DriverOptions;
  private deps: LiveDriverDeps;

  constructor(options?: DriverOptions, deps?: LiveDriverDeps) {
    this.defaultOptions = options ?? {};
    this.deps = deps ?? {};
  }

  async run(sample: EvalSample, options?: DriverOptions): Promise<ObservedResult> {
    const opts: DriverOptions = { ...this.defaultOptions, ...(options ?? {}) };

    if (sample.input.context && sample.input.context.length > 0) {
      throw new Error(
        "LiveDriver does not yet support conversation context. Remove context from sample or use FakeDriver.",
      );
    }

    const { tracker, tools } = createEvalToolTracker();
    const toolByName: Record<string, (typeof tools)[keyof typeof tools]> = {
      test_add: tools.add,
      test_multiply: tools.multiply,
      test_weather: tools.weather,
    };

    const requested = sample.tools ?? ["test_add", "test_multiply", "test_weather"];
    const missing = requested.filter((name) => !toolByName[name]);
    if (missing.length > 0) {
      throw new Error(
        `Unknown eval tool(s): ${missing.join(", ")}. Available: ${Object.keys(toolByName).join(", ")}`,
      );
    }
    const selectedTools = requested.map((name) => toolByName[name]);
    const selectedToolNames = requested;

    // Track lifecycle ownership flags so cleanup runs in reverse order regardless of failure point.
    // F20: track *construction* (not just successful start) so cleanup can call
    // worker.stop() / client.stop() defensively if start() throws after partial
    // resource allocation. stop() errors during cleanup are swallowed so the
    // original start() error surfaces to the caller.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let env: any | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let worker: any | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let client: any | undefined;
    let workerConstructed = false;
    let clientConstructed = false;
    let abortHandler: (() => void) | undefined;

    const startedAt = Date.now();
    let sessionId = "";
    let finalResponse = "";
    let cmsState: string | undefined;
    // F25: track whether the primary try-body succeeded. Cleanup errors must
    // surface when primary succeeded, but must NOT mask a primary failure —
    // they are logged to stderr instead.
    let primaryError: unknown = null;

    try {
      const envFactory = await resolveCreateEnv(this.deps.createEnv);
      env = envFactory(`eval_${sample.id}`);

      const { WorkerCtor, ClientCtor } = await resolveSdkCtors(this.deps);

      const workerNodeId = `eval-${randomBytes(4).toString("hex")}`;

      worker = new WorkerCtor({
        store: opts.store ?? env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId,
        disableManagementAgents: true,
        logLevel: process.env.DUROXIDE_LOG_LEVEL || "error",
        ...(this.deps.pluginDirs && this.deps.pluginDirs.length > 0
          ? { pluginDirs: this.deps.pluginDirs }
          : {}),
      });
      workerConstructed = true;
      if (selectedTools.length > 0) worker.registerTools(selectedTools);
      await worker.start();

      client = new ClientCtor({
        store: opts.store ?? env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
      });
      clientConstructed = true;
      await client.start();

      const sessionConfig: {
        systemMessage?: string;
        model?: string;
        toolNames?: string[];
      } = {};
      if (sample.input.systemMessage) sessionConfig.systemMessage = sample.input.systemMessage;
      if (opts.model) sessionConfig.model = opts.model;
      if (selectedToolNames.length > 0) sessionConfig.toolNames = selectedToolNames;

      const session = await client.createSession(sessionConfig);
      sessionId = session.sessionId;
      worker.setSessionConfig(sessionId, { ...sessionConfig, tools: selectedTools });

      // Race the prompt against the AbortSignal so an external abort (e.g. Runner timeout)
      // unblocks us promptly and lets the finally block tear everything down.
      const sendPromise = session.sendAndWait(sample.input.prompt, opts.timeout);
      let abortPromise: Promise<never> | undefined;
      if (opts.signal) {
        if (opts.signal.aborted) {
          throw new Error(`LiveDriver: aborted before send for sample "${sample.id}"`);
        }
        abortPromise = new Promise<never>((_, reject) => {
          abortHandler = () => reject(new Error(`LiveDriver: aborted via signal for sample "${sample.id}"`));
          opts.signal!.addEventListener("abort", abortHandler, { once: true });
        });
      }
      let response: unknown;
      if (abortPromise) {
        let abortedBySignal = false;
        try {
          response = await Promise.race([
            sendPromise,
            abortPromise.catch((err) => {
              abortedBySignal = true;
              throw err;
            }),
          ]);
        } catch (err) {
          if (abortedBySignal) {
            // Promise.race aborts the harness wait and cleanup below stops local
            // resources, but the SDK/provider call may not be cancellable yet.
            // Suppress the losing send promise so it cannot become unhandled.
            sendPromise.catch(() => {});
          }
          throw err;
        }
      } else {
        response = await sendPromise;
      }
      finalResponse = (response as string | undefined) ?? "";

      const info = await session.getInfo().catch(() => null);
      cmsState = info?.state ?? undefined;
    } catch (err) {
      primaryError = err;
    } finally {
      if (abortHandler && opts.signal) {
        try {
          opts.signal.removeEventListener("abort", abortHandler);
        } catch {
          /* ignore */
        }
      }
      if (clientConstructed && client) {
        try {
          await client.stop();
        } catch (err) {
          // F28 (iter17): mirror env.cleanup / worker.stop semantics. When the
          // primary try-body already failed, do NOT mask the primary error
          // with a stop() failure — log it to stderr instead. When the
          // primary body succeeded, surface the stop() failure as the primary
          // error so resource-leak / shutdown bugs don't get swallowed.
          if (primaryError !== null) {
            process.stderr.write(
              `LiveDriver: client.stop() failed during cleanup: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          } else {
            primaryError = err;
          }
        }
      }
      if (workerConstructed && worker) {
        try {
          await worker.stop();
        } catch (err) {
          // F28: mirror env.cleanup semantics. When the primary try-body
          // already failed, do NOT mask the primary error with a stop()
          // failure — log it to stderr instead. When the primary body
          // succeeded, surface the stop() failure as the primary error so
          // resource-leak / shutdown bugs don't get swallowed.
          if (primaryError !== null) {
            process.stderr.write(
              `LiveDriver: worker.stop() failed during cleanup: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          } else {
            primaryError = err;
          }
        }
      }
      if (env) {
        try {
          await env.cleanup();
        } catch (err) {
          // F25: when the primary try-body already errored, do NOT mask the
          // primary error with a cleanup failure — log it to stderr instead.
          // When the primary body succeeded, cleanup errors must surface;
          // promote the cleanup error to primaryError so the throw below
          // rethrows it.
          if (primaryError !== null) {
            console.error(
              `LiveDriver: env.cleanup() failed during cleanup error path: ${err instanceof Error ? err.message : String(err)}`,
            );
          } else {
            primaryError = err;
          }
        }
      }
    }

    if (primaryError !== null) {
      throw primaryError;
    }

    const latencyMs = Date.now() - startedAt;
    const toolCalls: ObservedToolCall[] = extractObservedCalls(tracker);

    const result: ObservedResult = {
      toolCalls,
      finalResponse,
      sessionId,
      latencyMs,
    };
    if (opts.model) result.model = opts.model;
    if (cmsState) result.cmsState = cmsState;
    return result;
  }

  async dispose(): Promise<void> {
    // No persistent state to clean up — each run() creates its own env.
  }
}
