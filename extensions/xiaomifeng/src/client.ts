/**
 * XiaoMiFeng Client - @yxim/nim-bot V2 API wrapper.
 *
 * Uses the Netease IM Bot SDK (@yxim/nim-bot).
 */

import { randomUUID } from "crypto";
import { resolveXiaomifengCredentials, isXiaomifengP2pAllowed } from "./accounts.js";
import type {
  XiaomifengInstanceConfig,
  XiaomifengClientInstance,
  XiaomifengMessageEvent,
  XiaomifengSendResult,
  XiaomifengSessionType,
  XiaomifengMessageType,
  XiaomifengAttachment,
  XiaomifengP2pPolicy,
} from "./types.js";

// Client cache.
const clientCache = new Map<string, XiaomifengClientInstance>();

// Message callback registry.
const messageCallbacks = new Map<string, Set<(msg: XiaomifengMessageEvent) => void>>();
const connectionCallbacks = new Map<string, Set<(state: string) => void>>();

type NimErrorShape = {
  message?: unknown;
  desc?: unknown;
  code?: unknown;
  res_code?: unknown;
};

type NimConversationIdUtil = {
  p2pConversationId?: (accountId: string) => string | undefined;
  teamConversationId?: (accountId: string) => string | undefined;
  superTeamConversationId?: (accountId: string) => string | undefined;
};

type NimLoginService = {
  on(event: "onDataSync", callback: (_type: number, state: number, _error: unknown) => void): void;
  on(event: "onLoginStatus", callback: (status: number) => void): void;
  on(event: "onKickedOffline", callback: (detail: unknown) => void): void;
  on(event: "onDisconnected", callback: (error: unknown) => void): void;
  login(account: string, token: string, options: { aiBot: number }): Promise<void>;
  logout(): Promise<void>;
};

type NimMessage = {
  conversationId?: string;
  messageServerId?: string | number;
  messageClientId?: string;
  senderId?: string | number;
  receiverId?: string | number;
  messageType?: number;
  text?: string;
  createTime?: number;
  serverExtension?: string;
  senderName?: string;
  pushConfig?: {
    forcePushAccountIds?: string[];
  };
  attachment?: {
    name?: string;
    size?: number;
    url?: string;
    ext?: string;
    md5?: string;
    width?: number;
    height?: number;
    duration?: number;
  };
};

type NimOutgoingMessage = {
  messageClientId?: string;
};

type NimSendMessageResult = {
  message?: {
    messageServerId?: string;
    messageClientId?: string;
  };
};

type NimStreamMessageResult = {
  messageServerId?: string;
  messageClientId?: string;
};

type NimMessageService = {
  on(event: "onReceiveOfflineMessages", callback: (messages: unknown[]) => void): void;
  on(event: "onReceiveMessages", callback: (messages: unknown[]) => void): void;
  sendMessage(
    message: NimOutgoingMessage,
    conversationId: string,
    options: Record<string, unknown>,
  ): Promise<NimSendMessageResult>;
  replyMessage(
    replyMsg: NimOutgoingMessage,
    originalMsg: unknown,
    sendParams: Record<string, unknown>,
  ): Promise<NimSendMessageResult>;
  sendStreamMessage(
    message: NimOutgoingMessage,
    conversationId: string,
    options: Record<string, unknown>,
    streamChunkParams: { text: string; index?: number; finish?: number },
  ): Promise<NimStreamMessageResult>;
};

type NimMessageCreator = {
  createTextMessage(text: string): NimOutgoingMessage | null | undefined;
  createImageMessage(filePath: string, fileName: string): NimOutgoingMessage | null | undefined;
  createFileMessage(filePath: string, fileName: string): NimOutgoingMessage | null | undefined;
  createAudioMessage?: (
    filePath: string,
    fileName: string,
    extension: string,
    duration: number,
  ) => NimOutgoingMessage | null | undefined;
  createVideoMessage?: (
    filePath: string,
    fileName: string,
    extension: string,
    duration: number,
    width: number,
    height: number,
  ) => NimOutgoingMessage | null | undefined;
};

type NimFriendApplication = {
  applicantAccountId?: string | number;
};

type NimFriendService = {
  on(event: "onFriendAddApplication", callback: (application: unknown) => Promise<void>): void;
  acceptAddApplication(application: unknown): Promise<void>;
};

