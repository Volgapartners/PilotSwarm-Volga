/**
 * MCP config loader — reads .mcp.json files from plugin directories.
 *
 * File format (matches @github/copilot-sdk MCPServerConfig):
 *
 *   {
 *     "my-server": {
 *       "command": "node",
 *       "args": ["server.js"],
 *       "tools": ["*"]
 *     },
 *     "remote-api": {
 *       "type": "http",
 *       "url": "https://api.example.com/mcp",
 *       "tools": ["query"],
 *       "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
 *     }
 *   }
 *
 * Environment variable references like `${VAR}` in string values
 * are expanded at load time.
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";

// ─── Types ───────────────────────────────────────────────────────

/** Matches @github/copilot-sdk MCPServerConfig union. */
export type MCPServerConfig = MCPLocalServerConfig | MCPRemoteServerConfig;

export interface MCPLocalServerConfig {
    type?: "local" | "stdio";
    command: string;
    args: string[];
    tools: string[];
    env?: Record<string, string>;
    cwd?: string;
    timeout?: number;
}

export interface MCPRemoteServerConfig {
    type: "http" | "sse";
    url: string;
    tools: string[];
    headers?: Record<string, string>;
    timeout?: number;
}

// ─── Env Expansion ──────────────────────────────────────────────

/** Expand `${VAR}` references in a string using process.env. */
function expandEnv(value: string): string {
    return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

/** Recursively expand env vars in all string values of an object. */
function expandEnvDeep(obj: any): any {
    if (typeof obj === "string") return expandEnv(obj);
    if (Array.isArray(obj)) return obj.map(expandEnvDeep);
    if (obj && typeof obj === "object") {
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = expandEnvDeep(value);
        }
        return result;
    }
    return obj;
}

// ─── Loader ─────────────────────────────────────────────────────

/**
 * Load MCP server config from a `.mcp.json` file in a plugin directory.
 *
 * @param pluginDir - Path to the plugin directory (looks for `.mcp.json` at root).
 * @returns Record of server name → config. Empty record if no `.mcp.json` found.
 */
export function loadMcpConfig(pluginDir: string): Record<string, MCPServerConfig> {
    const absDir = path.resolve(pluginDir);
    const mcpPath = path.join(absDir, ".mcp.json");

    if (!fs.existsSync(mcpPath)) {
        return {};
    }

    try {
        const raw = fs.readFileSync(mcpPath, "utf-8");
        const parsed = JSON.parse(raw);

        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            console.warn(`[mcp-loader] Invalid .mcp.json in ${absDir}: expected object`);
            return {};
        }

        // Expand env vars and validate each entry
        const result: Record<string, MCPServerConfig> = {};
        for (const [name, config] of Object.entries(parsed)) {
            if (typeof config !== "object" || config === null) {
                console.warn(`[mcp-loader] Skipping MCP server "${name}": invalid config`);
                continue;
            }
            result[name] = expandEnvDeep(config);
        }

        return result;
    } catch (err: any) {
        console.warn(`[mcp-loader] Failed to parse .mcp.json in ${absDir}: ${err.message}`);
        return {};
    }
}

// ─── Codex-native (safe) translation ────────────────────────────

/**
 * Codex-native MCP server config. Mirrors the subset of Codex
 * `RawMcpServerConfig` PilotSwarm knows how to translate to safely
 * without ever embedding a resolved secret value.
 *
 * IMPORTANT: this shape is what Codex persists to disk as part of its
 * thread config / session metadata. Every field MUST be safe to
 * serialize into that on-disk representation — i.e. env-var NAMES only,
 * NEVER resolved values.
 */
/**
 * Codex-native MCP server config. Mirrors the subset of Codex
 * `RawMcpServerConfig` PilotSwarm knows how to translate to safely
 * without ever embedding a resolved secret value.
 *
 * IMPORTANT: this shape is what Codex persists to disk as part of its
 * thread config / session metadata. Every field MUST be safe to
 * serialize into that on-disk representation — i.e. env-var NAMES only,
 * NEVER resolved values.
 *
 * NOTE: no `type` field. Codex CLI 0.145 rejects
 * `mcp_servers.<name>.type` with `unknown configuration field
 * mcp_servers.<name>.type` under `--strict-config`. Codex infers
 * transport from `url` vs `command`.
 */
