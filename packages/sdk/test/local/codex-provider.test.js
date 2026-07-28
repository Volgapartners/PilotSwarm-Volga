/**
 * Codex provider registry tests.
 *
 * type=codex represents a Codex-backed runtime that talks to a locally
 * running `codex app-server` process. In subscription mode there is no
 * apiKey — auth is handled out-of-band by the ChatGPT/Codex login on the
 * operator's machine — so the registry must accept the provider without
 * an apiKey/baseUrl, resolve() must return codexRuntime config (not
 * sdkProvider), and getModelSummaryForLLM must render the qualified
 * name in the standard `provider:model` shape.
 *
 * Run: npx vitest run test/local/codex-provider.test.js
 */

import { describe, it, expect } from "vitest";
import { ModelProviderRegistry } from "../../src/model-providers.ts";

describe("Codex provider (subscription)", () => {
    it("accepts type=codex without apiKey and resolves to codexRuntime", () => {
        const registry = new ModelProviderRegistry({
            providers: [
                {
                    id: "codex-subscription",
                    type: "codex",
                    codexHome: "/tmp/codex-home-test",
                    models: [
                        { name: "gpt-5.6-sol", description: "Codex Sonnet", cost: "medium" },
                    ],
                },
            ],
            defaultModel: "codex-subscription:gpt-5.6-sol",
        });

        const descriptor = registry.getDescriptor("codex-subscription:gpt-5.6-sol");
        expect(descriptor).toBeTruthy();
        expect(descriptor.providerId).toBe("codex-subscription");
        expect(descriptor.providerType).toBe("codex");
        expect(descriptor.modelName).toBe("gpt-5.6-sol");

        const resolved = registry.resolve("codex-subscription:gpt-5.6-sol");
        expect(resolved).toBeTruthy();
        expect(resolved.type).toBe("codex");
        expect(resolved.modelName).toBe("gpt-5.6-sol");
        // subscription mode: no apiKey / sdkProvider / githubToken
        expect(resolved.sdkProvider).toBeUndefined();
        expect(resolved.githubToken).toBeUndefined();
        // codexRuntime carries the codexHome for the runtime adapter
        expect(resolved.codexRuntime).toBeTruthy();
        expect(resolved.codexRuntime.codexHome).toBe("/tmp/codex-home-test");
    });

    it("normalizes bare model names against a codex provider", () => {
        const registry = new ModelProviderRegistry({
            providers: [
                {
                    id: "codex-subscription",
                    type: "codex",
                    codexHome: "/tmp/codex-home-test",
                    models: ["gpt-5.6-sol"],
                },
            ],
        });
        expect(registry.normalize("gpt-5.6-sol")).toBe("codex-subscription:gpt-5.6-sol");
    });

    it("does not filter codex providers out for missing apiKey", () => {
        // Non-github/non-codex providers with no apiKey are filtered from
        // the registry. codex has no apiKey by design; it must survive.
        const registry = new ModelProviderRegistry({
            providers: [
                {
                    id: "codex-subscription",
                    type: "codex",
                    codexHome: "env:CODEX_HOME_MAY_NOT_EXIST_XYZ",
                    models: ["gpt-5.6-sol"],
                },
            ],
        });
        const providers = registry.allProviders;
        expect(providers.map((p) => p.id)).toContain("codex-subscription");
    });

    it("renders codex models in the LLM model summary", () => {
        const registry = new ModelProviderRegistry({
            providers: [
                {
                    id: "codex-subscription",
                    type: "codex",
                    codexHome: "/tmp/codex-home-test",
                    models: [
                        { name: "gpt-5.6-sol", description: "Codex sub", cost: "medium" },
                    ],
                },
            ],
        });
        const summary = registry.getModelSummaryForLLM();
        expect(summary).toContain("codex-subscription");
        expect(summary).toContain("codex-subscription:gpt-5.6-sol");
    });
});