type NimSdkInstance = {
  V2NIMConversationIdUtil?: NimConversationIdUtil;
  V2NIMLoginService?: NimLoginService;
  V2NIMMessageService?: NimMessageService;
  V2NIMMessageCreator?: NimMessageCreator;
  V2NIMFriendService?: NimFriendService;
  destroy(): Promise<void>;
};

type NimConstructor = new (
  config: Record<string, unknown>,
  options?: Record<string, unknown>,
) => NimSdkInstance;

function getErrorDetails(error: unknown): { message: string; code?: number } {
  const err = error as NimErrorShape;
  const message =
    (typeof err.message === "string" ? err.message : undefined) ??
    (typeof err.desc === "string" ? err.desc : undefined) ??
    String(error);
  const code =
    typeof err.code === "number"
      ? err.code
      : typeof err.res_code === "number"
        ? err.res_code
        : undefined;
  return { message, code };
}

/**
 * Convert V2 message type to plugin message type.
 */
function convertMessageType(v2Type: number): XiaomifengMessageType {
  // V2NIMMessageType enum.
  const typeMap: Record<number, XiaomifengMessageType> = {
    0: "text",
    1: "image",
    2: "audio",
    3: "video",
    4: "geo",
    5: "notification",
    6: "file",
    10: "tip",
    11: "robot",
    100: "custom",
  };
  return typeMap[v2Type] || "unknown";
}

/**
 * Parse session type from conversationId.
 * conversationId format: {appId}|{type}|{targetId}
 */
function parseConversationId(conversationId: string): {
  sessionType: XiaomifengSessionType;
  targetId: string;
} {
  const parts = conversationId.split("|");
  if (parts.length >= 3) {
    const typeNum = parseInt(parts[1], 10);
    const sessionType: XiaomifengSessionType =
      typeNum === 1 ? "p2p" : typeNum === 2 ? "team" : typeNum === 3 ? "superTeam" : "p2p";
    return { sessionType, targetId: parts[2] };
  }
  return { sessionType: "p2p", targetId: "" };
}

/**
 * Build conversationId.
 */
function buildConversationId(
  nim: NimSdkInstance,
  accountId: string,
  sessionType: XiaomifengSessionType,
): string {
  const conversationIdUtil = nim.V2NIMConversationIdUtil;
  if (conversationIdUtil) {
    const p2pConversationId = conversationIdUtil.p2pConversationId;
    const teamConversationId = conversationIdUtil.teamConversationId;
    const superTeamConversationId = conversationIdUtil.superTeamConversationId;
    switch (sessionType) {
      case "p2p":
        return p2pConversationId?.(accountId) || "";
      case "team":
        return teamConversationId?.(accountId) || "";
      case "superTeam":
        return superTeamConversationId?.(accountId) || "";
      default:
        return p2pConversationId?.(accountId) || "";
    }
  }
  // fallback: build manually.
  const typeNum = sessionType === "p2p" ? 1 : sessionType === "team" ? 2 : 3;
  return `0|${typeNum}|${accountId}`;
}

/**
 * Parse V2 message attachment.
 */
function parseV2Attachment(msg: unknown): XiaomifengAttachment | undefined {
  const attachment = (msg as NimMessage).attachment;
  if (!attachment) {
    return undefined;
  }

  return {
    name: attachment.name,
    size: attachment.size,
    url: attachment.url,
    ext: attachment.ext,
    md5: attachment.md5,
    w: attachment.width,
    h: attachment.height,
    dur: attachment.duration,
  };
}

/**
 * Convert a V2 message to our message event shape.
 */
function convertV2ToMessageEvent(msg: unknown): XiaomifengMessageEvent {
  const message = msg as NimMessage;
  const { sessionType } = parseConversationId(message.conversationId || "");

  // Extract forcePushAccountIds from V2 push config
  const forcePushAccountIds: string[] | undefined =
    message.pushConfig?.forcePushAccountIds ?? undefined;

  return {
    msgId: String(message.messageServerId || message.messageClientId || ""),
    clientMsgId: message.messageClientId || "",
    sessionType,
    from: String(message.senderId || ""),
    to: String(message.receiverId || ""),
    type: convertMessageType(message.messageType ?? -1),
    text: message.text || "",
    time: message.createTime || Date.now(),
    attach: parseV2Attachment(message),
    ext: message.serverExtension ? JSON.parse(message.serverExtension) : undefined,
    forcePushAccountIds,
    fromNick: message.senderName || undefined,
    rawMsg: message,
  };
}

/**
 * Create a XiaoMiFeng client instance (@yxim/nim-bot).
 */
