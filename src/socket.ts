import { io, Socket } from "socket.io-client";
import { getAuthToken, invalidateAuthToken, type OpenWebUIAccount, type ChannelMessage } from "./api.js";

// Logger type matching what's passed from channel context
type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export interface ChannelEvent {
  channel_id: string;
  message_id: string;
  data: {
    type: "message" | "message:update" | "message:delete" | "message:reaction:add" | "message:reaction:remove" | "channel:created";
    data?: ChannelMessage & { temp_id?: string };
  };
  user?: {
    id: string;
    name: string;
    role: string;
  };
  channel?: {
    id: string;
    name: string;
    type: string | null;
  };
}

export type MessageHandler = (event: ChannelEvent) => void | Promise<void>;

interface SocketConnection {
  socket: Socket;
  account: OpenWebUIAccount;
  userId: string;
  handlers: Set<MessageHandler>;
  connectPromise?: Promise<void>;  // Pending connection promise for concurrent callers
  desiredChannelIds: Set<string>;
  rejoinInterval?: ReturnType<typeof setInterval>;
}

type SocketOptions = {
  channelIds?: string[];
  onTerminalDisconnect?: () => void;
};

const connections = new Map<string, SocketConnection>();

export async function connectSocket(
  account: OpenWebUIAccount,
  onMessage: MessageHandler,
  logger?: Logger,
  options?: SocketOptions
): Promise<void> {
  // Build a safe logger wrapper. Some loggers rely on `this` binding or may be undefined.
  const log: Logger = {
    info: (msg) => {
      try {
        (logger?.info ?? console.info).call(logger ?? console, msg);
      } catch {
        console.info(msg);
      }
    },
    warn: (msg) => {
      try {
        (logger?.warn ?? console.warn).call(logger ?? console, msg);
      } catch {
        console.warn(msg);
      }
    },
    error: (msg) => {
      try {
        (logger?.error ?? console.error).call(logger ?? console, msg);
      } catch {
        console.error(msg);
      }
    },
  };

  const connectionKey = `${account.baseUrl}:${account.email}`;

  // Check if already connected or connecting
  const existing = connections.get(connectionKey);
  if (existing) {
    if (existing.socket.connected) {
      existing.handlers.add(onMessage);
      if (options?.channelIds?.length) {
        for (const channelId of options.channelIds) {
          existing.desiredChannelIds.add(channelId);
        }
      }
      log.info(`[open-webui] Reusing existing socket connection`);
      return;
    }
    // socket.active is true when actively connecting/reconnecting
    // Only clean up truly stale sockets (not actively trying to connect)
    if (existing.socket.active) {
      // Still connecting, add handler and wait for connection
      existing.handlers.add(onMessage);
      if (options?.channelIds?.length) {
        for (const channelId of options.channelIds) {
          existing.desiredChannelIds.add(channelId);
        }
      }
      log.info(`[open-webui] Socket still connecting, waiting for connection`);
      
      // Create a fresh promise for this caller to avoid reusing a rejected promise
      // (the original connectPromise may have rejected on first attempt while socket keeps reconnecting)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          existing.socket.off("connect", onConnect);
          existing.socket.off("disconnect", onDisconnect);
          reject(new Error("Socket.IO connection timeout while waiting for reconnect"));
        }, 30000);

        const onConnect = () => {
          clearTimeout(timeout);
          existing.socket.off("disconnect", onDisconnect);
          resolve();
        };

        const onDisconnect = () => {
          // Only reject if socket is no longer trying to reconnect
          if (!existing.socket.active) {
            clearTimeout(timeout);
            existing.socket.off("connect", onConnect);
            reject(new Error("Socket disconnected and not reconnecting"));
          }
        };

        // Attach listeners FIRST to avoid race condition
        existing.socket.once("connect", onConnect);
        existing.socket.once("disconnect", onDisconnect);

        // Then check if already connected (listener will be cleaned up)
        if (existing.socket.connected) {
          clearTimeout(timeout);
          existing.socket.off("connect", onConnect);
          existing.socket.off("disconnect", onDisconnect);
          resolve();
        }
      });
      return;
    }
    // Clean up stale disconnected socket to prevent duplicate events and leaks
    log.info(`[open-webui] Cleaning up stale disconnected socket`);
    if (existing.rejoinInterval) {
      clearInterval(existing.rejoinInterval);
    }
    existing.socket.disconnect();
    connections.delete(connectionKey);
  }

  // Get initial auth token for first handshake.
  const initialAuth = await getAuthToken(account);
  let currentToken = initialAuth.token;
  let forceTokenRefresh = false;
  let hasConnectedOnce = false;

  log.info(`[open-webui] Connecting to Socket.IO at ${account.baseUrl}`);

  let connection: SocketConnection | undefined;
  const resolveSocketToken = async (forceRefresh = false): Promise<string> => {
    if (forceRefresh) {
      invalidateAuthToken(account);
    }
    const auth = await getAuthToken(account);
    currentToken = auth.token;
    if (connection) {
      connection.userId = auth.userId;
    }
    return auth.token;
  };

  const socket = io(account.baseUrl, {
    path: "/ws/socket.io",
    // Run auth resolution for every handshake so reconnects can use a refreshed token.
    auth: (cb) => {
      void (async () => {
        try {
          // Only refresh credentials when reconnecting.
          const shouldForceRefresh = forceTokenRefresh;
          const token = await resolveSocketToken(shouldForceRefresh);
          forceTokenRefresh = false;
          cb({ token });
        } catch (err) {
          forceTokenRefresh = false;
          log.warn(`[open-webui] Failed to refresh Socket.IO auth token, using last token: ${String(err)}`);
          cb({ token: currentToken });
        }
      })();
    },
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
  });

  const handlers = new Set<MessageHandler>();
  handlers.add(onMessage);

  // Create connection promise that allows reconnection flow on transient first-attempt failures.
  const connectPromise = new Promise<void>((resolve, reject) => {
    const onConnect = () => {
      socket.io.off("reconnect_failed", onReconnectFailed);
      resolve();
    };

    const onReconnectFailed = () => {
      socket.off("connect", onConnect);
      reject(new Error("Socket.IO reconnection failed during startup"));
    };

    socket.once("connect", onConnect);
    socket.io.once("reconnect_failed", onReconnectFailed);
  });

  const desiredChannelIds = new Set<string>();
  if (options?.channelIds?.length) {
    for (const channelId of options.channelIds) {
      desiredChannelIds.add(channelId);
    }
  }
  connection = { socket, account, userId: initialAuth.userId, handlers, connectPromise, desiredChannelIds };
  connections.set(connectionKey, connection);

  const emitJoinChannels = () => {
    if (!socket.connected) {
      return;
    }
    // Join user room and all channel rooms currently visible to the bot user.
    // Open WebUI resolves the actual channel set server-side from the auth token.
    socket.emit("user-join", { auth: { token: currentToken } });
    socket.emit("join-channels", { auth: { token: currentToken } });
  };

  socket.on("connect", () => {
    hasConnectedOnce = true;
    log.info(`[open-webui] Socket.IO connected`);
    emitJoinChannels();
  });

  socket.on("disconnect", (reason) => {
    log.warn(`[open-webui] Socket.IO disconnected: ${reason}`);
  });

  socket.io.on("reconnect_attempt", (attempt) => {
    forceTokenRefresh = true;
    log.info(`[open-webui] Socket.IO reconnect attempt #${attempt}, refreshing auth token`);
  });

  socket.on("connect_error", (error) => {
    log.error(`[open-webui] Socket.IO connection error: ${error.message}`);
  });

  // Fire when all reconnection attempts are exhausted
  socket.io.on("reconnect_failed", () => {
    log.error(`[open-webui] Socket.IO reconnection failed permanently`);
    if (connection?.rejoinInterval) {
      clearInterval(connection.rejoinInterval);
    }
    connections.delete(connectionKey);
    if (hasConnectedOnce) {
      options?.onTerminalDisconnect?.();
    }
  });

  // Listen for channel events
  socket.on("events:channel", async (event: ChannelEvent) => {
    // log.info(`[open-webui] Received event: ${event.data?.type} in channel ${event.channel_id}`);
    if (event.data?.type === "channel:created") {
      emitJoinChannels();
    }
    
    // Process through all handlers
    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (err) {
        log.error(`[open-webui] Handler error: ${err}`);
      }
    }
  });

  connection.rejoinInterval = setInterval(emitJoinChannels, 60_000);

  // Wait for connection using the stored promise
  await connectPromise;
}

export function disconnectSocket(account: OpenWebUIAccount): void {
  const connectionKey = `${account.baseUrl}:${account.email}`;
  const connection = connections.get(connectionKey);
  
  if (connection) {
    if (connection.rejoinInterval) {
      clearInterval(connection.rejoinInterval);
    }
    connection.socket.disconnect();
    connections.delete(connectionKey);
  }
}

export function disconnectAll(): void {
  for (const [key, connection] of connections) {
    if (connection.rejoinInterval) {
      clearInterval(connection.rejoinInterval);
    }
    connection.socket.disconnect();
    connections.delete(key);
  }
}

export function getConnection(account: OpenWebUIAccount): SocketConnection | undefined {
  const connectionKey = `${account.baseUrl}:${account.email}`;
  return connections.get(connectionKey);
}
