import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getOpenWebUIRuntime } from "./runtime.js";
import { postMessage, getAuthToken, getMessageById, addReaction, removeReaction, uploadFile, downloadFileContent, getChannels, } from "./api.js";
import { connectSocket, disconnectSocket, getConnection } from "./socket.js";
import { forgetProgressTarget, rememberProgressTarget } from "./progress.js";
// Plugin metadata
const meta = {
    id: "open-webui",
    label: "Open WebUI",
    selectionLabel: "Open WebUI (Channels)",
    docsPath: "https://github.com/harrisonyhq/openclaw-openwebui-channel#readme",
    docsLabel: "GitHub README",
    blurb: "Open WebUI channels integration via REST API and Socket.IO.",
};
function resolveOpenWebUIAccount(cfg, accountId) {
    const channelCfg = cfg.channels?.["open-webui"];
    const baseUrl = channelCfg?.baseUrl ?? "";
    const email = channelCfg?.email ?? "";
    const password = channelCfg?.password ?? "";
    const userId = channelCfg?.userId;
    const enabled = channelCfg?.enabled ?? true;
    const channelIds = channelCfg?.channelIds ?? [];
    const requireMention = channelCfg?.requireMention ?? true;
    const name = channelCfg?.name;
    return {
        accountId: accountId ?? "default",
        baseUrl,
        email,
        password,
        userId,
        enabled,
        configured: Boolean(baseUrl && email && password),
        channelIds,
        requireMention,
        name,
        config: channelCfg ?? {},
    };
}
function getAccountFromResolved(account) {
    return {
        baseUrl: account.baseUrl,
        email: account.email,
        password: account.password,
        userId: account.userId,
    };
}
function resolvePeerId(params) {
    const base = params.parentId ? `${params.channelId}:${params.parentId}` : params.channelId;
    if (params.isDm) {
        return base;
    }
    const scope = params.scope ?? "user";
    if (scope === "channel") {
        return base;
    }
    if (scope === "message") {
        return `${base}:message:${params.messageId}`;
    }
    return `${base}:user:${params.senderId}`;
}
// Track per-account state (bot user ID + channel name cache)
const accountBotUserId = new Map();
const channelNameCache = new Map(); // key: "accountId:channelId"
function coerceOutboundMedia(payload) {
    const candidates = [
        payload.media,
        payload.mediaFiles,
        payload.attachments,
        payload.files,
    ].find((value) => Array.isArray(value) && value.length > 0);
    if (!candidates) {
        return [];
    }
    const items = [];
    for (const entry of candidates) {
        if (typeof entry === "string") {
            items.push({ path: entry });
            continue;
        }
        if (entry && typeof entry === "object") {
            const record = entry;
            const path = (record.path ?? record.filePath ?? record.file_path);
            if (!path) {
                continue;
            }
            items.push({
                path,
                filename: (record.filename ?? record.name),
                mimeType: (record.mimeType ?? record.mime_type ?? record.type),
            });
        }
    }
    return items;
}
function extractReactionPayload(payload) {
    const reactionValue = payload.reaction ??
        payload.reactionName ??
        payload.emoji;
    if (!reactionValue) {
        return null;
    }
    const typeValue = payload.type;
    const kindValue = payload.kind;
    const actionValue = payload.action;
    const isReaction = payload.reaction != null ||
        typeValue === "reaction" ||
        kindValue === "reaction" ||
        actionValue === "reaction" ||
        actionValue === "add" ||
        actionValue === "remove";
    if (!isReaction) {
        return null;
    }
    const messageId = payload.messageId ??
        payload.replyToId ??
        payload.reply_to_id;
    const action = payload.action ??
        payload.reactionAction;
    return { emoji: reactionValue, messageId, action };
}
/** Wrap a raw upload response into the format Open WebUI's frontend expects in data.files */
function wrapUploadedFile(uploaded) {
    return {
        type: "file",
        file: uploaded,
        id: uploaded.id,
        url: uploaded.id,
        name: uploaded.filename ?? uploaded.meta?.name ?? uploaded.name ?? "file",
        collection_name: uploaded.meta?.collection_name ?? "",
        content_type: uploaded.meta?.content_type ?? uploaded.type ?? uploaded.mime_type ?? "application/octet-stream",
        status: "uploaded",
        size: uploaded.size ?? 0,
    };
}
function sanitizeFilename(value) {
    return value.replace(/[\/\\]+/g, "_");
}
async function persistInboundMedia(core, file) {
    // Ensure buffer is a proper Node.js Buffer (undici fetch ArrayBuffer workaround)
    let safeBuffer;
    if (Buffer.isBuffer(file.buffer)) {
        safeBuffer = file.buffer;
    }
    else if (file.buffer instanceof ArrayBuffer || file.buffer?.byteLength !== undefined) {
        safeBuffer = Buffer.from(new Uint8Array(file.buffer));
    }
    else {
        // Last resort: try converting whatever we got
        safeBuffer = Buffer.from(file.buffer);
    }
    const saveMediaBuffer = core?.channel?.media?.saveMediaBuffer;
    if (typeof saveMediaBuffer === "function") {
        // saveMediaBuffer signature: (buffer, contentType, subdir, maxBytes, originalFilename)
        // Pass undefined for maxBytes to use OpenClaw's default limit
        const saved = await saveMediaBuffer(safeBuffer, file.mimeType, "inbound", undefined, file.filename);
        if (typeof saved === "string") {
            return saved;
        }
        if (saved && typeof saved === "object") {
            const maybePath = saved.path;
            const maybeUrl = saved.url;
            if (typeof maybePath === "string") {
                return maybePath;
            }
            if (typeof maybeUrl === "string") {
                return maybeUrl;
            }
        }
    }
    const shortId = sanitizeFilename(file.id).slice(0, 8);
    const dir = join(tmpdir(), "open-webui", shortId);
    await mkdir(dir, { recursive: true });
    const filename = sanitizeFilename(file.filename ?? `file-${file.id}`);
    const filePath = join(dir, filename);
    await writeFile(filePath, safeBuffer);
    return filePath;
}
async function resolveInboundMedia(account, core, rawData, log) {
    const files = rawData?.files ?? [];
    if (!Array.isArray(files) || files.length === 0) {
        return [];
    }
    const tasks = files.map(async (file) => {
        const fileId = file?.id;
        if (!fileId) {
            return null;
        }
        try {
            const downloaded = await downloadFileContent(account, fileId);
            const path = await persistInboundMedia(core, {
                id: fileId,
                buffer: downloaded.buffer,
                filename: downloaded.filename ?? file.filename ?? file.name,
                mimeType: downloaded.mimeType ?? file.mime_type ?? file.type,
            });
            return {
                id: fileId,
                path,
                filename: downloaded.filename ?? file.filename ?? file.name,
                mimeType: downloaded.mimeType ?? file.mime_type ?? file.type,
                size: file.size,
            };
        }
        catch (err) {
            log?.warn(`[open-webui] Failed to download file ${fileId}: ${String(err)}\n${err?.stack ?? ''}`);
            return null;
        }
    });
    const results = await Promise.all(tasks);
    return results.filter(Boolean);
}
export const openWebUIPlugin = {
    id: "open-webui",
    meta,
    capabilities: {
        chatTypes: ["direct", "group", "channel"],
        media: true,
        reactions: true,
        threads: true,
    },
    threading: {
        resolveReplyToMode: () => "first",
        buildToolContext: ({ context, hasRepliedRef }) => {
            const threadId = context.MessageThreadId ?? context.ReplyToId;
            return {
                currentChannelId: context.To?.trim() || undefined,
                currentThreadTs: threadId != null ? String(threadId) : undefined,
                hasRepliedRef,
            };
        },
    },
    actions: {
        describeMessageTool: () => ({
            actions: ["send", "react"],
            mediaSourceParams: { send: ["filePath", "mediaUrl", "media"] },
        }),
        supportsAction: ({ action }) => action === "send" || action === "react",
        handleAction: async (ctx) => {
            const params = ctx.params;
            const action = params.action ?? "send";
            // --- React action ---
            if (action === "react") {
                const emoji = params.emoji ?? "";
                const messageId = params.messageId ?? "";
                const remove = params.remove === true;
                const account = resolveOpenWebUIAccount(ctx.cfg);
                const apiAccount = getAccountFromResolved(account);
                // Resolve the Open WebUI channel UUID from channelId, target, or to.
                // The OpenClaw core resolves channelId via resolveActionTarget before
                // calling handleAction, stripping any "open-webui:" prefix.
                const channelId = (params.channelId ?? params.target ?? params.to ?? "").replace(/^open-webui:/i, "").trim();
                if (!emoji) {
                    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Emoji is required" }) }], details: { ok: false } };
                }
                if (!messageId) {
                    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "messageId is required" }) }], details: { ok: false } };
                }
                if (!channelId) {
                    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "channel/target is required" }) }], details: { ok: false } };
                }
                try {
                    if (remove) {
                        const success = await removeReaction(apiAccount, channelId, messageId, emoji);
                        if (!success) {
                            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Failed to remove reaction (API returned non-ok)" }) }], details: { ok: false } };
                        }
                        return { content: [{ type: "text", text: JSON.stringify({ ok: true, removed: emoji }) }], details: { ok: true, removed: emoji } };
                    }
                    else {
                        const success = await addReaction(apiAccount, channelId, messageId, emoji);
                        if (!success) {
                            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Failed to add reaction (API returned non-ok)" }) }], details: { ok: false } };
                        }
                        return { content: [{ type: "text", text: JSON.stringify({ ok: true, added: emoji }) }], details: { ok: true, added: emoji } };
                    }
                }
                catch (err) {
                    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }], details: { ok: false, error: String(err) } };
                }
            }
            // --- Send action ---
            const to = params.target ?? params.to;
            const message = params.message ?? "";
            const mediaUrl = params.filePath ?? params.mediaUrl ?? params.media;
            const replyTo = params.replyTo;
            if (!to) {
                return { content: [{ type: "text", text: "Missing target" }], details: {} };
            }
            const account = resolveOpenWebUIAccount(ctx.cfg);
            const apiAccount = getAccountFromResolved(account);
            // Resolve target (strip open-webui: prefix)
            const normalized = to.replace(/^open-webui:/i, "").trim();
            try {
                const uploadedFiles = [];
                if (mediaUrl) {
                    const uploaded = await uploadFile(apiAccount, mediaUrl);
                    uploadedFiles.push(wrapUploadedFile(uploaded));
                }
                const content = message?.trim() || (uploadedFiles.length > 0 ? " " : "");
                if (!content && uploadedFiles.length === 0) {
                    return { content: [{ type: "text", text: "Nothing to send" }], details: {} };
                }
                const dataPayload = {};
                if (uploadedFiles.length > 0) {
                    dataPayload.files = uploadedFiles;
                }
                // Never set parentId in handleAction. Open WebUI hides messages with
                // a parent_id that doesn't exist in the target channel, and there is
                // no safe way for the agent to know the correct parent_id for a
                // different channel. Use replyTo (reply_to_id) for replies instead.
                const posted = await postMessage(apiAccount, normalized, content || " ", {
                    replyToId: replyTo,
                    data: dataPayload,
                });
                return {
                    content: [{ type: "text", text: JSON.stringify({ ok: true, messageId: posted.id }) }],
                    details: { ok: true, messageId: posted.id },
                };
            }
            catch (err) {
                return {
                    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }],
                    details: { ok: false, error: String(err) },
                };
            }
        },
    },
    reload: { configPrefixes: ["channels.open-webui"] },
    config: {
        listAccountIds: () => ["default"],
        resolveAccount: (cfg, accountId) => resolveOpenWebUIAccount(cfg, accountId),
        defaultAccountId: () => "default",
        setAccountEnabled: ({ cfg, enabled }) => {
            const channels = (cfg.channels ?? {});
            const owui = (channels["open-webui"] ?? {});
            return {
                ...cfg,
                channels: {
                    ...channels,
                    "open-webui": { ...owui, enabled },
                },
            };
        },
        deleteAccount: ({ cfg }) => {
            const channels = (cfg.channels ?? {});
            const { ["open-webui"]: _, ...rest } = channels;
            return { ...cfg, channels: rest };
        },
        isConfigured: (account) => account.configured,
        describeAccount: (account) => ({
            accountId: account.accountId,
            name: account.name ?? "Open WebUI",
            enabled: account.enabled,
            configured: account.configured,
            baseUrl: account.baseUrl,
        }),
        resolveAllowFrom: () => [],
        formatAllowFrom: ({ allowFrom }) => allowFrom.map(String),
    },
    gateway: {
        startAccount: async (ctx) => {
            const account = ctx.account;
            const config = ctx.cfg;
            if (!account.configured) {
                ctx.log?.warn("[open-webui] Not configured, skipping start");
                return;
            }
            if (!account.enabled) {
                ctx.log?.info("[open-webui] Account disabled, skipping start");
                return;
            }
            ctx.log?.info(`[${account.accountId}] starting provider`);
            // Run the monitoring function
            await monitorOpenWebUIProvider({
                account,
                config,
                // Use the plugin-global runtime set during register().
                // (ctx.runtime may be a narrower runtime subset for some plugin contexts.)
                runtime: getOpenWebUIRuntime(),
                abortSignal: ctx.abortSignal,
                statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
                log: ctx.log,
            });
        },
    },
    status: {
        defaultRuntime: {
            accountId: "default",
            running: false,
            lastStartAt: null,
            lastStopAt: null,
            lastError: null,
        },
        buildAccountSnapshot: ({ account, runtime }) => ({
            accountId: account.accountId,
            name: account.name ?? "Open WebUI",
            enabled: account.enabled,
            configured: account.configured,
            baseUrl: account.baseUrl,
            running: runtime?.running ?? false,
            lastStartAt: runtime?.lastStartAt ?? null,
            lastStopAt: runtime?.lastStopAt ?? null,
            lastError: runtime?.lastError ?? null,
        }),
    },
    outbound: {
        deliveryMode: "direct",
        textChunkLimit: 4000,
        resolveTarget: ({ to }) => {
            if (!to)
                return { ok: false, error: new Error("No target specified") };
            const normalized = to.replace(/^open-webui:/i, "");
            if (!/^[a-f0-9-]{36}$/i.test(normalized)) {
                return { ok: false, error: new Error(`Invalid Open WebUI channel ID: ${normalized}`) };
            }
            return { ok: true, to: normalized };
        },
        sendText: async ({ to, text, replyToId, threadId, accountId, cfg }) => {
            const normalizedTo = to.replace(/^open-webui:/i, "");
            const account = resolveOpenWebUIAccount(cfg, accountId);
            const apiAccount = getAccountFromResolved(account);
            const message = await postMessage(apiAccount, normalizedTo, text, {
                replyToId: replyToId ?? undefined,
                parentId: threadId ? String(threadId) : undefined,
            });
            return {
                channel: "open-webui",
                messageId: message.id,
            };
        },
        sendMedia: async ({ to, text, mediaUrl, replyToId, threadId, accountId, cfg }) => {
            const normalizedTo = to.replace(/^open-webui:/i, "");
            const account = resolveOpenWebUIAccount(cfg, accountId);
            const apiAccount = getAccountFromResolved(account);
            const uploadedFiles = [];
            if (mediaUrl) {
                const uploaded = await uploadFile(apiAccount, mediaUrl);
                uploadedFiles.push(uploaded);
            }
            const content = text?.trim() || " ";
            const dataPayload = {};
            if (uploadedFiles.length > 0) {
                dataPayload.files = uploadedFiles.map(wrapUploadedFile);
            }
            const message = await postMessage(apiAccount, normalizedTo, content, {
                replyToId: replyToId ?? undefined,
                parentId: threadId ? String(threadId) : undefined,
                data: dataPayload,
            });
            return {
                channel: "open-webui",
                messageId: message.id,
            };
        },
    },
    messaging: {
        normalizeTarget: (target) => target.replace(/^open-webui:/i, ""),
        targetResolver: {
            looksLikeId: (target, normalized) => {
                const value = normalized ?? target;
                return /^[a-f0-9-]{36}$/i.test(value);
            },
            hint: "<channel_id>",
        },
    },
};
async function monitorOpenWebUIProvider(options) {
    const { account, config, runtime, abortSignal, statusSink, log } = options;
    const apiAccount = getAccountFromResolved(account);
    const core = runtime;
    try {
        // Authenticate and get bot user ID
        const { userId, userName } = await getAuthToken(apiAccount);
        accountBotUserId.set(account.accountId, userId);
        log?.info(`[${account.accountId}] authenticated as ${userName || userId}${userName ? ` (${userId})` : ""}`);
        // Cache channel names for metadata headers (refresh on each provider start)
        // Clear only this account's entries (prefix-based)
        for (const key of channelNameCache.keys()) {
            if (key.startsWith(`${account.accountId}:`))
                channelNameCache.delete(key);
        }
        try {
            const channels = await getChannels(apiAccount);
            for (const ch of channels) {
                if (ch.id && ch.name)
                    channelNameCache.set(`${account.accountId}:${ch.id}`, ch.name);
            }
            log?.info(`[${account.accountId}] cached ${channelNameCache.size} channel names`);
        }
        catch (err) {
            log?.warn(`[${account.accountId}] failed to cache channel names: ${String(err)}`);
        }
        statusSink?.({ running: true });
        // Connect to Socket.IO and handle events
        await connectSocket(apiAccount, async (event) => {
            await handleChannelEvent(event, {
                account,
                config,
                core,
                statusSink,
                log,
            });
        }, log, {
            channelIds: account.channelIds,
            onTerminalDisconnect: () => {
                log?.error(`[${account.accountId}] socket permanently disconnected, stopping provider`);
                statusSink?.({ running: false, lastError: "Socket.IO reconnection failed" });
            },
        });
        log?.info(`[${account.accountId}] connected to Socket.IO, monitoring ${account.channelIds.length || "all"} channels`);
        // Wait for abort signal or terminal socket disconnect
        await new Promise((resolve) => {
            const cleanup = () => {
                log?.info(`[${account.accountId}] disconnecting`);
                disconnectSocket(apiAccount);
                statusSink?.({ running: false });
                resolve();
            };
            if (abortSignal.aborted) {
                cleanup();
                return;
            }
            // Listen for abort
            abortSignal.addEventListener("abort", cleanup, { once: true });
            // Listen for terminal socket disconnect (reconnection exhausted)
            const conn = getConnection(apiAccount);
            if (conn?.socket) {
                conn.socket.io.on("reconnect_failed", () => {
                    abortSignal.removeEventListener("abort", cleanup);
                    cleanup();
                });
            }
        });
    }
    catch (err) {
        const errorMsg = String(err);
        log?.error(`[${account.accountId}] provider error: ${errorMsg}`);
        statusSink?.({ running: false, lastError: errorMsg });
        throw err;
    }
}
async function handleChannelEvent(event, options) {
    const { account, config, core, statusSink, log } = options;
    if (event.channel?.id && event.channel.name) {
        channelNameCache.set(`${account.accountId}:${event.channel.id}`, event.channel.name);
    }
    const eventType = event.data?.type;
    if (eventType === "message:reaction:add" || eventType === "message:reaction:remove") {
        const reactionPayload = event.data.data;
        const reactionName = reactionPayload?.reaction?.name ??
            reactionPayload?.name ??
            reactionPayload?.emoji;
        const reactionMessageId = reactionPayload?.message_id ??
            event.message_id ??
            reactionPayload?.message?.id;
        const reactionUserId = reactionPayload?.user_id ??
            event.user?.id;
        const reactionApi = core?.channel?.reactions;
        const handler = reactionApi?.dispatchReactionEvent ??
            reactionApi?.handleReactionEvent ??
            reactionApi?.onReaction;
        if (typeof handler === "function" && reactionName && reactionMessageId) {
            await handler({
                action: eventType === "message:reaction:add" ? "add" : "remove",
                channelId: event.channel_id,
                messageId: reactionMessageId,
                emoji: reactionName,
                userId: reactionUserId,
                provider: "open-webui",
            });
        }
        else {
            log?.debug?.(`[${account.accountId}] reaction event missing handler or data (messageId=${reactionMessageId}, emoji=${reactionName})`);
        }
        return;
    }
    // Only process message events
    if (eventType !== "message") {
        return;
    }
    const message = event.data.data;
    if (!message) {
        return;
    }
    // Ignore our own messages
    if (message.user_id === accountBotUserId.get(account.accountId)) {
        log?.debug?.(`[${account.accountId}] ignoring own message`);
        return;
    }
    // Determine channel type from event metadata
    const channelType = event.channel?.type ?? null; // "standard" | "group" | "dm" | null
    const isDm = channelType === "dm";
    // Check if we should monitor this channel (DMs bypass channelIds filter, like Discord)
    if (!isDm && account.channelIds.length > 0 && !account.channelIds.includes(event.channel_id)) {
        log?.debug?.(`[${account.accountId}] ignoring message from non-monitored channel ${event.channel_id}`);
        return;
    }
    const text = message.content?.trim() ?? "";
    const senderName = event.user?.name ?? message.user_id;
    const channelId = event.channel_id;
    const apiAccount = getAccountFromResolved(account);
    const replyToId = message.id;
    const parentId = message.parent_id ?? undefined;
    // Check for mention requirement
    // Open WebUI native mention format: <@U:USER_ID|Name> or <@U:USER_ID>
    const botUserId = accountBotUserId.get(account.accountId);
    let wasMentioned = false;
    if (botUserId) {
        const mentionPattern = `<@U:${botUserId}`;
        wasMentioned = text.includes(mentionPattern);
    }
    if (account.requireMention && !wasMentioned && !isDm) {
        log?.debug?.(`[${account.accountId}] ignoring message without mention`);
        return;
    }
    log?.info(`[${account.accountId}] processing message from ${senderName} in channel ${channelId}`);
    statusSink?.({ lastInboundAt: Date.now() });
    // Download inbound media AFTER mention check to avoid unnecessary work
    const inboundMedia = await resolveInboundMedia(apiAccount, core, message.data, log);
    // Resolve the route for this message. By default, group/channel messages
    // are isolated per sender so concurrent mentions do not interrupt each
    // other while still replying to the same Open WebUI channel.
    const peerId = resolvePeerId({
        channelId,
        parentId,
        senderId: message.user_id,
        messageId: message.id,
        isDm,
        scope: account.config.sessionScope,
    });
    const route = core.channel.routing.resolveAgentRoute({
        cfg: config,
        channel: "open-webui",
        accountId: account.accountId,
        peer: {
            kind: isDm ? "direct" : channelType === "standard" ? "channel" : "group",
            id: peerId,
        },
    });
    // Fetch thread parent context so the agent knows what this thread is about
    let threadParentContext = "";
    if (parentId) {
        try {
            const parentMsg = await getMessageById(apiAccount, channelId, parentId);
            if (parentMsg) {
                const parentUser = parentMsg.user?.name ?? parentMsg.user_id;
                const parentContent = parentMsg.content?.trim() ?? "";
                if (parentContent) {
                    threadParentContext = `[Thread started from this message by ${parentUser}]\n${parentContent}\n[End of thread parent message]\n\n`;
                }
            }
        }
        catch (err) {
            log?.warn(`[${account.accountId}] failed to fetch thread parent context: ${String(err)}`);
        }
    }
    // Fetch reply context if the incoming message is a reply
    let replyContext = "";
    const incomingReplyToId = message.reply_to_id;
    if (incomingReplyToId) {
        try {
            const repliedMsg = await getMessageById(apiAccount, channelId, incomingReplyToId);
            if (repliedMsg) {
                const repliedUser = repliedMsg.user?.name ?? repliedMsg.user_id;
                const repliedContent = repliedMsg.content?.trim() ?? "";
                if (repliedContent) {
                    replyContext = `[Replied message by ${repliedUser}]\n${repliedContent}\n[End of replied message]\n\n`;
                }
            }
        }
        catch (err) {
            log?.warn(`[${account.accountId}] failed to fetch reply context: ${String(err)}`);
        }
    }
    // Build context payload
    const outboundTarget = channelId;
    const rawChannelName = channelNameCache.get(`${account.accountId}:${channelId}`) ?? channelId;
    // Sanitize channel name to prevent header injection (strip brackets, newlines)
    const channelName = rawChannelName.replace(/[\[\]\n\r]/g, "").slice(0, 100);
    const fromLabel = isDm
        ? `${senderName} user id:${message.user_id}`
        : `Open WebUI #${channelName} channel id:${channelId} sender:${senderName} user id:${message.user_id}`;
    const body = text;
    const contextPrefix = `${threadParentContext}${replyContext}`;
    const bodyForAgent = contextPrefix ? `${contextPrefix}${text}` : text;
    const ctxPayload = {
        Body: body,
        BodyForAgent: bodyForAgent,
        RawBody: body,
        CommandBody: body,
        BodyForCommands: body,
        From: `open-webui:${message.user_id}`,
        To: `open-webui:${outboundTarget}`,
        SessionKey: route.sessionKey,
        AccountId: account.accountId,
        ChatType: (isDm ? "direct" : channelType === "standard" ? "channel" : "group"),
        ConversationLabel: fromLabel,
        SenderName: senderName,
        SenderId: message.user_id,
        Provider: "open-webui",
        Surface: "open-webui",
        MessageSid: message.id,
        Timestamp: message.created_at,
        OriginatingChannel: "open-webui",
        OriginatingTo: `open-webui:${outboundTarget}`,
        WasMentioned: wasMentioned,
        CommandAuthorized: true,
        ReplyToId: replyToId,
        ReplyToMessageSid: replyToId,
        ParentId: parentId,
        ThreadId: parentId,
        MessageThreadId: parentId,
    };
    if (inboundMedia.length > 0) {
        const mediaPaths = inboundMedia.map((item) => item.path);
        // Keep MediaTypes aligned with MediaPaths (use fallback instead of filtering)
        const mediaTypes = inboundMedia.map((item) => item.mimeType ?? "application/octet-stream");
        const first = inboundMedia[0];
        ctxPayload.NumMedia = inboundMedia.length;
        ctxPayload.Media = inboundMedia;
        ctxPayload.MediaPath = first.path;
        ctxPayload.MediaType = first.mimeType;
        ctxPayload.MediaUrl = first.path;
        ctxPayload.MediaPaths = mediaPaths;
        ctxPayload.MediaUrls = mediaPaths;
        ctxPayload.MediaTypes = mediaTypes;
        inboundMedia.forEach((item, index) => {
            ctxPayload[`MediaUrl${index}`] = item.path;
        });
    }
    const finalizedCtx = core.channel.reply.finalizeInboundContext(ctxPayload);
    // Dispatch to agent
    const textLimit = account.config.textChunkLimit ?? 4000;
    const finalizedSessionKey = typeof finalizedCtx.SessionKey === "string" ? finalizedCtx.SessionKey : route.sessionKey;
    rememberProgressTarget(finalizedSessionKey, {
        accountId: account.accountId,
        account: apiAccount,
        channelId: outboundTarget,
        replyToId,
        parentId,
        textChunkLimit: textLimit,
        config: account.config.progressEvents ?? {},
    });
    // Send typing indicator immediately and refresh every 4s (Open WebUI expires after 5s)
    const typingMessageId = parentId ?? null;
    let typingInterval = null;
    const emitTyping = (typing) => {
        const conn = getConnection(apiAccount);
        if (conn?.socket?.connected) {
            conn.socket.emit("events:channel", {
                channel_id: outboundTarget,
                message_id: typingMessageId,
                data: { type: "typing", data: { typing } },
            });
        }
    };
    const startTyping = async () => {
        emitTyping(true);
        if (!typingInterval) {
            typingInterval = setInterval(() => emitTyping(true), 4000);
        }
    };
    const stopTyping = async () => {
        if (typingInterval) {
            clearInterval(typingInterval);
            typingInterval = null;
        }
        emitTyping(false);
    };
    const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
        deliver: async (payload) => {
            try {
                const payloadRecord = payload;
                const reaction = extractReactionPayload(payloadRecord);
                if (reaction) {
                    const targetMessageId = reaction.messageId ?? replyToId ?? message.id;
                    if (targetMessageId) {
                        if (reaction.action === "remove") {
                            await removeReaction(apiAccount, outboundTarget, targetMessageId, reaction.emoji);
                        }
                        else {
                            await addReaction(apiAccount, outboundTarget, targetMessageId, reaction.emoji);
                        }
                    }
                    return;
                }
                const mediaSpecs = coerceOutboundMedia(payloadRecord);
                const uploadedFiles = [];
                for (const media of mediaSpecs) {
                    try {
                        const uploaded = await uploadFile(apiAccount, media.path, {
                            filename: media.filename,
                            mimeType: media.mimeType,
                        });
                        uploadedFiles.push(uploaded);
                    }
                    catch (uploadErr) {
                        log?.error(`[${account.accountId}] deliver: failed to upload file ${media.path}: ${String(uploadErr)}`);
                    }
                }
                const responseText = payloadRecord.text;
                const trimmed = responseText?.trim() ?? "";
                if (!trimmed && uploadedFiles.length === 0) {
                    if (mediaSpecs.length > 0) {
                        throw new Error(`All ${mediaSpecs.length} media upload(s) failed and no text content to deliver`);
                    }
                    log?.debug?.(`[${account.accountId}] deliver: skipping empty payload`);
                    return;
                }
                // Chunk if needed
                const chunks = trimmed
                    ? core.channel.text.chunkMarkdownText(trimmed, textLimit)
                    : [""];
                if (!chunks.length && trimmed) {
                    chunks.push(trimmed);
                }
                const replyToOverride = payloadRecord.replyToId ??
                    payloadRecord.reply_to_id ??
                    replyToId;
                const parentOverride = payloadRecord.parentId ??
                    payloadRecord.threadId ??
                    parentId;
                const dataOverride = payloadRecord.data ?? {};
                const metaOverride = payloadRecord.meta ?? {};
                const dataPayloadWithFiles = { ...dataOverride };
                if (uploadedFiles.length > 0) {
                    dataPayloadWithFiles.files = uploadedFiles.map(wrapUploadedFile);
                }
                log?.info(`[${account.accountId}] deliver: posting ${chunks.length} chunk(s) (${trimmed.length} chars) to ${outboundTarget} (replyTo=${replyToOverride ?? "none"}, parent=${parentOverride ?? "none"})`);
                for (const [index, chunk] of chunks.entries()) {
                    const content = chunk === "" ? " " : chunk;
                    const dataPayload = index === 0 ? dataPayloadWithFiles : dataOverride;
                    try {
                        const posted = await postMessage(apiAccount, outboundTarget, content, {
                            replyToId: replyToOverride,
                            parentId: parentOverride,
                            data: dataPayload,
                            meta: metaOverride,
                        });
                        if (posted?.id) {
                            log?.info(`[${account.accountId}] deliver: chunk ${index + 1}/${chunks.length} saved as ${posted.id} (${content.length}ch)`);
                        }
                        else {
                            log?.error(`[${account.accountId}] deliver: chunk ${index + 1}/${chunks.length} returned no id! response=${JSON.stringify(posted).slice(0, 300)}`);
                        }
                    }
                    catch (postErr) {
                        log?.error(`[${account.accountId}] deliver: failed to post chunk ${index + 1}/${chunks.length} to ${outboundTarget}: ${String(postErr)}`);
                        throw postErr; // Re-throw to let core handle the failure
                    }
                }
                log?.info(`[${account.accountId}] deliver: successfully posted to ${outboundTarget}`);
            }
            catch (deliverErr) {
                log?.error(`[${account.accountId}] deliver: unexpected error: ${String(deliverErr)}`);
                throw deliverErr; // Re-throw so core knows delivery failed
            }
        },
        onReplyStart: startTyping,
        onError: (err, info) => {
            log?.error(`[${account.accountId}] dispatch error (${info.kind}): ${String(err)}`);
        },
    });
    try {
        await startTyping();
        await core.channel.reply.dispatchReplyFromConfig({
            ctx: finalizedCtx,
            cfg: config,
            dispatcher,
            replyOptions,
        });
    }
    catch (err) {
        log?.error(`[${account.accountId}] failed to dispatch message: ${String(err)}`);
    }
    finally {
        markDispatchIdle();
        await stopTyping();
        forgetProgressTarget(finalizedSessionKey);
    }
}