export interface CodexMcpServerConfig {
    /**
     * Remote endpoint. MUST be a static string with no env
     * interpolation — Codex has no url_env_var field, so an interpolated
     * URL cannot be represented without persisting the resolved value.
     * The translator warns and drops the server when the raw URL
     * contains any env reference.
     */
    url?: string;
    /**
     * Static headers safe to persist alongside the config. The
     * translator drops any header whose name matches the sensitive
     * header set (Authorization, Proxy-Authorization, Cookie,
     * *api-key*, *token*, ...) when the value is a static literal.
     */
    http_headers?: Record<string, string>;
    /**
     * Headers whose value is sourced from an environment variable at
     * runtime. Map is `header -> env var NAME`. NEVER the value.
     */
    env_http_headers?: Record<string, string>;
    /**
     * If present, Codex will build an Authorization: Bearer <value> at
     * request time by reading the named env var. Never a resolved token.
     */
    bearer_token_env_var?: string;
    /** stdio only: command path. */
    command?: string;
    /** stdio only: process arguments. */
    args?: string[];
    /** stdio only: static env values (safe strings only). */
    env?: Record<string, string>;
    /** stdio only: env vars to pass through from the worker process by NAME. */
    env_vars?: string[];
    /** stdio only: working directory. */
    cwd?: string;
    /** Tools allow-list. Omitted when the source used ["*"] or nothing. */
    enabled_tools?: string[];
    /** Startup timeout hint (seconds). */
    startup_timeout_sec?: number;
    /** Tool-call timeout hint (seconds). */
    tool_timeout_sec?: number;
}

/**
 * Sensitive HTTP header names (case-insensitive). Static values on
 * these headers must NEVER be written into `http_headers` — even when
 * they contain no env interpolation — because that would leak an
 * operator-provided literal secret into Codex's on-disk thread config.
 *
 * The set covers:
 *   - Authorization / Proxy-Authorization
 *   - Cookie / Set-Cookie
 *   - Any header whose name contains api-key, apikey, api_key,
 *     token, secret, password, or bearer.
 */
const SENSITIVE_HEADER_LITERAL: ReadonlySet<string> = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
]);
const SENSITIVE_HEADER_SUBSTR: readonly string[] = [
    "api-key",
    "apikey",
    "api_key",
    "token",
    "secret",
    "password",
    "bearer",
];

function isSensitiveHeaderName(name: string): boolean {
    const lower = name.toLowerCase();
    if (SENSITIVE_HEADER_LITERAL.has(lower)) return true;
    for (const needle of SENSITIVE_HEADER_SUBSTR) {
        if (lower.includes(needle)) return true;
    }
    return false;
}

/**
 * Sensitive local-env key names (case-insensitive). Static literal
 * values on these keys must NEVER be written into `env` — even when
 * they contain no env interpolation — because Codex persists local
 * server configs (including their `env` block) to thread config on
 * disk. This defends against inline WorkerConfig.mcpServers that
 * already carry resolved secret values.
 *
 * Coverage:
 *   - literal (exact): authorization, cookie
 *   - substring: auth, oauth, token, secret, password, bearer,
 *     api-key, apikey, api_key, key
 *
 * NOTE: "auth" and "key" are intentionally broad. Benign env keys
 * like NODE_ENV, LOG_LEVEL, PATH, HOME, PORT, HOSTNAME, LANG, USER,
 * TZ do not contain these substrings and are unaffected.
 */
const SENSITIVE_ENV_LITERAL: ReadonlySet<string> = new Set([
    "authorization",
    "cookie",
]);
const SENSITIVE_ENV_SUBSTR: readonly string[] = [
    "auth",
    "token",
    "secret",
    "password",
    "bearer",
    "cookie",
    "api-key",
    "apikey",
    "api_key",
    "key",
];

function isSensitiveEnvKeyName(name: string): boolean {
    const lower = name.toLowerCase();
    if (SENSITIVE_ENV_LITERAL.has(lower)) return true;
    for (const needle of SENSITIVE_ENV_SUBSTR) {
        if (lower.includes(needle)) return true;
    }
    return false;
}
/**
 * Match a header value that is a bare env reference `"${VAR}"` — nothing
 * before, nothing after. Returns the var name, or null.
 */
function matchBareEnvRef(value: string): string | null {
    const m = /^\$\{(\w+)\}$/.exec(value);
    return m ? m[1] : null;
}

