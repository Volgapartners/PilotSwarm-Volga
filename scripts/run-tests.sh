#!/bin/bash
# Run the full PilotSwarm local integration test suite using vitest.
#
# Usage:
#   ./scripts/test-local.sh                  # run all suites in parallel (default)
#   ./scripts/test-local.sh --parallel       # run suites in parallel explicitly
#   ./scripts/test-local.sh --suite=smoke    # run only matching suite(s)
#   ./scripts/test-local.sh smoke            # same as --suite=smoke
#   ./scripts/test-local.sh --sequential     # force suites one at a time
#
# Prerequisites:
#   - PostgreSQL running with DATABASE_URL in .env
#   - GITHUB_TOKEN in .env (for Copilot SDK)

set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"

SDK_DIR="packages/sdk"
ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found. Create it with DATABASE_URL and GITHUB_TOKEN."
    exit 1
fi

print_help() {
        cat <<'EOF'
Usage:
    ./scripts/run-tests.sh                    Run all suites in parallel (default)
    ./scripts/run-tests.sh --parallel         Run all suites in parallel explicitly
    ./scripts/run-tests.sh --sequential       Run all suites sequentially
    ./scripts/run-tests.sh --suite=<name>     Run matching suite(s)
    ./scripts/run-tests.sh <name>             Same as --suite=<name>
    ./scripts/run-tests.sh <name1> <name2>    Run multiple matching suites
    ./scripts/run-tests.sh --help
    ./scripts/run-tests.sh -h

Examples:
    ./scripts/run-tests.sh smoke
    ./scripts/run-tests.sh wait-affinity
    ./scripts/run-tests.sh session-policy
    ./scripts/run-tests.sh sub-agents reliability
    ./scripts/run-tests.sh --suite=contracts --suite=durability --sequential

Notes:
    - Positional suite names and --suite=<name> can be mixed.
    - Suite names are substring matches against files under packages/sdk/test/local.
    - Unknown options fail fast.
    - A full run (no suite filter) also runs the eval-harness tests
      (vitest against packages/eval-harness/test/**) before the SDK
      suites. Set SKIP_EVAL_HARNESS_TESTS=1 to skip.
EOF
}

for arg in "$@"; do
    case "$arg" in
        --help|-h)
            print_help
            exit 0
            ;;
    esac
done

# Build
echo "🔨 Building TypeScript..."
(cd "$SDK_DIR" && npm run build) || { echo "❌ Build failed"; exit 1; }

run_eval_harness_tests() {
    if [ "${SKIP_EVAL_HARNESS_TESTS:-0}" = "1" ]; then
        echo "⏭  Skipping eval-harness tests (SKIP_EVAL_HARNESS_TESTS=1)."
        return 0
    fi
    echo "🧪 Running eval-harness tests (vitest)..."
    (cd "$REPO_ROOT" && npm run --silent test --workspace=pilotswarm-eval-harness) \
        || { echo "❌ eval-harness tests failed"; exit 1; }
}

# Suppress duroxide Rust WARN logs in tests (AKS workers use INFO via their own env)
export RUST_LOG="${RUST_LOG:-error}"

# Load .env for vitest (vitest doesn't have --env-file)
set -a; source "$ENV_FILE"; set +a

cleanup_test_state() {
    echo "🧹 Cleaning stale local test state..."
    node scripts/cleanup-test-schemas.js
}

cleanup_test_state
trap cleanup_test_state EXIT

# Build vitest args.
# Default mode runs with Vitest's normal parallelism. Use --sequential for a
# deterministic one-at-a-time run when debugging contention or backend capacity issues.
VITEST_ARGS=(--run)
SUITE_FILTERS=()
for arg in "$@"; do
    case "$arg" in
        --suite=*) SUITE_FILTERS+=("${arg#--suite=}") ;;
        --sequential)
            VITEST_ARGS=(--run --no-file-parallelism --maxConcurrency=1)
            ;;
        --parallel)
            VITEST_ARGS=(--run)
            ;;
        --*)
            echo "ERROR: unknown option: $arg"
            exit 1
            ;;
        *)
            SUITE_FILTERS+=("$arg")
            ;;
    esac
done

# Run
cd "$SDK_DIR"
TARGET_FILES=()
if [ ${#SUITE_FILTERS[@]} -gt 0 ]; then
    for filter in "${SUITE_FILTERS[@]}"; do
        while IFS= read -r file; do
            TARGET_FILES+=("$file")
        done < <(find test/local -type f -name "*${filter}*.test.js" | sort)
    done

    if [ ${#TARGET_FILES[@]} -eq 0 ]; then
        echo "ERROR: no test files matched suite filter(s): ${SUITE_FILTERS[*]}"
        exit 1
    fi
fi

if [ ${#TARGET_FILES[@]} -gt 0 ]; then
    exec npx vitest "${VITEST_ARGS[@]}" "${TARGET_FILES[@]}"
else
    run_eval_harness_tests
    exec npx vitest "${VITEST_ARGS[@]}"
fi
