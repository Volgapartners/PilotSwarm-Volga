#!/usr/bin/env bash
#
# packages/eval-harness/bin/run-live.sh
#
# Convenience wrapper for the LIVE-gated eval-harness suites. Maps
# named flags onto the env-var gates documented in
# `packages/eval-harness/.env.example`, picks a timestamped
# `.eval-results/<ts>/` reports dir by default, and forwards the rest
# to `vitest run`.
#
# Examples
# --------
#   # All live suites with default credentials, no judge, no heavy perf
#   bin/run-live.sh
#
#   # Everything (heavy + n8 concurrency + durability perf + pg_stat + judge)
#   bin/run-live.sh --all
#
#   # Just the judge + safety judge cases
#   bin/run-live.sh --judge -- test/llm-judge-live.test.ts test/safety-live.test.ts
#
#   # Performance only (no judge cost)
#   bin/run-live.sh --perf
#
#   # Cheap smoke (live, no judge, no perf)
#   bin/run-live.sh --cheap
#
# Run from monorepo root or from packages/eval-harness/. Either works.

set -euo pipefail

# --- Locate eval-harness package root regardless of CWD --------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# --- Defaults --------------------------------------------------------
LIVE=1
LIVE_JUDGE=0
PERF_HEAVY=0
PERF_HEAVY_N8=0
PERF_DURABILITY=0
PG_STAT_STATEMENTS_ENABLED=0
PROMPT_TESTING=0
KEEP_DURABILITY_ENV=0
EVAL_VERBOSE_TEARDOWN=0

REPORTS_DIR=""           # empty → auto-generate timestamped dir
NO_REPORTS=0
TEST_GLOB_DEFAULT=("test/*-live.test.ts")
TESTS=()
VITEST_PASSTHRU=()
SAW_DOUBLE_DASH=0

