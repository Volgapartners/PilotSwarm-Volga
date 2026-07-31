/**
 * Codex-native MCP config translation.
 *
 * PilotSwarm's default `loadMcpConfig()` expands `${VAR}` references into
 * resolved secret values so the Copilot SDK can consume them at runtime.
 * That is not safe for Codex because Codex persists thread config and
 * session metadata to disk. `loadCodexMcpConfig()` MUST translate the
 * same `.mcp.json` into Codex-native `RawMcpServerConfig` without ever
 * embedding resolved secret values.
 *
 * Contract (must hold):
 *   - `Authorization: "Bearer ${VAR}"` -> `bearer_token_env_var: "VAR"`
 *   - Header exactly `"${VAR}"`        -> `env_http_headers[header] = "VAR"`
 *   - Static string value              -> `http_headers[header] = value`
 *   - Anything that mixes literal text and `${...}` on a header value
 *     (other than the bearer form above) is UNSUPPORTED — the loader
 *     must warn and drop that header rather than embed the resolved
 *     value.
 *   - `tools: ["a","b"]` -> `enabled_tools: ["a","b"]`.
 *   - `tools: ["*"]` or omitted -> no `enabled_tools`.
 *   - local/stdio: env entries whose value is exactly `${VAR}` with the
 *     same target key move to `env_vars: ["VAR"]`; other entries stay
 *     as `env` static values. `command`, benign `args`, and `cwd` are
 *     carried; unsafe args drop the entire server.
 *   - The serialized JSON output must contain the literal env-var NAME
 *     (e.g. "SIGNOZ_MCP_PROXY_TOKEN") but NEVER the resolved secret
 *     value present in process.env at load time.
 *
 * Run: npx vitest run test/local/mcp-loader-codex.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCodexMcpConfig, translateMcpConfigForCodex } from "../../src/mcp-loader.ts";

function mkTmpPluginDir(mcp) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-plugin-"));
    fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify(mcp, null, 2));
    return dir;
}

describe("Codex-native MCP config translation", () => {
    const originalEnv = { ...process.env };
    let warnSpy;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        process.env.SIGNOZ_MCP_PROXY_TOKEN = "SECRET-DO-NOT-LEAK-abc123";
        process.env.SOME_HEADER_TOKEN = "SECRET-DO-NOT-LEAK-def456";
        process.env.CTX7_API_KEY = "SECRET-DO-NOT-LEAK-ghi789";
        process.env.MY_LOCAL_TOKEN = "SECRET-DO-NOT-LEAK-jkl000";
        process.env.SECRET_URL_HOST = "SECRET-DO-NOT-LEAK-url-mno111";
    });

    afterEach(() => {
        for (const k of Object.keys(process.env)) delete process.env[k];
        Object.assign(process.env, originalEnv);
        warnSpy.mockRestore();
    });

    it("translates `Authorization: Bearer ${VAR}` into bearer_token_env_var without leaking the secret", () => {
        const raw = {
            signoz: {
                type: "http",
                url: "https://api.algovity.ai/signoz-mcp",
                headers: { Authorization: "Bearer ${SIGNOZ_MCP_PROXY_TOKEN}" },
                tools: ["*"],
            },
        };

        const out = translateMcpConfigForCodex(raw);

        expect(out.signoz).toBeTruthy();
        expect(out.signoz.url).toBe("https://api.algovity.ai/signoz-mcp");
        expect(out.signoz.bearer_token_env_var).toBe("SIGNOZ_MCP_PROXY_TOKEN");
        // MUST NOT surface a resolved Authorization header value anywhere.
        expect(out.signoz.http_headers?.Authorization).toBeUndefined();
        expect(out.signoz.env_http_headers?.Authorization).toBeUndefined();
        // Serialized JSON must not contain the resolved secret value.
        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain("SECRET-DO-NOT-LEAK-abc123");
        expect(serialized).toContain("SIGNOZ_MCP_PROXY_TOKEN");
    });

    it("maps a whole-value ${VAR} header into env_http_headers, not http_headers", () => {
        const raw = {
            api: {
                type: "http",
                url: "https://example.com/mcp",
                headers: { "X-Api-Key": "${SOME_HEADER_TOKEN}" },
                tools: ["*"],
            },
        };

        const out = translateMcpConfigForCodex(raw);

        expect(out.api.env_http_headers).toEqual({ "X-Api-Key": "SOME_HEADER_TOKEN" });
        expect(out.api.http_headers?.["X-Api-Key"]).toBeUndefined();
        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain("SECRET-DO-NOT-LEAK-def456");
        expect(serialized).toContain("SOME_HEADER_TOKEN");
    });

    it("preserves static header values as-is under http_headers", () => {
        const raw = {
            api: {
                type: "http",
                url: "https://example.com/mcp",
                headers: { "X-Static": "hello-world" },
                tools: ["*"],
            },
        };

        const out = translateMcpConfigForCodex(raw);

        expect(out.api.http_headers).toEqual({ "X-Static": "hello-world" });
        expect(out.api.env_http_headers).toBeUndefined();
    });

    it("warns and OMITS unsupported mixed env interpolation instead of embedding the secret", () => {
        const raw = {
            api: {
                type: "http",
                url: "https://example.com/mcp",
                headers: { "X-Weird": "prefix-${SOME_HEADER_TOKEN}-suffix" },
                tools: ["*"],
            },
        };

        const out = translateMcpConfigForCodex(raw);

        // Whole-header interpolation stays out. No embedded secret in http_headers.
        expect(out.api.http_headers?.["X-Weird"]).toBeUndefined();
        expect(out.api.env_http_headers?.["X-Weird"]).toBeUndefined();
        // MUST warn about the dropped header so operators can fix it.
        expect(warnSpy).toHaveBeenCalled();
        const combined = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(combined).toMatch(/X-Weird/);

        // Serialized output must not contain the resolved token bytes.
        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain("SECRET-DO-NOT-LEAK-def456");
    });

    it("carries the tools allow-list as enabled_tools, and omits it when tools is missing or ['*']", () => {
        const raw = {
            explicit: {
                type: "http",
                url: "https://example.com/one",
                tools: ["query", "list"],
            },
            wildcard: {
                type: "http",
                url: "https://example.com/two",
                tools: ["*"],
            },
            missing: {
                type: "http",
                url: "https://example.com/three",
            },
        };

        const out = translateMcpConfigForCodex(raw);

        expect(out.explicit.enabled_tools).toEqual(["query", "list"]);
        expect(out.wildcard.enabled_tools).toBeUndefined();
        expect(out.missing.enabled_tools).toBeUndefined();
    });

    it("translates local/stdio env `${VAR}` (same key) into env_vars and preserves command/args/cwd", () => {
        const raw = {
            "local-tool": {
                type: "local",
                command: "node",
                args: ["server.js", "--flag"],
                cwd: "/opt/local-tool",
                env: {
                    MY_LOCAL_TOKEN: "${MY_LOCAL_TOKEN}", // env var passthrough
                    LOG_LEVEL: "debug",                   // static
                },
                tools: ["*"],
            },
        };

        const out = translateMcpConfigForCodex(raw);

        expect(out["local-tool"].command).toBe("node");
        expect(out["local-tool"].args).toEqual(["server.js", "--flag"]);
        expect(out["local-tool"].cwd).toBe("/opt/local-tool");
        expect(out["local-tool"].env_vars).toEqual(["MY_LOCAL_TOKEN"]);
        expect(out["local-tool"].env).toEqual({ LOG_LEVEL: "debug" });

        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain("SECRET-DO-NOT-LEAK-jkl000");
    });

    it("skips the entire local server when an arg contains an env reference", () => {
        const out = translateMcpConfigForCodex({
            unsafe: {
                type: "stdio",
                command: "node",
                args: ["server.js", "--endpoint", "${PRIVATE_ENDPOINT}"],
            },
        });

        expect(out.unsafe).toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
        expect(JSON.stringify(out)).not.toContain("PRIVATE_ENDPOINT");
    });

    it("skips the entire local server for a sensitive flag followed by a value", () => {
        const out = translateMcpConfigForCodex({
            unsafe: {
                type: "stdio",
                command: "node",
                args: ["server.js", "--api-key", "literal-secret-value"],
            },
        });

        expect(out.unsafe).toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
        expect(JSON.stringify(out)).not.toContain("literal-secret-value");
    });

    it("skips the entire local server for a sensitive --flag=value arg", () => {
        const out = translateMcpConfigForCodex({
            unsafe: {
                type: "stdio",
                command: "node",
                args: ["server.js", "--token=literal-secret-value"],
            },
        });

        expect(out.unsafe).toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
        expect(JSON.stringify(out)).not.toContain("literal-secret-value");
    });

    it("skips the entire local server when a generic flag embeds a sensitive header value", () => {
        const out = translateMcpConfigForCodex({
            unsafe: {
                type: "stdio",
                command: "node",
                args: ["server.js", "--header=X-Api-Key:literal-secret-value"],
            },
        });

        expect(out.unsafe).toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
        expect(JSON.stringify(out)).not.toContain("literal-secret-value");
    });

    it("preserves benign local args that do not carry secret indirection or sensitive flags", () => {
        const args = ["server.js", "--port", "8080", "--log-level=debug", "--output-format", "json"];
        const out = translateMcpConfigForCodex({
            safe: {
                type: "stdio",
                command: "node",
                args,
            },
        });

        expect(out.safe?.args).toEqual(args);
    });

    it("REJECTS static (already-resolved) sensitive env keys in local/stdio configs (e.g. inline MY_LOCAL_TOKEN literal)", () => {
        const warnings = [];
        const spy = vi.spyOn(console, "warn").mockImplementation((...a) => warnings.push(a.join(" ")));

        // Simulates an operator or upstream loader that already resolved
        // ${MY_LOCAL_TOKEN} into its literal value (or a builder that
        // hardcoded the token) and passed the raw config directly into
        // WorkerConfig.mcpServers / plugin .mcp.json. Codex would
        // otherwise persist this to disk as part of thread config.
        const raw = {
            "local-tool": {
                type: "local",
                command: "node",
                args: ["server.js"],
                env: {
                    MY_LOCAL_TOKEN: "SECRET-DO-NOT-LEAK-jkl000", // static literal, sensitive name
                    API_KEY: "hardcoded-api-key-value",
                    AUTHORIZATION: "Bearer hardcoded-bearer",
                    SOME_PASSWORD: "hunter2",
                    A_COOKIE_JAR: "sid=abc",
                    OAUTH_SECRET: "shhh",
                    NODE_ENV: "production",     // benign — must stay
                    LOG_LEVEL: "debug",          // benign — must stay
                },
                tools: ["*"],
            },
        };

        const out = translateMcpConfigForCodex(raw);
        spy.mockRestore();

        // Benign env stays.
        expect(out["local-tool"].env).toEqual({
            NODE_ENV: "production",
            LOG_LEVEL: "debug",
        });

        // Sensitive-named static literals are dropped.
        expect(out["local-tool"].env?.MY_LOCAL_TOKEN).toBeUndefined();
        expect(out["local-tool"].env?.API_KEY).toBeUndefined();
        expect(out["local-tool"].env?.AUTHORIZATION).toBeUndefined();
        expect(out["local-tool"].env?.SOME_PASSWORD).toBeUndefined();
        expect(out["local-tool"].env?.A_COOKIE_JAR).toBeUndefined();
        expect(out["local-tool"].env?.OAUTH_SECRET).toBeUndefined();

        // env_vars must not silently promote a literal — passthrough
        // requires a same-key ${VAR} form and we didn't provide one.
        expect(out["local-tool"].env_vars ?? []).not.toContain("MY_LOCAL_TOKEN");
        expect(out["local-tool"].env_vars ?? []).not.toContain("API_KEY");

        // Every resolved secret value must be absent from the whole
        // serialized output (defence in depth against future fields).
        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain("SECRET-DO-NOT-LEAK-jkl000");
        expect(serialized).not.toContain("hardcoded-api-key-value");
        expect(serialized).not.toContain("hardcoded-bearer");
        expect(serialized).not.toContain("hunter2");
        expect(serialized).not.toContain("sid=abc");
        expect(serialized).not.toContain("shhh");

        // Warn about each dropped sensitive key so operators can fix.
        const dropWarns = warnings.filter((w) => w.includes("dropping env") && w.includes("local-tool"));
        expect(dropWarns.length).toBeGreaterThanOrEqual(6);
        for (const k of ["MY_LOCAL_TOKEN", "API_KEY", "AUTHORIZATION", "SOME_PASSWORD", "A_COOKIE_JAR", "OAUTH_SECRET"]) {
            expect(warnings.some((w) => w.includes(k))).toBe(true);
        }
    });

    it("still ACCEPTS `${VAR}` same-key passthrough on sensitive env keys (env_vars promotion is safe)", () => {
        // Passthrough form with same-key ${VAR} references the env var
        // by NAME only, so nothing is persisted to Codex config besides
        // the name. This must keep working for sensitive-named vars.
        const raw = {
            "local-tool": {
                type: "local",
                command: "node",
                env: {
                    MY_LOCAL_TOKEN: "${MY_LOCAL_TOKEN}",
                    API_KEY: "${API_KEY}",
                    AUTHORIZATION: "${AUTHORIZATION}",
                    NODE_ENV: "production",
                },
                tools: ["*"],
            },
        };

        const out = translateMcpConfigForCodex(raw);

        expect(out["local-tool"].env_vars?.sort()).toEqual([
            "API_KEY",
            "AUTHORIZATION",
            "MY_LOCAL_TOKEN",
        ]);
        expect(out["local-tool"].env).toEqual({ NODE_ENV: "production" });

        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain("SECRET-DO-NOT-LEAK-jkl000");
    });

    it("loadCodexMcpConfig reads raw .mcp.json from disk and applies the same safe translation", () => {
        const dir = mkTmpPluginDir({
            signoz: {
                type: "http",
                url: "https://api.algovity.ai/signoz-mcp",
                headers: { Authorization: "Bearer ${SIGNOZ_MCP_PROXY_TOKEN}" },
                tools: ["*"],
            },
        });
        try {
            const out = loadCodexMcpConfig(dir);
            expect(out.signoz.bearer_token_env_var).toBe("SIGNOZ_MCP_PROXY_TOKEN");
            expect(out.signoz.url).toBe("https://api.algovity.ai/signoz-mcp");
            const serialized = JSON.stringify(out);
            expect(serialized).not.toContain("SECRET-DO-NOT-LEAK-abc123");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    // ─── Round 2 review findings ────────────────────────────────

    it("does NOT emit `type` on translated entries (Codex CLI 0.145 rejects `mcp_servers.<name>.type`)", () => {
        // Verified live: `codex --strict-config -c mcp_servers.test.type=http`
        // exits 1 with `unknown configuration field mcp_servers.test.type`.
        // Codex infers transport from url vs command.
        const raw = {
            remote: {
                type: "http",
                url: "https://example.com/mcp",
                headers: { Authorization: "Bearer ${SIGNOZ_MCP_PROXY_TOKEN}" },
                tools: ["*"],
            },
            "remote-sse": {
                type: "sse",
                url: "https://example.com/sse",
                tools: ["*"],
            },
            "local-tool": {
                type: "local",
                command: "node",
                args: ["server.js"],
                tools: ["*"],
            },
            "local-stdio": {
                type: "stdio",
                command: "node",
                args: ["s.js"],
                tools: ["*"],
            },
        };

        const out = translateMcpConfigForCodex(raw);

        for (const key of Object.keys(raw)) {
            expect(out[key]).toBeTruthy();
            expect(out[key].type).toBeUndefined();
        }
        const serialized = JSON.stringify(out);
        expect(serialized).not.toMatch(/"type"\s*:/);
    });

    it("warns and SKIPS the server when the URL contains any `${VAR}` interpolation (Codex has no url_env_var)", () => {
        const raw = {
            api: {
                type: "http",
                url: "https://${SECRET_URL_HOST}.example.com/mcp",
                headers: { Authorization: "Bearer ${SIGNOZ_MCP_PROXY_TOKEN}" },
                tools: ["*"],
            },
        };

        const out = translateMcpConfigForCodex(raw);

        // The server must be dropped entirely rather than persisting the
        // resolved secret host in Codex's on-disk thread config.
        expect(out.api).toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
        const combined = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(combined).toMatch(/api/);
        expect(combined).toMatch(/url/i);

        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain("SECRET-DO-NOT-LEAK-url-mno111");
    });

    it("REJECTS a static (already-resolved) Authorization header instead of writing it to http_headers", () => {
        // Regression: an inline mcpServers entry passed with an
        // already-resolved bearer token — or a `.mcp.json` file where the
        // Authorization was hand-baked to a literal — used to end up in
        // http_headers verbatim, which Codex would then persist.
        const raw = {
            signoz: {
                type: "http",
                url: "https://api.algovity.ai/signoz-mcp",
                headers: { Authorization: "Bearer HARDCODED-SECRET-TOKEN-xyz" },
                tools: ["*"],
            },
        };

        const out = translateMcpConfigForCodex(raw);

        expect(out.signoz).toBeTruthy();
        expect(out.signoz.http_headers?.Authorization).toBeUndefined();
        expect(out.signoz.env_http_headers?.Authorization).toBeUndefined();
        expect(out.signoz.bearer_token_env_var).toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain("HARDCODED-SECRET-TOKEN-xyz");
    });

    it("REJECTS static values on the sensitive header set (case-insensitive) even when non-Authorization", () => {
        // Contract: sensitive headers can only be supplied via
        // `Authorization: Bearer ${VAR}` or a bare `${VAR}` value that
        // maps to env_http_headers. Static values on these headers are
        // dropped with a warning.
        const raw = {
            api: {
                url: "https://example.com/mcp",
                headers: {
                    "proxy-authorization": "Basic HARDCODED-PROXY-abc",
                    "Cookie": "session=HARDCODED-COOKIE-def",
                    "x-api-key": "HARDCODED-XAPI-ghi",
                    "API-KEY": "HARDCODED-APIKEY-jkl",
                    "X-Access-Token": "HARDCODED-ACCESSTOKEN-mno",
                    "X-Session-Token": "HARDCODED-SESSTOKEN-pqr",
                },
                tools: ["*"],
            },
        };

        const out = translateMcpConfigForCodex(raw);

        for (const [name, staticVal] of Object.entries({
            "proxy-authorization": "HARDCODED-PROXY-abc",
            "Cookie": "HARDCODED-COOKIE-def",
            "x-api-key": "HARDCODED-XAPI-ghi",
            "API-KEY": "HARDCODED-APIKEY-jkl",
            "X-Access-Token": "HARDCODED-ACCESSTOKEN-mno",
            "X-Session-Token": "HARDCODED-SESSTOKEN-pqr",
        })) {
            expect(out.api.http_headers?.[name]).toBeUndefined();
            const serialized = JSON.stringify(out);
            expect(serialized).not.toContain(staticVal);
        }
        expect(warnSpy).toHaveBeenCalled();
    });

    it("still ACCEPTS supported env forms for sensitive headers (bare ${VAR} → env_http_headers)", () => {
        const raw = {
            api: {
                url: "https://example.com/mcp",
                headers: {
                    "X-Api-Key": "${CTX7_API_KEY}",
                    "X-Static-Info": "public-info-safe-to-persist",
                },
                tools: ["*"],
            },
        };

        const out = translateMcpConfigForCodex(raw);

        expect(out.api.env_http_headers).toEqual({ "X-Api-Key": "CTX7_API_KEY" });
        expect(out.api.http_headers).toEqual({ "X-Static-Info": "public-info-safe-to-persist" });
        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain("SECRET-DO-NOT-LEAK-ghi789");
    });
});