/**
 * Match `"Bearer ${VAR}"` (exactly one leading `Bearer ` and a bare env ref).
 * Returns the var name or null.
 */
function matchBearerEnvRef(value: string): string | null {
    const m = /^Bearer\s+\$\{(\w+)\}$/.exec(value);
    return m ? m[1] : null;
}

/** True if any `${...}` reference appears in the string. */
function containsEnvRef(value: string): boolean {
    return /\$\{\w+\}/.test(value);
}

const SENSITIVE_ARG_TOKENS: ReadonlySet<string> = new Set([
    "auth",
    "authorization",
    "authentication",
    "oauth",
    "token",
    "secret",
    "password",
    "passwd",
    "bearer",
    "key",
    "apikey",
]);

function codexArgTokens(value: string): string[] {
    return value
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

function unsafeCodexArgReason(value: string): string | null {
    if (/\$\{[^}]+\}/.test(value)) return "environment-variable interpolation";

    const trimmed = value.trim();
    const flagMatch = /^-{1,2}([^=]+)(?:=.*)?$/.exec(trimmed);
    if (flagMatch) {
        if (codexArgTokens(flagMatch[1]).some((token) => SENSITIVE_ARG_TOKENS.has(token))) {
            return "a sensitive flag";
        }
    }

    if (codexArgTokens(trimmed).some((token) => SENSITIVE_ARG_TOKENS.has(token))) {
        return "a sensitive value";
    }

    // Positional args carry credentials with no flag at all — a bare
    // provider token, a JWT, or a URL with userinfo. Shape check.
    const credentialReason = credentialShapeReason(trimmed);
    if (credentialReason) return credentialReason;

    return null;
}

/**
 * Query-parameter / URL-field names that are treated as credential
 * carriers. Superset of {@link SENSITIVE_ARG_TOKENS}; matching is done
 * on tokenized names so `api_key`, `apiKey`, and `X-Api-Key` all hit,
 * while `keyspace` (a single non-matching token) does not.
 */
const SENSITIVE_PARAM_TOKENS: ReadonlySet<string> = new Set([
    ...SENSITIVE_ARG_TOKENS,
    "signature",
    "sig",
    "credential",
    "credentials",
    "pwd",
]);

/**
 * Well-known provider credential shapes. Deliberately narrow and
 * anchored — a generic "long random-looking string" heuristic produces
 * false positives on build IDs, hashes, and paths, which would silently
 * break working MCP servers.
 */
const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
    /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/,                  // OpenAI / Anthropic style secret key
    /(?:^|[^A-Za-z0-9])(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/, // Stripe live/test keys
    /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{16,}/,             // GitHub classic PAT family
    /(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/,           // GitHub fine-grained PAT
    /(?:^|[^A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/,          // Slack tokens
    /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Za-z])/, // AWS access key id
    /(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/, // Google API key
    /(?:^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,                 // PEM private key
];

/**
 * `key=value` pairs inside semicolon-delimited connection strings /
 * DSNs (SQL Server, Azure Storage, ODBC, ...) where the value is the
 * credential itself.
 */
const CONNECTION_STRING_SECRET_RE =
    /(?:^|[;\s])\s*(?:password|pwd|secret|api[_-]?key|access[_-]?key|accountkey|shared[_-]?access[_-]?key|token|credential)\s*=\s*[^;\s]+/i;

/**
 * Reason a URL-shaped value carries a credential, or null. Names the
 * offending field only — never echoes the value.
 */
function urlCredentialReason(value: string): string | null {
    // Userinfo shape check first: it works even for schemes `new URL`
    // parses loosely (or not at all).
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#@\s]*@/.test(value)) {
        return "embedded userinfo credentials in a URL";
    }
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }
    if (parsed.username || parsed.password) return "embedded userinfo credentials in a URL";
    for (const key of parsed.searchParams.keys()) {
        if (codexArgTokens(key).some((token) => SENSITIVE_PARAM_TOKENS.has(token))) {
            return `a sensitive query parameter ("${key}")`;
        }
    }
    return null;
}

/**
 * Conservative, reusable credential-shape check. Returns a human
 * reason (safe to log — never contains the value) or null.
 *
 * Applied to the Codex-native MCP URL, static local env values, and
 * args, all of which Codex persists verbatim to on-disk thread config.
 */
function credentialShapeReason(value: string): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (CREDENTIAL_VALUE_PATTERNS.some((re) => re.test(trimmed))) {
        return "a credential-shaped value";
    }
    const urlReason = urlCredentialReason(trimmed);
    if (urlReason) return urlReason;
    if (CONNECTION_STRING_SECRET_RE.test(trimmed)) {
        return "a credential-bearing connection string";
    }
    return null;
}

