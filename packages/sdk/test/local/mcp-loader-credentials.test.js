/**
 * Codex-native MCP config: credential-shaped value rejection.
 *
 * The existing translator only reasoned about NAMES (sensitive header
 * names, sensitive env key names, sensitive flag names). That leaves a
 * large hole, because Codex persists the translated config to disk:
 *
 *   - a URL can carry the credential itself — `https://user:pass@host`
 *     or `?api_key=...` — under a completely benign field name.
 *   - a benign-looking local env key (`DATABASE_URL`, `SENTRY_DSN`,
 *     `WEBHOOK_URL`) routinely carries a full connection string with an
 *     embedded password.
 *   - a positional stdio arg can be a bare provider token (`sk-...`,
 *     `ghp_...`, `xoxb-...`, `AKIA...`, a JWT) with no flag at all.
 *
 * Contract enforced here: a single conservative `looksLikeCredential`
 * shape check is applied to the native MCP URL, static local env values,
 * and args. Benign configuration survives untouched, and warnings name
 * only the field / server / reason — never the offending value.
 *
 * Run: npx vitest run test/local/mcp-loader-credentials.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { translateMcpConfigForCodex, looksLikeCredential } from "../../src/mcp-loader.ts";

/** Dummy secret bytes that must never appear in output or warnings. */
const SECRETS = {
    urlPassword: "URLPASS-DO-NOT-LEAK-11111",
    urlUser: "URLUSER-DO-NOT-LEAK-22222",
    queryToken: "QUERYTOKEN-DO-NOT-LEAK-33333",
    pgPassword: "PGPASS-DO-NOT-LEAK-44444",
    redisPassword: "REDISPASS-DO-NOT-LEAK-55555",
    mongoPassword: "MONGOPASS-DO-NOT-LEAK-66666",
    sentryKey: "SENTRYKEY-DO-NOT-LEAK-77777",
    webhookPath: "WEBHOOKPATH-DO-NOT-LEAK-88888",
    sqlPassword: "SQLPASS-DO-NOT-LEAK-99999",
};

describe("looksLikeCredential (reusable shape check)", () => {
    const credentialish = [
        "sk-proj-4eC39HqLyjWDarjtT1zdp7dcAbCdEfGhIjKlMnOp",
        "pk_live_51H8xkLJ2eZvKYlo2CabCdEfGhIjKlMnOp",
        "rk_" + "live_51H8xkLJ2eZvKYlo2CabCdEfGhIjKlMnOp",
        "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
        "github_pat_11ABCDEFG0abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef",
        "xox" + "b-2154537954-2154537955-abcdefghijklmnopqrstuvwx",
        "AKIAIOSFODNN7EXAMPLE",
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        "postgres://user:pw123456@db:5432/app",
        "Server=db;Database=app;User Id=sa;Password=hunter2;",
        "-----BEGIN RSA PRIVATE KEY-----",
        "https://example.com/mcp?api_key=abc123",
    ];

    const benign = [
        "",
        "production",
        "debug",
        "https://api.example.com/v1",
        "https://example.com/mcp?region=us-east-1&keyspace=main",
        "30000",
        "alpha,beta",
        "/srv/app/server.js",
        "--log-level=debug",
        "1a2b3c4d5e6f7890abcdef1234567890abcdef12",
    ];

    for (const value of credentialish) {
        it(`flags ${JSON.stringify(value.slice(0, 24))}…`, () => {
            expect(looksLikeCredential(value)).toBe(true);
        });
    }

    for (const value of benign) {
        it(`does not flag ${JSON.stringify(value)}`, () => {
            expect(looksLikeCredential(value)).toBe(false);
        });
    }
});