export async function createXiaomifengClient(
  cfg: XiaomifengInstanceConfig,
): Promise<XiaomifengClientInstance> {
  const creds = resolveXiaomifengCredentials(cfg);
  if (!creds) {
    throw new Error("XiaoMiFeng credentials not configured");
  }

  const cacheKey = `${creds.appKey}:${creds.account}`;

  // Check cache.
  const cached = clientCache.get(cacheKey);
  if (cached && cached.initialized) {
    return cached;
  }

  // Dynamic import for @yxim/nim-bot.
  const NIMModule = await import("@yxim/nim-bot");
  const NIM = NIMModule.default as NimConstructor;

  // Build privateConf from advanced config fields
  const privateConf: Record<string, unknown> = {};
  const adv = cfg.advanced;
  if (adv?.weblbsUrl) {
    privateConf.weblbsUrl = adv.weblbsUrl;
  }
  if (adv?.link_web) {
    privateConf.link_web = adv.link_web;
  }
  if (adv?.nos_uploader) {
    privateConf.nos_uploader = adv.nos_uploader;
  }
  if (adv?.nos_downloader_v2) {
    privateConf.nos_downloader_v2 = adv.nos_downloader_v2;
  }
  if (adv?.nosSsl !== undefined) {
    privateConf.nosSsl = adv.nosSsl;
  }
  if (adv?.nos_accelerate) {
    privateConf.nos_accelerate = adv.nos_accelerate;
  }
  if (adv?.nos_accelerate_host !== undefined) {
    privateConf.nos_accelerate_host = adv.nos_accelerate_host;
  }

  const otherOptions: Record<string, unknown> = {};
  if (Object.keys(privateConf).length > 0) {
    otherOptions.privateConf = privateConf;
  }

  const nim = new NIM(
    {
      appkey: creds.appKey,
      apiVersion: "v2",
      debugLevel: cfg.advanced?.debug ? "debug" : "off",
    },
    Object.keys(otherOptions).length > 0 ? otherOptions : undefined,
  );

  let _loggedIn = false;
  const msgCallbackSet = new Set<(msg: XiaomifengMessageEvent) => void>();
  const connCallbackSet = new Set<(state: string) => void>();

  messageCallbacks.set(cacheKey, msgCallbackSet);
  connectionCallbacks.set(cacheKey, connCallbackSet);

  // Gate that opens once the SDK's initial offline-message sync completes.
  // Until then, onReceiveMessages carries offline backlog — we skip it.
  let syncFinished = false;
  let offlineDropped = 0;

  // Resolve service references.
  const loginService = nim.V2NIMLoginService;
  const messageService = nim.V2NIMMessageService;
  const messageCreator = nim.V2NIMMessageCreator;
  const friendService = nim.V2NIMFriendService;

  // Mutable policy state — updated via updateP2pPolicy() when config reloads.
  let liveP2pPolicy = (cfg.p2p?.policy as XiaomifengP2pPolicy) ?? "open";
  let liveP2pAllowFrom: Array<string | number> = cfg.p2p?.allowFrom ?? [];

  if (friendService) {
    friendService.on("onFriendAddApplication", async (application: unknown) => {
      const applicantId = String((application as NimFriendApplication).applicantAccountId ?? "");
      if (!applicantId) {
        return;
      }

      const check = isXiaomifengP2pAllowed({
        p2pPolicy: liveP2pPolicy,
        allowFrom: liveP2pAllowFrom,
        senderId: applicantId,
      });

      if (!check.allowed) {
        return;
      }

      try {
        await friendService.acceptAddApplication(application);
      } catch (err) {
        const { message: errorMessage } = getErrorDetails(err);
        console.error(
          `[xiaomifeng] friend request accept failed — applicant: ${applicantId}, error: ${errorMessage}`,
        );
      }
    });
  }

  if (!loginService || !messageService) {
    throw new Error("XiaoMiFeng SDK V2 services not available");
  }

  // Offline message batch — dropped, not dispatched to handlers.
  messageService.on("onReceiveOfflineMessages", (messages: unknown[]) => {
    offlineDropped += messages.length;
  });

  // Sync completion — from this point onReceiveMessages carries live messages only.
  loginService.on("onDataSync", (_type: number, state: number, _error: unknown) => {
    // V2NIMDataSyncState: 2 = complete
    if (state === 2) {
      if (!syncFinished) {
        syncFinished = true;
      }
    }
  });

  // Register message receive handler.
  // Dedup set: tracks msgIds seen in the current session to avoid processing
  // the same message twice (SDK occasionally delivers duplicates in one batch).
  const recentMsgIds = new Set<string>();
  messageService.on("onReceiveMessages", (messages: unknown[]) => {
    if (!syncFinished) {
      offlineDropped += messages.length;
      return;
    }
    for (const msg of messages) {
      const event = convertV2ToMessageEvent(msg);
      const dedupKey = event.msgId || event.clientMsgId;
      if (dedupKey && recentMsgIds.has(dedupKey)) {
        continue;
      }
      if (dedupKey) {
        recentMsgIds.add(dedupKey);
        // Keep the set bounded to the last 200 ids.
        if (recentMsgIds.size > 200) {
          recentMsgIds.delete(recentMsgIds.values().next().value!);
        }
      }
      msgCallbackSet.forEach((cb) => cb(event));
    }
  });

  // Register login status callback.
  loginService.on("onLoginStatus", (status: number) => {
    console.log(`[xiaomifeng] login status changed — status: ${status}`);
    // V2NIMLoginStatus: 0=LOGOUT, 1=LOGINED, 2=LOGINING
    if (status === 1) {
      _loggedIn = true;
      connCallbackSet.forEach((cb) => cb("connected"));
    } else if (status === 0) {
      _loggedIn = false;
      connCallbackSet.forEach((cb) => cb("logout"));
    }
  });

  loginService.on("onKickedOffline", (detail: unknown) => {
    const detailObj = detail as { reasonDesc?: unknown; reason?: unknown };
    const detailMessage =
      (typeof detailObj.reasonDesc === "string" ? detailObj.reasonDesc : undefined) ??
      (typeof detailObj.reason === "string" ? detailObj.reason : undefined) ??
      String(detail);
    console.log(`[xiaomifeng] kicked offline — reason: ${detailMessage}`);
    _loggedIn = false;
    connCallbackSet.forEach((cb) => cb("kickout"));
  });

  loginService.on("onDisconnected", (error: unknown) => {
    const { message: errorMessage } = getErrorDetails(error);
    console.log(`[xiaomifeng] disconnected — error: ${errorMessage}`);
    connCallbackSet.forEach((cb) => cb("disconnected"));
  });

  const instance: XiaomifengClientInstance = {
    initialized: true,
    loggedIn: false,
    account: creds.account,
    nativeNim: nim,

    updateP2pPolicy(policy: XiaomifengP2pPolicy, allowFrom: Array<string | number>) {
      liveP2pPolicy = policy;
      liveP2pAllowFrom = allowFrom;
    },

    async login(): Promise<boolean> {
      // Re-arm the sync gate each time login is called (reconnect scenario).
      syncFinished = false;
      offlineDropped = 0;
      try {
        const legacyLogin = cfg.advanced?.legacyLogin ?? false;
        const aiBotValue = legacyLogin ? 0 : 2;
        await loginService.login(creds.account, creds.token, {
          aiBot: aiBotValue,
        });
        _loggedIn = true;
        instance.loggedIn = true;
        console.log(
          `[xiaomifeng] login successful — account: ${creds.account}, aiBot: ${aiBotValue}`,
        );
        return true;
      } catch (error) {
        const { message: errorMessage, code: errorCode } = getErrorDetails(error);
        console.error(
          `[xiaomifeng] login failed — error: ${errorMessage}${errorCode ? ` (code: ${errorCode})` : ""}`,
        );
        return false;
      }
    },

    async logout(): Promise<void> {
      try {
        await loginService.logout();
        _loggedIn = false;
        instance.loggedIn = false;
      } catch (error) {
        const { message: errorMessage } = getErrorDetails(error);
        console.error(`[xiaomifeng] logout failed — error: ${errorMessage}`);
      }
    },

    async sendText(
      to: string,
      text: string,
      sessionType: XiaomifengSessionType = "p2p",
    ): Promise<XiaomifengSendResult> {
      const clientMsgId = randomUUID().replace(/-/g, "");
      const conversationId = buildConversationId(nim, to, sessionType);

      const attempt = async (retry: boolean): Promise<XiaomifengSendResult> => {
        try {
          const message = messageCreator?.createTextMessage(text);
          if (!message) {
            return { success: false, error: "Failed to create text message" };
          }
          message.messageClientId = clientMsgId;

          const result = await messageService.sendMessage(message, conversationId, {
            antispamConfig: {
              antispamEnabled: cfg.antispamEnabled ?? true,
            },
          });
          return {
            success: true,
            msgId: result.message?.messageServerId,
            clientMsgId: result.message?.messageClientId,
          };
        } catch (error) {
          const { message: errorMessage, code: errorCode } = getErrorDetails(error);
          console.error(
            `[xiaomifeng] text send failed — error: ${errorMessage}${errorCode ? ` (code: ${errorCode})` : ""}, clientMsgId: ${clientMsgId}${retry ? " (retry)" : ""}`,
          );
          return { success: false, error: errorMessage, errorCode };
        }
      };

      const first = await attempt(false);
      if (first.success) {
        return first;
      }

      return attempt(true);
    },

    async sendImage(
      to: string,
      filePath: string,
      sessionType: XiaomifengSessionType = "p2p",
    ): Promise<XiaomifengSendResult> {
      try {
        const { basename } = await import("path");
        const message = messageCreator?.createImageMessage(filePath, basename(filePath));
        if (!message) {
          return { success: false, error: "Failed to create image message" };
        }

        const conversationId = buildConversationId(nim, to, sessionType);
        const result = await messageService.sendMessage(message, conversationId, {});

        return {
          success: true,
          msgId: result.message?.messageServerId,
          clientMsgId: result.message?.messageClientId,
        };
      } catch (error) {
        const { message: errorMessage, code: errorCode } = getErrorDetails(error);
        console.error(
          `[xiaomifeng] image send failed — error: ${errorMessage}${errorCode ? ` (code: ${errorCode})` : ""}`,
        );
        return { success: false, error: errorMessage };
      }
    },

    async sendFile(
      to: string,
      filePath: string,
      sessionType: XiaomifengSessionType = "p2p",
    ): Promise<XiaomifengSendResult> {
      try {
        const { basename } = await import("path");
        const message = messageCreator?.createFileMessage(filePath, basename(filePath));
        if (!message) {
          return { success: false, error: "Failed to create file message" };
        }

        const conversationId = buildConversationId(nim, to, sessionType);
        const result = await messageService.sendMessage(message, conversationId, {});

        return {
          success: true,
          msgId: result.message?.messageServerId,
          clientMsgId: result.message?.messageClientId,
        };
      } catch (error) {
        const { message: errorMessage, code: errorCode } = getErrorDetails(error);
        console.error(
          `[xiaomifeng] file send failed — error: ${errorMessage}${errorCode ? ` (code: ${errorCode})` : ""}`,
        );
        return { success: false, error: errorMessage };
      }
    },

    async sendAudio(
      to: string,
      filePath: string,
      duration: number,
      sessionType: XiaomifengSessionType = "p2p",
    ): Promise<XiaomifengSendResult> {
      try {
        const { basename } = await import("path");
        const message = messageCreator?.createAudioMessage?.(
          filePath,
          basename(filePath),
          "",
          duration,
        );
        if (!message) {
          return { success: false, error: "Failed to create audio message" };
        }

        const conversationId = buildConversationId(nim, to, sessionType);
        const result = await messageService.sendMessage(message, conversationId, {});

        return {
          success: true,
          msgId: result.message?.messageServerId,
          clientMsgId: result.message?.messageClientId,
        };
      } catch (error) {
        const { message: errorMessage, code: errorCode } = getErrorDetails(error);
        console.error(
          `[xiaomifeng] audio send failed — error: ${errorMessage}${errorCode ? ` (code: ${errorCode})` : ""}`,
        );
        return { success: false, error: errorMessage };
      }
    },

    async sendVideo(
      to: string,
      filePath: string,
      duration: number,
      width: number,
      height: number,
      sessionType: XiaomifengSessionType = "p2p",
    ): Promise<XiaomifengSendResult> {
      try {
        const { basename } = await import("path");
        const message = messageCreator?.createVideoMessage?.(
          filePath,
          basename(filePath),
          "",
          duration,
          width,
          height,
        );
        if (!message) {
          return { success: false, error: "Failed to create video message" };
        }

        const conversationId = buildConversationId(nim, to, sessionType);
        const result = await messageService.sendMessage(message, conversationId, {});

        return {
          success: true,
          msgId: result.message?.messageServerId,
          clientMsgId: result.message?.messageClientId,
        };
      } catch (error) {
        const { message: errorMessage, code: errorCode } = getErrorDetails(error);
        console.error(
          `[xiaomifeng] video send failed — error: ${errorMessage}${errorCode ? ` (code: ${errorCode})` : ""}`,
        );
        return { success: false, error: errorMessage };
      }
    },

    async replyText(
      to: string,
      text: string,
      originalMsg: unknown,
      forcePushAccountIds: string[],
      _sessionType: XiaomifengSessionType = "p2p",
    ): Promise<XiaomifengSendResult> {
      const clientMsgId = randomUUID().replace(/-/g, "");

      const sendParams = {
        pushConfig: {
          forcePush: true,
          forcePushAccountIds,
        },
        antispamConfig: {
          antispamEnabled: cfg.antispamEnabled ?? true,
        },
      };

      const attempt = async (retry: boolean): Promise<XiaomifengSendResult> => {
        try {
          const replyMsg = messageCreator?.createTextMessage(text);
          if (!replyMsg) {
            return {
              success: false,
              error: "Failed to create reply text message",
            };
          }
          replyMsg.messageClientId = clientMsgId;

          const result = await messageService.replyMessage(replyMsg, originalMsg, sendParams);
          return {
            success: true,
            msgId: result.message?.messageServerId,
            clientMsgId: result.message?.messageClientId,
          };
        } catch (error) {
          const { message: errorMessage, code: errorCode } = getErrorDetails(error);
          console.error(
            `[xiaomifeng] reply failed — error: ${errorMessage}${errorCode ? ` (code: ${errorCode})` : ""}, clientMsgId: ${clientMsgId}${retry ? " (retry)" : ""}`,
          );
          return {
            success: false,
            error: errorMessage,
            errorCode,
          };
        }
      };

      const first = await attempt(false);
      if (first.success) {
        return first;
      }

      return attempt(true);
    },

    async sendStreamMessage(params: {
      to: string;
      sessionType?: XiaomifengSessionType;
      baseMessage?: unknown;
      streamChunkParams: {
        text: string;
        index?: number;
        finish?: number;
      };
    }): Promise<XiaomifengSendResult> {
      try {
        const { to, sessionType = "p2p", baseMessage, streamChunkParams } = params;

        let message = baseMessage as NimOutgoingMessage | undefined;

        if (!message) {
          const createdMessage = messageCreator?.createTextMessage(streamChunkParams.text);
          message = createdMessage ?? undefined;
          if (!message) {
            return {
              success: false,
              error: "Failed to create base message for stream",
            };
          }
        }

        const conversationId = buildConversationId(nim, to, sessionType);

        const result = await messageService.sendStreamMessage(
          message,
          conversationId,
          {},
          streamChunkParams,
        );

        return {
          success: true,
          msgId: result.messageServerId,
          clientMsgId: result.messageClientId,
          baseMessage: result,
        };
      } catch (error) {
        const { message: errorMessage, code: errorCode } = getErrorDetails(error);
        console.error(
          `[xiaomifeng] stream message failed — error: ${errorMessage}${errorCode ? ` (code: ${errorCode})` : ""}`,
        );
        return {
          success: false,
          error: errorMessage,
        };
      }
    },

    onMessage(callback: (msg: XiaomifengMessageEvent) => void): void {
      msgCallbackSet.add(callback);
    },

    offMessage(callback: (msg: XiaomifengMessageEvent) => void): void {
      msgCallbackSet.delete(callback);
    },

    onConnectionChange(callback: (state: string) => void): void {
      connCallbackSet.add(callback);
    },

    async destroy(): Promise<void> {
      await instance.logout();
      await nim.destroy();
      clientCache.delete(cacheKey);
      messageCallbacks.delete(cacheKey);
      connectionCallbacks.delete(cacheKey);
    },
  };

  clientCache.set(cacheKey, instance);
  return instance;
}

/**
 * Return a cached client instance.
 */
export function getCachedXiaomifengClient(
  cfg: XiaomifengInstanceConfig,
): XiaomifengClientInstance | undefined {
  const creds = resolveXiaomifengCredentials(cfg);
  if (!creds) {
    return undefined;
  }
  const cacheKey = `${creds.appKey}:${creds.account}`;
  return clientCache.get(cacheKey);
}

/**
 * Clear the client cache.
 */
export async function clearXiaomifengClientCache(cfg?: XiaomifengInstanceConfig): Promise<void> {
  if (cfg) {
    const creds = resolveXiaomifengCredentials(cfg);
    if (!creds) {
      return;
    }
    const cacheKey = `${creds.appKey}:${creds.account}`;
    const client = clientCache.get(cacheKey);
    if (client) {
      await client.destroy();
    }
  } else {
    for (const client of clientCache.values()) {
      await client.destroy();
    }
    clientCache.clear();
  }
}