/**
 * Public-shape predicate over {@link credentialShapeReason}.
 * @internal
 */
export function looksLikeCredential(value: string): boolean {
    return credentialShapeReason(value) !== null;
}

/**
 * Env key names that conventionally carry a full connection string /
 * DSN / webhook secret. For these, ANY `scheme://...` value is rejected
 * even when it has no userinfo, because the secret is typically the
 * path (e.g. a Slack webhook) rather than a password component.
 *
 * Benign endpoint variables (SERVICE_ENDPOINT, API_BASE, ...) are NOT
 * hinted and survive.
 */
const CREDENTIAL_HINT_ENV_SUBSTR: readonly string[] = [
    "database_url",
    "databaseurl",
    "redis_url",
    "redisurl",
    "mongodb_uri",
    "mongodb_url",
    "mongo_uri",
    "mongo_url",
    "postgres_url",
    "postgresql_url",
    "mysql_url",
    "amqp_url",
    "connection_string",
    "connectionstring",
    "webhook_url",
    "webhookurl",
    "dsn",
];

function isCredentialHintedEnvKey(name: string): boolean {
    const lower = name.toLowerCase();
    return CREDENTIAL_HINT_ENV_SUBSTR.some((needle) => lower.includes(needle));
}

/**
 * Reason a static local `env` entry must not be persisted, or null.
 * Never includes the value.
 */
function unsafeCodexEnvValueReason(key: string, value: string): string | null {
    const shape = credentialShapeReason(value);
    if (shape) return shape;
    if (isCredentialHintedEnvKey(key) && /:\/\//.test(value.trim())) {
        return "a credential-bearing connection string";
    }
    return null;
}

/**
 * Translate one PilotSwarm `.mcp.json` entry into a Codex-native
 * `CodexMcpServerConfig`, WITHOUT embedding resolved secret values.
 *
 * Rules:
 *   - HTTP/SSE:
 *       - `url` may include `${VAR}` — expanded (URL is not a secret).
 *       - Header `Authorization: "Bearer ${VAR}"` → `bearer_token_env_var: "VAR"`.
 *       - Header value `"${VAR}"` (bare) → `env_http_headers[header] = "VAR"`.
 *       - Header value is a static string (no `${...}`) → `http_headers[header] = value`.
 *       - Any other `${...}` interpolation is UNSUPPORTED — warn and drop the header.
 *   - stdio/local:
 *       - `command`, benign `args`, and `cwd` carried unchanged.
 *       - Any arg containing `${VAR}` or a sensitive auth/token/secret/
 *         password/bearer/key flag or value drops the entire server.
 *       - `env[K] = "${K}"` → `env_vars: [K]` (same-key passthrough).
 *       - `env[K] = "static"` → `env[K] = "static"`.
 *       - Any other env `${VAR}` pattern is UNSUPPORTED — warn and drop the entry.
 *   - `tools: ["*"]` or missing → no `enabled_tools`.
 *   - `tools: [...]` → `enabled_tools: [...]`.
 *   - `timeout` (ms) → conservatively translated to `tool_timeout_sec` in whole seconds.
 *
 * Returns `null` when the entry cannot be safely translated at all
 * (e.g. no URL and no command).
 */