describe("Codex-native MCP config: credential-shaped URL rejection", () => {
    let warnSpy;
    let warnings;

    beforeEach(() => {
        warnings = [];
        warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
            warnings.push(args.map((a) => String(a)).join(" "));
        });
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    function warnText() {
        return warnings.join("\n");
    }

    it("drops a server whose URL embeds userinfo credentials", () => {
        const out = translateMcpConfigForCodex({
            api: {
                type: "http",
                url: `https://${SECRETS.urlUser}:${SECRETS.urlPassword}@example.com/mcp`,
                tools: ["*"],
            },
        });

        expect(out.api).toBeUndefined();
        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain(SECRETS.urlPassword);
        expect(serialized).not.toContain(SECRETS.urlUser);
        expect(warnText()).toMatch(/api/);
        expect(warnText()).not.toContain(SECRETS.urlPassword);
        expect(warnText()).not.toContain(SECRETS.urlUser);
    });

    it("drops a server whose URL embeds bare userinfo (no password component)", () => {
        const out = translateMcpConfigForCodex({
            api: { type: "http", url: `https://${SECRETS.urlUser}@example.com/mcp`, tools: ["*"] },
        });

        expect(out.api).toBeUndefined();
        expect(JSON.stringify(out)).not.toContain(SECRETS.urlUser);
        expect(warnText()).not.toContain(SECRETS.urlUser);
    });

    const sensitiveParams = [
        "api_key", "apikey", "apiKey", "X-Api-Key",
        "token", "access_token", "accessToken", "refresh_token",
        "key", "secret", "client_secret", "password", "passwd",
        "auth", "authorization", "bearer",
        "signature", "sig", "credential", "credentials",
    ];

    for (const param of sensitiveParams) {
        it(`drops a server whose URL carries a sensitive query parameter "${param}"`, () => {
            const out = translateMcpConfigForCodex({
                api: {
                    type: "http",
                    url: `https://example.com/mcp?${param}=${SECRETS.queryToken}`,
                    tools: ["*"],
                },
            });

            expect(out.api).toBeUndefined();
            expect(JSON.stringify(out)).not.toContain(SECRETS.queryToken);
            expect(warnText()).not.toContain(SECRETS.queryToken);
        });
    }

    it("preserves benign query parameters verbatim", () => {
        const url = "https://example.com/mcp?region=us-east-1&verbose=true&keyspace=main&format=json";
        const out = translateMcpConfigForCodex({
            api: { type: "http", url, tools: ["*"] },
        });

        expect(out.api).toBeTruthy();
        expect(out.api.url).toBe(url);
    });

    it("preserves a plain benign URL and its supported header forms", () => {
        const out = translateMcpConfigForCodex({
            api: {
                type: "http",
                url: "https://api.example.com/mcp",
                headers: { "X-Api-Key": "${CTX7_API_KEY}", "X-Static-Info": "public" },
                tools: ["query"],
            },
        });

        expect(out.api.url).toBe("https://api.example.com/mcp");
        expect(out.api.env_http_headers).toEqual({ "X-Api-Key": "CTX7_API_KEY" });
        expect(out.api.http_headers).toEqual({ "X-Static-Info": "public" });
        expect(out.api.enabled_tools).toEqual(["query"]);
    });
});

describe("Codex-native MCP config: credential-shaped local env rejection", () => {
    let warnSpy;
    let warnings;

    beforeEach(() => {
        warnings = [];
        warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
            warnings.push(args.map((a) => String(a)).join(" "));
        });
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    const credentialEnvCases = [
        ["DATABASE_URL", `postgres://appuser:${SECRETS.pgPassword}@db.internal:5432/app`, SECRETS.pgPassword],
        ["REDIS_URL", `redis://:${SECRETS.redisPassword}@redis.internal:6379/0`, SECRETS.redisPassword],
        ["MONGODB_URI", `mongodb+srv://appuser:${SECRETS.mongoPassword}@cluster0.mongodb.net/app`, SECRETS.mongoPassword],
        ["SENTRY_DSN", `https://${SECRETS.sentryKey}@o12345.ingest.sentry.io/678`, SECRETS.sentryKey],
        ["WEBHOOK_URL", `https://hooks.example.com/services/T000/B000/${SECRETS.webhookPath}`, SECRETS.webhookPath],
        ["CONNECTION_STRING", `Server=db;Database=app;User Id=sa;Password=${SECRETS.sqlPassword};`, SECRETS.sqlPassword],
        ["PRIMARY_STORAGE", `DefaultEndpointsProtocol=https;AccountName=x;AccountKey=${SECRETS.sqlPassword};`, SECRETS.sqlPassword],
    ];

    for (const [key, value, secret] of credentialEnvCases) {
        it(`drops static local env "${key}" carrying a credential-bearing value`, () => {
            const out = translateMcpConfigForCodex({
                local: { type: "stdio", command: "node", args: ["server.js"], env: { [key]: value }, tools: ["*"] },
            });

            expect(out.local).toBeTruthy();
            expect(out.local.env?.[key]).toBeUndefined();
            const serialized = JSON.stringify(out);
            expect(serialized).not.toContain(secret);
            const warnText = warnings.join("\n");
            expect(warnText).toMatch(new RegExp(key));
            expect(warnText).toMatch(/local/);
            expect(warnText).not.toContain(secret);
        });
    }

    it("drops static local env carrying bare provider token shapes regardless of key name", () => {
        const shaped = {
            SERVICE_HANDLE: "sk-live-4eC39HqLyjWDarjtT1zdp7dcAbCdEfGh",
            BUILD_REF: "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
            NOTIFY_CHANNEL: "xox" + "b-2154537954-2154537955-abcdefghijklmnopqrstuvwx",
            DEPLOY_ID: "AKIAIOSFODNN7EXAMPLE",
            SESSION_BLOB: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        };
        const out = translateMcpConfigForCodex({
            local: { type: "stdio", command: "node", args: ["server.js"], env: shaped, tools: ["*"] },
        });

        expect(out.local).toBeTruthy();
        const serialized = JSON.stringify(out);
        for (const [key, value] of Object.entries(shaped)) {
            expect(out.local.env?.[key]).toBeUndefined();
            expect(serialized).not.toContain(value);
        }
    });

    it("preserves benign static local env values and non-credential endpoints", () => {
        const out = translateMcpConfigForCodex({
            local: {
                type: "stdio",
                command: "node",
                args: ["server.js"],
                env: {
                    NODE_ENV: "production",
                    LOG_LEVEL: "debug",
                    SERVICE_ENDPOINT: "https://api.example.com/v1",
                    REQUEST_TIMEOUT_MS: "30000",
                    FEATURE_FLAGS: "alpha,beta",
                },
                tools: ["*"],
            },
        });

        expect(out.local.env).toEqual({
            NODE_ENV: "production",
            LOG_LEVEL: "debug",
            SERVICE_ENDPOINT: "https://api.example.com/v1",
            REQUEST_TIMEOUT_MS: "30000",
            FEATURE_FLAGS: "alpha,beta",
        });
    });
});