usage() {
  cat <<'USAGE'
Usage: run-live.sh [flags] [-- <vitest-args> | <test-files>...]

Suite gates (set the matching env var to 1 for the run):
  --live                LIVE=1              (default ON; --no-live disables)
  --no-live             Skip LIVE gate (mostly useful for dry-runs)
  --judge               LIVE_JUDGE=1
  --heavy               PERF_HEAVY=1        (concurrency profiler ≥7 sessions)
  --heavy-n8            PERF_HEAVY=1 + PERF_HEAVY_N8=1 (≥15 sessions)
  --durability-perf     PERF_DURABILITY=1
  --pg-stat             PG_STAT_STATEMENTS_ENABLED=1
  --prompt-testing      PROMPT_TESTING=1

Behavior knobs:
  --keep-env            KEEP_DURABILITY_ENV=1
  --verbose-teardown    EVAL_VERBOSE_TEARDOWN=1
  --reports-dir <path>  EVAL_REPORTS_DIR=<path>   (relative to PKG_DIR)
  --no-reports          do not auto-create EVAL_REPORTS_DIR

Grouped flags:
  --all                 judge + heavy + heavy-n8 + durability-perf + pg-stat
  --perf                heavy + heavy-n8 + durability-perf + pg-stat
  --cheap               live only (clears any prior --judge/--heavy/...)

Misc:
  --dry-run             print resolved env + vitest invocation; exit 0
  -h, --help            this help

Anything after `--` is forwarded verbatim to vitest. Bare positional
arguments are treated as test-file paths (defaults to test/*-live.test.ts).
USAGE
}

apply_all() {
  LIVE_JUDGE=1
  PERF_HEAVY=1
  PERF_HEAVY_N8=1
  PERF_DURABILITY=1
  PG_STAT_STATEMENTS_ENABLED=1
}

apply_perf() {
  PERF_HEAVY=1
  PERF_HEAVY_N8=1
  PERF_DURABILITY=1
  PG_STAT_STATEMENTS_ENABLED=1
}

apply_cheap() {
  LIVE_JUDGE=0
  PERF_HEAVY=0
  PERF_HEAVY_N8=0
  PERF_DURABILITY=0
  PG_STAT_STATEMENTS_ENABLED=0
  PROMPT_TESTING=0
}

DRY_RUN=0

while (( $# > 0 )); do
  if (( SAW_DOUBLE_DASH == 1 )); then
    VITEST_PASSTHRU+=("$1"); shift; continue
  fi
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --live) LIVE=1 ;;
    --no-live) LIVE=0 ;;
    --judge) LIVE_JUDGE=1 ;;
    --heavy) PERF_HEAVY=1 ;;
    --heavy-n8) PERF_HEAVY=1; PERF_HEAVY_N8=1 ;;
    --durability-perf) PERF_DURABILITY=1 ;;
    --pg-stat) PG_STAT_STATEMENTS_ENABLED=1 ;;
    --prompt-testing) PROMPT_TESTING=1 ;;
    --keep-env) KEEP_DURABILITY_ENV=1 ;;
    --verbose-teardown) EVAL_VERBOSE_TEARDOWN=1 ;;
    --reports-dir)
      shift; [[ $# -gt 0 ]] || { echo "--reports-dir needs a path" >&2; exit 2; }
      REPORTS_DIR="$1" ;;
    --reports-dir=*) REPORTS_DIR="${1#*=}" ;;
    --no-reports) NO_REPORTS=1 ;;
    --all) apply_all ;;
    --perf) apply_perf ;;
    --cheap) apply_cheap ;;
    --dry-run) DRY_RUN=1 ;;
    --) SAW_DOUBLE_DASH=1 ;;
    -*)
      echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
    *)
      TESTS+=("$1") ;;
  esac
  shift
done

# Default test glob if no positional / no passthrough file given.
# Expand the glob from inside PKG_DIR so vitest receives concrete file
# paths — vitest 4 treats unmatched glob args as literal filters and
# exits "No test files found" if the shell never expanded them.
if (( ${#TESTS[@]} == 0 )); then
  pushd "${PKG_DIR}" >/dev/null
  shopt -s nullglob
  TESTS=( ${TEST_GLOB_DEFAULT[@]} )
  shopt -u nullglob
  popd >/dev/null
  if (( ${#TESTS[@]} == 0 )); then
    echo "no live test files matched ${TEST_GLOB_DEFAULT[*]} under ${PKG_DIR}" >&2
    exit 1
  fi
fi

# Reports dir resolution
if (( NO_REPORTS == 0 )); then
  if [[ -z "${REPORTS_DIR}" ]]; then
    REPORTS_DIR=".eval-results/$(date +%Y%m%d-%H%M%S)"
  fi
fi

# Build env exports
declare -a ENV_PAIRS=()
push_env() {
  local k="$1" v="$2"
  ENV_PAIRS+=("${k}=${v}")
}

(( LIVE == 1 )) && push_env LIVE 1
(( LIVE_JUDGE == 1 )) && push_env LIVE_JUDGE 1
(( PERF_HEAVY == 1 )) && push_env PERF_HEAVY 1
(( PERF_HEAVY_N8 == 1 )) && push_env PERF_HEAVY_N8 1
(( PERF_DURABILITY == 1 )) && push_env PERF_DURABILITY 1
(( PG_STAT_STATEMENTS_ENABLED == 1 )) && push_env PG_STAT_STATEMENTS_ENABLED 1
(( PROMPT_TESTING == 1 )) && push_env PROMPT_TESTING 1
(( KEEP_DURABILITY_ENV == 1 )) && push_env KEEP_DURABILITY_ENV 1
(( EVAL_VERBOSE_TEARDOWN == 1 )) && push_env EVAL_VERBOSE_TEARDOWN 1
(( NO_REPORTS == 0 )) && push_env EVAL_REPORTS_DIR "${REPORTS_DIR}"

if (( DRY_RUN == 1 )); then
  echo "PKG_DIR:        ${PKG_DIR}"
  echo "Env injected:"
  for kv in "${ENV_PAIRS[@]}"; do echo "  ${kv}"; done
  echo "Vitest:"
  echo "  npx vitest run ${TESTS[*]} ${VITEST_PASSTHRU[*]+${VITEST_PASSTHRU[*]}}"
  exit 0
fi

cd "${PKG_DIR}"

# Ensure dist/ is fresh — `npx vitest run` skips the npm `pretest` hook,
# so without this a stale dist/ can mask source changes (the package
# exposes `dist/index.js` via the `.` export). Skip with EVAL_SKIP_BUILD=1
# if you've just built and want to shave the tsc cost.
if [[ "${EVAL_SKIP_BUILD:-0}" != "1" ]]; then
  npm run --silent build
fi

# shellcheck disable=SC2068
exec env ${ENV_PAIRS[@]} npx vitest run "${TESTS[@]}" ${VITEST_PASSTHRU[@]+"${VITEST_PASSTHRU[@]}"}