function translateOneForCodex(name: string, raw: any): CodexMcpServerConfig | null {
    if (!raw || typeof raw !== "object") return null;
    const out: CodexMcpServerConfig = {};
    // NOTE: intentionally do NOT copy `raw.type`. Codex CLI 0.145
    // rejects `mcp_servers.<name>.type` under --strict-config. Transport
    // is inferred from `url` vs `command`.
    const declaredType = typeof raw.type === "string" ? raw.type : undefined;
    const isHttp = declaredType === "http" || declaredType === "sse" || typeof raw.url === "string";
    const isLocal = declaredType === "local" || declaredType === "stdio" || typeof raw.command === "string";

    if (isHttp) {
        if (typeof raw.url !== "string" || !raw.url) {
            console.warn(`[mcp-loader] Codex: skipping "${name}" — missing URL for http/sse server.`);
            return null;
        }
        // URL is persisted verbatim by Codex — and Codex has no
        // url_env_var field. Any env interpolation here would either
        // (a) leak the resolved value into thread config, or (b) get
        // baked in at load time and never refreshed. Both are wrong.
        // Drop the server rather than embed a resolved value.
        if (containsEnvRef(raw.url)) {
            console.warn(
                `[mcp-loader] Codex: skipping "${name}" — url contains an env reference ` +
                `and Codex has no url_env_var field. Persisting the resolved value would leak the secret ` +
                `into thread config. Move the interpolated part out of the URL.`,
            );
            return null;
        }
        // The URL itself can BE the credential (userinfo, or an
        // `?api_key=` style query parameter). Codex persists the URL
        // verbatim, so drop the server rather than write it to disk.
        const urlReason = urlCredentialReason(raw.url);
        if (urlReason) {
            console.warn(
                `[mcp-loader] Codex: skipping "${name}" — url has ${urlReason}. ` +
                `Codex persists the URL verbatim into thread config. Supply the credential via a header ` +
                `env reference instead.`,
            );
            return null;
        }
        out.url = raw.url;

        if (raw.headers && typeof raw.headers === "object") {
            for (const [header, value] of Object.entries(raw.headers)) {
                if (typeof value !== "string") {
                    console.warn(`[mcp-loader] Codex: dropping header "${header}" on server "${name}" — non-string value.`);
                    continue;
                }
                const sensitive = isSensitiveHeaderName(header);
                // Authorization: Bearer ${VAR} → bearer_token_env_var
                if (header.toLowerCase() === "authorization") {
                    const bearerVar = matchBearerEnvRef(value);
                    if (bearerVar) {
                        out.bearer_token_env_var = bearerVar;
                        continue;
                    }
                }
                // Bare "${VAR}" → env_http_headers (safe for sensitive and non-sensitive alike).
                const bareVar = matchBareEnvRef(value);
                if (bareVar) {
                    (out.env_http_headers ??= {})[header] = bareVar;
                    continue;
                }
                if (sensitive) {
                    // Static literal on a sensitive header — refuse. This
                    // catches:
                    //   - already-resolved Authorization values
                    //     (`Authorization: "Bearer HARDCODED"`)
                    //   - Cookie / Proxy-Authorization / API-Key /
                    //     token / secret / password / bearer variants
                    //   - inline mcpServers passed with resolved values
                    console.warn(
                        `[mcp-loader] Codex: dropping sensitive header "${header}" on server "${name}" — ` +
                        `static values are not allowed on sensitive headers because Codex persists them ` +
                        `to disk. Use "\${ENV_VAR}" or, for Authorization, "Bearer \${ENV_VAR}".`,
                    );
                    continue;
                }
                if (!containsEnvRef(value)) {
                    // Non-sensitive static header — safe to persist.
                    (out.http_headers ??= {})[header] = value;
                    continue;
                }
                // Non-sensitive but mixed interpolation. Do NOT embed the resolved value.
                console.warn(
                    `[mcp-loader] Codex: dropping header "${header}" on server "${name}" — ` +
                    `mixed env interpolation is not supported by Codex-native config. ` +
                    `Use a bare "\${VAR}" value.`,
                );
            }
        }
    } else if (isLocal) {
        if (typeof raw.command !== "string" || !raw.command) {
            console.warn(`[mcp-loader] Codex: skipping "${name}" — missing command for local/stdio server.`);
            return null;
        }
        out.command = raw.command;
        if (Array.isArray(raw.args)) {
            const args = raw.args.map((a: any) => String(a));
            const unsafeIndex = args.findIndex((arg: string) => unsafeCodexArgReason(arg) !== null);
            if (unsafeIndex >= 0) {
                const reason = unsafeCodexArgReason(args[unsafeIndex])!;
                console.warn(
                    `[mcp-loader] Codex: skipping "${name}" — arg ${unsafeIndex + 1} contains ${reason}. ` +
                    `Codex has no safe argument indirection and persists stdio args to disk.`,
                );
                return null;
            }
            out.args = args;
        }
        if (typeof raw.cwd === "string" && raw.cwd) out.cwd = raw.cwd;

        if (raw.env && typeof raw.env === "object") {
            for (const [key, value] of Object.entries(raw.env)) {
                if (typeof value !== "string") continue;
                const bareVar = matchBareEnvRef(value);
                if (bareVar) {
                    if (bareVar === key) {
                        // Same-key ${VAR} passthrough is safe for
                        // sensitive-named keys too — only the name is
                        // persisted, not the value.
                        (out.env_vars ??= []).push(key);
                    } else {
                        console.warn(
                            `[mcp-loader] Codex: dropping env "${key}" on server "${name}" — ` +
                            `passthrough from a different env var name ("${bareVar}") is not supported safely.`,
                        );
                    }
                    continue;
                }
                if (!containsEnvRef(value)) {
                    // Static literal. Sensitive-named keys must NEVER
                    // land in `env` because Codex persists local
                    // server configs (env included) to disk. Refuse
                    // and warn — mirrors the http header path so
                    // inline mcpServers with resolved secret values
                    // cannot leak into thread config.
                    if (isSensitiveEnvKeyName(key)) {
                        console.warn(
                            `[mcp-loader] Codex: dropping env "${key}" on server "${name}" — ` +
                            `sensitive-named env keys cannot carry static literals because Codex ` +
                            `persists them to disk. Use "\${${key}}" for same-key passthrough.`,
                        );
                        continue;
                    }
                    // The key name can be perfectly benign
                    // (DATABASE_URL, SENTRY_DSN, WEBHOOK_URL) while the
                    // VALUE is a credential-bearing connection string
                    // or a bare provider token. Shape-check it too.
                    const valueReason = unsafeCodexEnvValueReason(key, value);
                    if (valueReason) {
                        console.warn(
                            `[mcp-loader] Codex: dropping env "${key}" on server "${name}" — ` +
                            `value looks like ${valueReason} and Codex persists local server env to disk. ` +
                            `Use "\${${key}}" for same-key passthrough.`,
                        );
                        continue;
                    }
                    (out.env ??= {})[key] = value;
                    continue;
                }
                console.warn(
                    `[mcp-loader] Codex: dropping env "${key}" on server "${name}" — ` +
                    `mixed env interpolation is not supported by Codex-native config.`,
                );
            }
        }
    } else {
        console.warn(`[mcp-loader] Codex: skipping "${name}" — cannot classify as http/sse or local/stdio.`);
        return null;
    }

    // Tools allow-list. "*" or missing means "all" — Codex omits enabled_tools.
    if (Array.isArray(raw.tools)) {
        const names = raw.tools.filter((t: any) => typeof t === "string" && t.length > 0);
        if (names.length && !names.includes("*")) out.enabled_tools = names;
    }

    if (typeof raw.timeout === "number" && raw.timeout > 0) {
        const secs = Math.max(1, Math.floor(raw.timeout / 1000));
        out.tool_timeout_sec = secs;
    }

    return out;
}