describe("Codex-native MCP config: credential-shaped arg rejection", () => {
    let warnSpy;
    let warnings;

    beforeEach(() => {
        warnings = [];
        warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
            warnings.push(args.map((a) => String(a)).join(" "));
        });
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    const credentialArgs = [
        ["OpenAI-style secret key", "sk-proj-4eC39HqLyjWDarjtT1zdp7dcAbCdEfGhIjKlMnOp"],
        ["Stripe publishable key", "pk_live_51H8xkLJ2eZvKYlo2CabCdEfGhIjKlMnOp"],
        ["Stripe restricted key", "rk_" + "live_51H8xkLJ2eZvKYlo2CabCdEfGhIjKlMnOp"],
        ["GitHub classic PAT", "ghp_16C7e42F292c6912E7710c838347Ae178B4a"],
        ["GitHub fine-grained PAT", "github_pat_11ABCDEFG0abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef"],
        ["Slack bot token", "xox" + "b-2154537954-2154537955-abcdefghijklmnopqrstuvwx"],
        ["AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
        ["JWT", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"],
        ["URL with userinfo", `https://svc:${SECRETS.urlPassword}@api.example.com/mcp`],
        ["URL with api_key query param", `https://api.example.com/mcp?api_key=${SECRETS.queryToken}`],
    ];

    for (const [label, value] of credentialArgs) {
        it(`drops the whole local server when a positional arg is a ${label}`, () => {
            const out = translateMcpConfigForCodex({
                local: { type: "stdio", command: "node", args: ["server.js", value], tools: ["*"] },
            });

            expect(out.local).toBeUndefined();
            expect(JSON.stringify(out)).not.toContain(value);
            const warnText = warnings.join("\n");
            expect(warnText).toMatch(/local/);
            expect(warnText).not.toContain(value);
        });
    }

    it("still drops the server for env references and sensitive flag forms", () => {
        const envRef = translateMcpConfigForCodex({
            local: { type: "stdio", command: "node", args: ["server.js", "${SOME_HEADER_TOKEN}"], tools: ["*"] },
        });
        expect(envRef.local).toBeUndefined();

        const flag = translateMcpConfigForCodex({
            local: { type: "stdio", command: "node", args: ["server.js", "--api-key", "abc"], tools: ["*"] },
        });
        expect(flag.local).toBeUndefined();

        const inlineFlag = translateMcpConfigForCodex({
            local: { type: "stdio", command: "node", args: ["server.js", "--token=abc"], tools: ["*"] },
        });
        expect(inlineFlag.local).toBeUndefined();
    });

    it("preserves benign args including plain endpoints and numeric/flag values", () => {
        const args = [
            "server.js",
            "--port", "8080",
            "--log-level=debug",
            "--output-format", "json",
            "https://api.example.com/mcp",
            "--max-retries=3",
        ];
        const out = translateMcpConfigForCodex({
            local: { type: "stdio", command: "node", args, cwd: "/srv/app", tools: ["*"] },
        });

        expect(out.local).toBeTruthy();
        expect(out.local.args).toEqual(args);
        expect(out.local.cwd).toBe("/srv/app");
        expect(warnings).toEqual([]);
    });
});
