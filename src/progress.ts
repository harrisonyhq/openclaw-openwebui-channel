import type { OpenClawPluginApi, PluginAgentEventSubscriptionRegistration } from "openclaw/plugin-sdk/plugin-entry";
import { postMessage, type OpenWebUIAccount } from "./api.js";

type AgentEventPayload = Parameters<PluginAgentEventSubscriptionRegistration["handle"]>[0];
type AgentEventStream = AgentEventPayload["stream"];

export interface OpenWebUIProgressEventsConfig {
  enabled?: boolean;
  includeStreams?: string[];
  excludeStreams?: string[];
  includeThinking?: boolean;
  maxMessageChars?: number;
  codeFence?: boolean;
}

interface ProgressTarget {
  accountId: string;
  account: OpenWebUIAccount;
  channelId: string;
  replyToId?: string;
  parentId?: string;
  textChunkLimit: number;
  config: OpenWebUIProgressEventsConfig;
  createdAt: number;
}

const sessionTargets = new Map<string, ProgressTarget>();
const runTargets = new Map<string, ProgressTarget>();
const TARGET_TTL_MS = 2 * 60 * 60 * 1000;

const defaultStreams = new Set<string>([
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

function pruneTargets(): void {
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

export function rememberProgressTarget(sessionKey: string | undefined, target: Omit<ProgressTarget, "createdAt">): void {
  if (!sessionKey) {
    return;
  }
  pruneTargets();
  sessionTargets.set(sessionKey, {
    ...target,
    createdAt: Date.now(),
  });
}

export function forgetProgressTarget(sessionKey: string | undefined): void {
  if (!sessionKey) {
    return;
  }
  sessionTargets.delete(sessionKey);
}

function shouldMirrorEvent(event: AgentEventPayload, target: ProgressTarget): boolean {
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

function chunkText(text: string, limit: number): string[] {
  const safeLimit = Math.max(1, limit);
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += safeLimit) {
    chunks.push(text.slice(index, index + safeLimit));
  }
  return chunks.length > 0 ? chunks : [text];
}

function serializeEvent(event: AgentEventPayload, target: ProgressTarget): string {
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

async function mirrorEvent(event: AgentEventPayload, target: ProgressTarget): Promise<void> {
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

export function registerOpenWebUIProgressEvents(api: OpenClawPluginApi): void {
  const registerAgentEventSubscription =
    api.agent?.events?.registerAgentEventSubscription ??
    api.registerAgentEventSubscription;

  if (typeof registerAgentEventSubscription !== "function") {
    api.logger?.warn?.(
      "[open-webui] progressEvents disabled: this OpenClaw runtime does not expose agent event subscriptions. Upgrade OpenClaw to mirror Control UI events.",
    );
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
      "thinking" as AgentEventStream,
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