/**
 * Translate a whole `.mcp.json`-shaped record into Codex-native
 * server configs, WITHOUT embedding secret values. Unsupported
 * entries are omitted with a warning.
 *
 * @public — this is the pure-function translator; use
 * `loadCodexMcpConfig` when you want to read from a plugin dir.
 */
export function translateMcpConfigForCodex(
    raw: Record<string, any>,
): Record<string, CodexMcpServerConfig> {
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, CodexMcpServerConfig> = {};
    for (const [name, cfg] of Object.entries(raw)) {
        const translated = translateOneForCodex(name, cfg);
        if (translated) out[name] = translated;
    }
    return out;
}

/**
 * Read a plugin directory's raw `.mcp.json` and return the safe
 * Codex-native translation. Unlike `loadMcpConfig`, this reader does
 * NOT expand `${VAR}` references in header/env values into their
 * resolved secrets — it walks the raw JSON and produces env-var-name
 * references so Codex can persist the config to disk safely.
 */
export function loadCodexMcpConfig(pluginDir: string): Record<string, CodexMcpServerConfig> {
    const absDir = path.resolve(pluginDir);
    const mcpPath = path.join(absDir, ".mcp.json");

    if (!fs.existsSync(mcpPath)) return {};

    try {
        const raw = fs.readFileSync(mcpPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            console.warn(`[mcp-loader] Codex: invalid .mcp.json in ${absDir}: expected object`);
            return {};
        }
        return translateMcpConfigForCodex(parsed);
    } catch (err: any) {
        console.warn(`[mcp-loader] Codex: failed to parse .mcp.json in ${absDir}: ${err.message}`);
        return {};
    }
}
