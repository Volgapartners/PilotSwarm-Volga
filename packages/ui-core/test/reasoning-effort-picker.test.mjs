import test from "node:test";
import assert from "node:assert/strict";

import {
    PilotSwarmUiController,
    createInitialState,
    createStore,
    appReducer,
    selectModelPickerModal,
    selectReasoningEffortPickerModal,
} from "../src/index.js";

// ─── Helpers ──────────────────────────────────────────────────────

function buildTransport(overrides = {}) {
    const modelsByProvider = overrides.modelsByProvider || [];
    const flatModels = modelsByProvider.flatMap((group) => group.models || []);
    const defaultModel = overrides.defaultModel;
    return {
        async listSessions() { return []; },
        async listSessionGroups() { return []; },
        async getSession() { return null; },
        async getSessionEvents() { return []; },
        subscribeSession() { return () => {}; },
        async listModels() { return flatModels; },
        getModelsByProvider() { return modelsByProvider; },
        getDefaultModel() { return defaultModel; },
        async listCreatableAgents() { return overrides.agents || []; },
        getSessionCreationPolicy() {
            return overrides.sessionPolicy || { creation: { allowGeneric: true } };
        },
        async createSession(options) {
            (overrides.createSessionCalls || []).push(options);
            return { sessionId: "new-session" };
        },
        async createSessionForAgent(agentName, options) {
            (overrides.createSessionForAgentCalls || []).push({ agentName, options });
            return { sessionId: "new-agent-session" };
        },
    };
}

function makeGroup(providerId, models) {
    return { providerId, type: "codex", models };
}

// ─── Zero-effort path ─────────────────────────────────────────────

test("openReasoningEffortPicker: 0 supported efforts skips picker and opens agent picker with just model", async () => {
    const store = createStore(appReducer, createInitialState());
    const createSessionCalls = [];
    const controller = new PilotSwarmUiController({
        store,
        transport: buildTransport({
            agents: [],
            createSessionCalls,
        }),
    });

    controller.openReasoningEffortPicker(
        { id: "codex:gpt-x", modelName: "gpt-x", supportedReasoningEfforts: [], defaultReasoningEffort: null },
        { model: "codex:gpt-x" },
    );

    // Give the async openNewSessionFlow chain time to run.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(store.getState().ui.modal, null, "reasoning effort picker must not open when 0 efforts are supported");
    // No agents → falls back to createSession with model only.
    assert.equal(createSessionCalls.length, 1);
    assert.equal(createSessionCalls[0].model, "codex:gpt-x");
    assert.equal(createSessionCalls[0].reasoningEffort, undefined);
});

// ─── Single-effort path (currently RED) ──────────────────────────

