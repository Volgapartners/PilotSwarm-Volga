# Judge Clients

The eval-harness ships two production-ready `JudgeClient` implementations.
Pick one based on the credentials available in the test environment.

## At a glance

| Client                  | Credentials needed                | Providers reached                                  |
| ----------------------- | --------------------------------- | -------------------------------------------------- |
| `OpenAIJudgeClient`     | `OPENAI_API_KEY` (or compatible)  | OpenAI public API or any OpenAI-compatible base URL |
| `PilotSwarmJudgeClient` | A configured `ModelProviderRegistry` (typically `GITHUB_TOKEN` + `.model_providers.json`) | Every provider PilotSwarm itself supports — GitHub Copilot, OpenAI, Anthropic, Azure OpenAI |

Both implement the same `JudgeClient` interface (`judge`, `cacheIdentity`),
so any code consuming a judge — `LLMJudgeGrader`, the live test gates, the
shared judge cache — works unchanged whichever you pick.

## When to use each

### Use `OpenAIJudgeClient` when

- You have a direct `OPENAI_API_KEY` (or an OpenAI-compatible gateway) and
  want the lowest-latency one-call-per-judge path.
- You need fine-grained control over OpenAI-specific knobs (`response_format`,
  `temperature`, `Retry-After` honoring, separate `cachedInput` rates).
- You are running CI in an environment where the `@github/copilot-sdk` runtime
  and a Copilot session are unnecessary overhead.

### Use `PilotSwarmJudgeClient` when

- The test environment has `GITHUB_TOKEN` configured for PilotSwarm but no
  separate `OPENAI_API_KEY`. This is the default for the PilotSwarm dev
  workflow — the judge inherits the same provider matrix the runtime already
  has authenticated.
- You want the judge to talk to the same provider/model that production
  PilotSwarm sessions use, so judge calibration drift cannot diverge from
  worker behavior.
- You need to run the judge against Anthropic / Azure / a corporate LiteLLM
  gateway that PilotSwarm already routes through. No new client code is
  required — adding a provider to `.model_providers.json` automatically makes
  it available as a judge target.

## Selection in tests

`test/helpers/judge-client-helper.ts` exposes `makeLiveJudgeClient()` which
returns the right client (or `null` if neither set of credentials is
configured, OR if the registry-routed judge has no cost rates available).
Live-judge tests (`safety-live.test.ts`, `llm-judge-live.test.ts`) call this
helper:

```ts
const sel = makeLiveJudgeClient();
// FAIL LOUD if neither credential set is configured or cost rates are
// missing — silently skipping under LIVE_JUDGE=1 would mask a config bug.
expect(sel, "no judge credentials or cost rates available").toBeTruthy();
const client = sel!.client;
```

Selection precedence:

1. `OPENAI_API_KEY` set → `OpenAIJudgeClient` (kind: `"openai"`). Strict
   precedence: even if `GITHUB_TOKEN` is also set, `OpenAIJudgeClient` wins.
   No fallback after construction — if `OPENAI_API_KEY` is set but invalid,
   the test will fail loudly with the OpenAI API error rather than fall back
   to the registry-routed path.
2. `GITHUB_TOKEN` set AND `PS_MODEL_PROVIDERS_PATH` (or
   `MODEL_PROVIDERS_PATH`) resolves to a real file → `PilotSwarmJudgeClient`
   (kind: `"pilotswarm"`).
3. Neither → `null`.

The test harness still gates execution on `LIVE=1 LIVE_JUDGE=1`. The helper
only decides *which* client to construct, never *whether* judge tests run.

### Cost rates contract for the registry-routed path

`LLMJudgeGrader` budgets fail closed when cost is unknown. The
`PilotSwarmJudgeClient` therefore must carry `costRates` in any budgeted
test. The helper resolves cost rates in this order:

1. **Env override** (highest priority):
   - To opt in, set `LIVE_JUDGE_INPUT_USD_PER_M` AND
     `LIVE_JUDGE_OUTPUT_USD_PER_M`. Both must be non-negative finite numbers.
   - `LIVE_JUDGE_CACHED_INPUT_USD_PER_M` is optional; when set it is also
     validated as a non-negative finite number.
   - **Partial env override fails LOUD.** If any of the three vars is set
     but `INPUT` and `OUTPUT` are not BOTH present, `makeLiveJudgeClient()`
     throws an `Error` with a clear message. This prevents an operator's
     override from being silently ignored and falling back to baked-in
     rates — a bug that would undermine budget enforcement transparency.
   - **Invalid env values fail LOUD.** NaN, negative, infinite values
     throw — they are not silently treated as "unset" or clamped.
2. **Per-model defaults** for known fallback models (e.g.
   `github-copilot:gpt-4.1`, `gpt-4.1`, `gpt-4o`, `gpt-4o-mini`). Picked up
   automatically when the chosen model has a baked-in entry AND no env
   override is active.
3. **Fail loud** otherwise: if the chosen model has no defaults and no env
   override, `makeLiveJudgeClient()` returns `null` AND writes a stderr
   explainer pointing at the env vars. The test then fails the
   `expect(sel).toBeTruthy()` assertion with a clear message.

This avoids the silent-infraError trap — a budgeted live test with the
registry-routed judge but no cost rates would otherwise return
`infraError` for every grade and the test would still claim "judge
unavailable" semantics.

## Behavior contract — both clients

Both clients honor the same hard rules:

- **Fail closed on parse errors.** If the model returns text that is not
  valid JSON conforming to `JudgeResultSchema`, the client throws. It will
  *never* return a synthetic pass.
- **Retry only transient errors.** Network errors, 5xx, rate-limits, and
  upstream session errors are retried with exponential backoff. Validation
  failures are not retried — bad JSON is sticky.
- **Stop the underlying client/socket in `finally`.** Even on timeout or
  abort, no underlying `CopilotClient` or fetch handle is leaked.
- **Caller AbortSignal is honored.** Aborting cancels the in-flight call
  and prevents further retries.
- **Stable `cacheIdentity()`.** The same model + temperature + response
  format produces the same identity hash, so judge-cache reuse is safe.
  Different models *must* yield different identities to avoid cache
  poisoning.

## Configuration tips

For `PilotSwarmJudgeClient`, the model reference accepts either the bare
name (`gpt-4.1`) or the qualified form (`github-copilot:gpt-4.1`). The
qualified form is preferred when the registry has the same bare name in
multiple providers — it removes ambiguity.

The default judge model env var is `LIVE_JUDGE_MODEL` for both clients. The
cross-judge agreement test additionally honors `LIVE_JUDGE_MODEL_A` and
`LIVE_JUDGE_MODEL_B` so two distinct judges score the same response.
