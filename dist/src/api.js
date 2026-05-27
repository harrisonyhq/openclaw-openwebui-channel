import { readFile } from "node:fs/promises";
import { basename } from "node:path";
// Cache tokens per account
const tokenCache = new Map();
export function invalidateAuthToken(account) {
    const cacheKey = `${account.baseUrl}:${account.email}`;
    tokenCache.delete(cacheKey);
}
export async function getAuthToken(account) {
    const cacheKey = `${account.baseUrl}:${account.email}`;
    const cached = tokenCache.get(cacheKey);
    // Use cached token if not expired (tokens valid for ~24h, refresh every 12h)
    if (cached && cached.expiresAt > Date.now()) {
        return { token: cached.token, userId: cached.userId, userName: cached.userName };
    }
    const response = await fetch(`${account.baseUrl}/api/v1/auths/signin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: account.email, password: account.password }),
    });
    if (!response.ok) {
        throw new Error(`[open-webui] Auth failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    // Cache for 12 hours
    tokenCache.set(cacheKey, {
        token: data.token,
        userId: data.id,
        userName: data.name ?? "",
        expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    });
    return { token: data.token, userId: data.id, userName: data.name ?? "" };
}
async function fetchWithAuthRetry(account, url, init) {
    const { token } = await getAuthToken(account);
    const headers = { ...init?.headers, Authorization: `Bearer ${token}` };
    const response = await fetch(url, { ...init, headers });
    if (response.status === 401) {
        invalidateAuthToken(account);
        const { token: newToken } = await getAuthToken(account);
        const retryHeaders = { ...init?.headers, Authorization: `Bearer ${newToken}` };
        return fetch(url, { ...init, headers: retryHeaders });
    }
    return response;
}
export async function getChannels(account) {
    const response = await fetchWithAuthRetry(account, `${account.baseUrl}/api/v1/channels/`);
    if (!response.ok) {
        throw new Error(`[open-webui] Failed to get channels: ${response.status}`);
    }
    return response.json();
}
export async function getChannelMessages(account, channelId, skip = 0, limit = 50) {
    const response = await fetchWithAuthRetry(account, `${account.baseUrl}/api/v1/channels/${channelId}/messages?skip=${skip}&limit=${limit}`);
    if (!response.ok) {
        throw new Error(`[open-webui] Failed to get messages: ${response.status}`);
    }
    return response.json();
}
export async function postMessage(account, channelId, content, options) {
    const response = await fetchWithAuthRetry(account, `${account.baseUrl}/api/v1/channels/${channelId}/messages/post`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            content,
            parent_id: options?.parentId,
            reply_to_id: options?.replyToId,
            data: options?.data ?? {},
            meta: options?.meta ?? {},
        }),
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`[open-webui] Failed to post message: ${response.status} - ${errorText}`);
    }
    return response.json();
}
function parseFilenameFromContentDisposition(header) {
    if (!header) {
        return undefined;
    }
    const utf8Match = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
        try {
            return decodeURIComponent(utf8Match[1]);
        }
        catch {
            return utf8Match[1];
        }
    }
    const asciiMatch = header.match(/filename\s*=\s*\"?([^\";]+)\"?/i);
    return asciiMatch?.[1];
}
export async function uploadFile(account, filePath, options) {
    const buffer = await readFile(filePath);
    const filename = options?.filename ?? basename(filePath);
    const mimeType = options?.mimeType ?? "application/octet-stream";
    const buildForm = () => {
        const form = new FormData();
        const blob = new Blob([buffer], { type: mimeType });
        form.append("file", blob, filename);
        return form;
    };
    const { token } = await getAuthToken(account);
    const response = await fetch(`${account.baseUrl}/api/v1/files/`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: buildForm(),
    });
    if (response.status === 401) {
        invalidateAuthToken(account);
        const { token: newToken } = await getAuthToken(account);
        const retryResponse = await fetch(`${account.baseUrl}/api/v1/files/`, {
            method: "POST",
            headers: { Authorization: `Bearer ${newToken}` },
            body: buildForm(),
        });
        if (!retryResponse.ok) {
            const errorText = await retryResponse.text();
            throw new Error(`[open-webui] Failed to upload file: ${retryResponse.status} - ${errorText}`);
        }
        return retryResponse.json();
    }
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`[open-webui] Failed to upload file: ${response.status} - ${errorText}`);
    }
    return response.json();
}
export async function downloadFileContent(account, fileId) {
    const response = await fetchWithAuthRetry(account, `${account.baseUrl}/api/v1/files/${fileId}/content`);
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`[open-webui] Failed to download file ${fileId}: ${response.status} - ${errorText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(new Uint8Array(arrayBuffer));
    const filename = parseFilenameFromContentDisposition(response.headers.get("content-disposition"));
    const mimeType = response.headers.get("content-type") ?? undefined;
    return { id: fileId, buffer, filename, mimeType };
}
export async function getMessageById(account, channelId, messageId) {
    const response = await fetchWithAuthRetry(account, `${account.baseUrl}/api/v1/channels/${channelId}/messages/${messageId}`);
    if (!response.ok) {
        return null;
    }
    return response.json();
}
export async function addReaction(account, channelId, messageId, emoji) {
    const response = await fetchWithAuthRetry(account, `${account.baseUrl}/api/v1/channels/${channelId}/messages/${messageId}/reactions/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: emoji }),
    });
    return response.ok;
}
export async function removeReaction(account, channelId, messageId, emoji) {
    const response = await fetchWithAuthRetry(account, `${account.baseUrl}/api/v1/channels/${channelId}/messages/${messageId}/reactions/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: emoji }),
    });
    return response.ok;
}