test("openReasoningEffortPicker: exactly 1 supported effort skips picker and applies it automatically", async () => {
    const store = createStore(appReducer, createInitialState());
    const createSessionCalls = [];
    const controller = new PilotSwarmUiController({
        store,
        transport: buildTransport({
            agents: [],
            createSessionCalls,
        }),
    });

    controller.openReasoningEffortPicker(
        {
            id: "codex:gpt-solo",
            modelName: "gpt-solo",
            supportedReasoningEfforts: ["high"],
            defaultReasoningEffort: "high",
        },
        { model: "codex:gpt-solo" },
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(store.getState().ui.modal, null, "should not open a picker for a single supported effort");
    assert.equal(createSessionCalls.length, 1);
    assert.equal(createSessionCalls[0].model, "codex:gpt-solo");
    assert.equal(createSessionCalls[0].reasoningEffort, "high", "the sole supported effort must be applied");
});

// ─── Multi-effort path opens picker, highlights default ──────────

test("openReasoningEffortPicker: multi-effort opens picker with default preselected and restricted to supported", () => {
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({
        store,
        transport: buildTransport({}),
    });

    controller.openReasoningEffortPicker(
        {
            id: "codex:gpt-5.6-terra",
            modelName: "gpt-5.6-terra",
            providerId: "codex",
            providerType: "codex",
            supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
            defaultReasoningEffort: "medium",
        },
        { model: "codex:gpt-5.6-terra" },
    );

    const modal = store.getState().ui.modal;
    assert.equal(modal?.type, "reasoningEffortPicker");
    const presentation = selectReasoningEffortPickerModal(store.getState(), 64);
    assert.ok(presentation, "presentation selector must produce a modal payload");
    assert.equal(presentation.rows.length, 4, "row list must be restricted to supported efforts");
    const efforts = modal.items.map((item) => item.id);
    assert.deepEqual(efforts, ["low", "medium", "high", "xhigh"]);
    // Default (medium) should be preselected.
    assert.equal(modal.items[modal.selectedIndex].id, "medium");
    assert.equal(modal.items[modal.selectedIndex].isDefault, true);
});

// ─── Propagation into named-agent creation (Shift+N flow) ─────────

test("model → effort → named-agent flow propagates reasoningEffort into createSessionForAgent", async () => {
    const store = createStore(appReducer, createInitialState());
    const createSessionForAgentCalls = [];
    const controller = new PilotSwarmUiController({
        store,
        transport: buildTransport({
            agents: [{ name: "researcher", title: "Researcher", description: "Deep research" }],
            createSessionForAgentCalls,
        }),
    });

    // Step 1: model picker (mimics Shift+N).
    controller.dispatch({
        type: "ui/modal",
        modal: {
            type: "modelPicker",
            title: "Select model for new session",
            items: [
                {
                    id: "codex:gpt-5.5",
                    qualifiedName: "codex:gpt-5.5",
                    modelName: "gpt-5.5",
                    providerId: "codex",
                    providerType: "codex",
                    cost: "medium",
                    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
                    defaultReasoningEffort: "medium",
                    isDefault: true,
                },
            ],
            groups: [makeGroup("codex", [
                {
                    id: "codex:gpt-5.5",
                    qualifiedName: "codex:gpt-5.5",
                    modelName: "gpt-5.5",
                    cost: "medium",
                    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
                    defaultReasoningEffort: "medium",
                    isDefault: true,
                },
            ])],
            selectedIndex: 0,
        },
    });

    await controller.confirmModal();
    // Should now be in reasoningEffortPicker.
    let modal = store.getState().ui.modal;
    assert.equal(modal?.type, "reasoningEffortPicker");
    assert.equal(modal.items[modal.selectedIndex].id, "medium");

    // Step 2: change to "high" and accept.
    const highIndex = modal.items.findIndex((item) => item.id === "high");
    assert.ok(highIndex >= 0);
    controller.dispatch({ type: "ui/modalSelection", index: highIndex });
    await controller.confirmModal();

    // Should now be in sessionAgentPicker, with reasoningEffort=high queued.
    modal = store.getState().ui.modal;
    assert.equal(modal?.type, "sessionAgentPicker");
    assert.equal(modal.sessionOptions?.model, "codex:gpt-5.5");
    assert.equal(modal.sessionOptions?.reasoningEffort, "high");

    // Step 3: pick the named agent.
    const agentIndex = modal.items.findIndex((item) => item.kind === "agent");
    assert.ok(agentIndex >= 0);
    controller.dispatch({ type: "ui/modalSelection", index: agentIndex });
    await controller.confirmModal();

    assert.equal(createSessionForAgentCalls.length, 1);
    assert.equal(createSessionForAgentCalls[0].agentName, "researcher");
    assert.equal(createSessionForAgentCalls[0].options.model, "codex:gpt-5.5");
    assert.equal(createSessionForAgentCalls[0].options.reasoningEffort, "high",
        "chosen reasoning effort must reach createSessionForAgent");
});

// ─── Cancel returns safely ────────────────────────────────────────

test("closing the reasoning effort picker cancels safely without creating a session", async () => {
    const store = createStore(appReducer, createInitialState());
    const createSessionCalls = [];
    const createSessionForAgentCalls = [];
    const controller = new PilotSwarmUiController({
        store,
        transport: buildTransport({
            createSessionCalls,
            createSessionForAgentCalls,
        }),
    });

    controller.openReasoningEffortPicker(
        {
            id: "codex:gpt-5.4-mini",
            modelName: "gpt-5.4-mini",
            supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
            defaultReasoningEffort: "medium",
        },
        { model: "codex:gpt-5.4-mini" },
    );
    assert.equal(store.getState().ui.modal?.type, "reasoningEffortPicker");

    controller.closeModal();

    assert.equal(store.getState().ui.modal, null);
    assert.equal(createSessionCalls.length, 0);
    assert.equal(createSessionForAgentCalls.length, 0);
});

// ─── Cost vs reasoning label disambiguation ───────────────────────

test("model picker row labels prefix cost with an explicit 'cost:' tag so it is not mistaken for reasoning effort", () => {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({
        type: "ui/modal",
        modal: {
            type: "modelPicker",
            title: "Select model for new session",
            items: [
                {
                    id: "codex:gpt-5.5",
                    qualifiedName: "codex:gpt-5.5",
                    modelName: "gpt-5.5",
                    providerId: "codex",
                    providerType: "codex",
                    cost: "medium",
                    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
                    defaultReasoningEffort: "medium",
                    isDefault: true,
                },
            ],
            groups: [makeGroup("codex", [
                {
                    id: "codex:gpt-5.5",
                    qualifiedName: "codex:gpt-5.5",
                    modelName: "gpt-5.5",
                    cost: "medium",
                    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
                    defaultReasoningEffort: "medium",
                    isDefault: true,
                },
            ])],
            selectedIndex: 0,
        },
    });

    const presentation = selectModelPickerModal(store.getState(), 96);
    assert.ok(presentation, "modelPicker presentation must exist");
    const rowText = (row) => (Array.isArray(row)
        ? row.map((run) => String(run?.text || "")).join("")
        : String(row?.text || ""));
    const modelRow = presentation.rows.find((row) => rowText(row).includes("gpt-5.5"));
    assert.ok(modelRow, "expected a rendered row for gpt-5.5");
    const modelRowText = rowText(modelRow);
    assert.ok(
        /cost:\s*medium/i.test(modelRowText),
        `row must label cost explicitly (got ${JSON.stringify(modelRowText)})`,
    );
    assert.ok(
        !/\s\[medium\]/.test(modelRowText),
        `row must not use ambiguous bare '[medium]' label (got ${JSON.stringify(modelRowText)})`,
    );

    const detailsText = presentation.detailsLines
        .map((line) => (Array.isArray(line) ? line.map((run) => run.text).join("") : String(line?.text || "")))
        .join("\n");
    assert.match(detailsText, /Cost:\s*medium/, "details pane must show a distinct Cost line");
    assert.match(detailsText, /Reasoning:\s*low, medium, high, xhigh/, "details pane must show a distinct Reasoning line");
    assert.match(detailsText, /Default reasoning:\s*medium/, "details pane must show the default reasoning line");
});
