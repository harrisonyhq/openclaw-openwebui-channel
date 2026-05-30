import { postMessage } from "./api.js";
const sessionTargets = new Map();
const runTargets = new Map();
const TARGET_TTL_MS = 2 * 60 * 60 * 1000;
const defaultStreams = new Set([
    "lifecycle",
    "tool",
    "assistant",
    "error",
    "item",
    "plan",
    "approval",
    "command_output",
    "patch",
    "compaction",
]);
function pruneTargets() {
    const cutoff = Date.now() - TARGET_TTL_MS;
    for (const [key, target] of sessionTargets.entries()) {
        if (target.createdAt < cutoff) {
            sessionTargets.delete(key);
        }
    }
    for (const [key, target] of runTargets.entries()) {
        if (target.createdAt < cutoff) {
            runTargets.delete(key);
        }
    }
}
export function rememberProgressTarget(sessionKey, target) {
    if (!sessionKey) {
        return;
    }
    pruneTargets();
    sessionTargets.set(sessionKey, {
        ...target,
        createdAt: Date.now(),
    });
}
export function forgetProgressTarget(sessionKey) {
    if (!sessionKey) {
        return;
    }
    sessionTargets.delete(sessionKey);
}
function shouldMirrorEvent(event, target) {
    const config = target.config ?? {};
    if (config.enabled !== true) {
        return false;
    }
    if (event.stream === "thinking" && config.includeThinking !== true) {
        return false;
    }
    const include = Array.isArray(config.includeStreams) && config.includeStreams.length > 0
        ? new Set(config.includeStreams)
        : defaultStreams;
    if (!include.has(event.stream)) {
        return false;
    }
    const exclude = Array.isArray(config.excludeStreams) ? new Set(config.excludeStreams) : undefined;
    if (exclude?.has(event.stream)) {
        return false;
    }
    return true;
}
function chunkText(text, limit) {
    const safeLimit = Math.max(1, limit);
    const chunks = [];
    for (let index = 0; index < text.length; index += safeLimit) {
        chunks.push(text.slice(index, index + safeLimit));
    }
    return chunks.length > 0 ? chunks : [text];
}
function serializeEvent(event, target) {
    const serializable = {
        runId: event.runId,
        seq: event.seq,
        stream: event.stream,
        ts: event.ts,
        sessionKey: event.sessionKey,
        data: event.data,
    };
    const json = JSON.stringify(serializable, null, 2);
    const maxChars = target.config.maxMessageChars;
    const content = typeof maxChars === "number" && maxChars > 0 && json.length > maxChars
        ? `${json.slice(0, maxChars)}\n... truncated by open-webui progressEvents.maxMessageChars ...`
        : json;
    if (target.config.codeFence === false) {
        return content;
    }
    return `\`\`\`json\n${content}\n\`\`\``;
}
async function mirrorEvent(event, target) {
    if (!shouldMirrorEvent(event, target)) {
        return;
    }
    const content = serializeEvent(event, target);
    const chunks = chunkText(content, target.textChunkLimit);
    for (const chunk of chunks) {
        await postMessage(target.account, target.channelId, chunk || " ", {
            replyToId: target.replyToId,
            parentId: target.parentId,
            meta: {
                openclaw_event: true,
                openclaw_run_id: event.runId,
                openclaw_event_seq: event.seq,
                openclaw_event_stream: event.stream,
            },
        });
    }
}
export function registerOpenWebUIProgressEvents(api) {
    const registerAgentEventSubscription = api.agent?.events?.registerAgentEventSubscription ??
        api.registerAgentEventSubscription;
    if (typeof registerAgentEventSubscription !== "function") {
        api.logger?.warn?.("[open-webui] progressEvents disabled: this OpenClaw runtime does not expose agent event subscriptions. Upgrade OpenClaw to mirror Control UI events.");
        return;
    }
    registerAgentEventSubscription({
        id: "open-webui-control-ui-event-mirror",
        description: "Mirror OpenClaw agent events for Open WebUI-originated runs back to the Open WebUI channel.",
        streams: [
            "lifecycle",
            "tool",
            "assistant",
            "error",
            "item",
            "plan",
            "approval",
            "command_output",
            "patch",
            "compaction",
            "thinking",
        ],
        handle: async (event) => {
            pruneTargets();
            if (event.sessionKey) {
                const sessionTarget = sessionTargets.get(event.sessionKey);
                if (sessionTarget) {
                    runTargets.set(event.runId, sessionTarget);
                }
            }
            const target = runTargets.get(event.runId);
            if (!target) {
                return;
            }
            await mirrorEvent(event, target);
            if (event.stream === "lifecycle") {
                const phase = typeof event.data.phase === "string" ? event.data.phase : undefined;
                if (phase === "end" || phase === "error") {
                    runTargets.delete(event.runId);
                }
            }
        },
    });
}
