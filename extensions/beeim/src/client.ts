/**
 * BeeIM Client - @yxim/nim-bot V2 API 封装
 *
 * 使用网易云信 IM Bot SDK (@yxim/nim-bot)
 */

import { resolveBeeimCredentials, isBeeimP2pAllowed } from "./accounts.js";
import type {
  BeeimInstanceConfig,
  BeeimClientInstance,
  BeeimMessageEvent,
  BeeimSendResult,
  BeeimSessionType,
  BeeimMessageType,
  BeeimAttachment,
  BeeimP2pPolicy,
} from "./types.js";

// 客户端缓存
const clientCache = new Map<string, BeeimClientInstance>();

// 消息回调管理
const messageCallbacks = new Map<string, Set<(msg: BeeimMessageEvent) => void>>();
const connectionCallbacks = new Map<string, Set<(state: string) => void>>();

/**
 * 将 V2 消息类型转换为我们的类型
 */
function convertMessageType(v2Type: number): BeeimMessageType {
  // V2NIMMessageType 枚举
  const typeMap: Record<number, BeeimMessageType> = {
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
 * 从 conversationId 解析会话类型
 * conversationId 格式: {appId}|{type}|{targetId}
 */
function parseConversationId(conversationId: string): {
  sessionType: BeeimSessionType;
  targetId: string;
} {
  const parts = conversationId.split("|");
  if (parts.length >= 3) {
    const typeNum = parseInt(parts[1], 10);
    const sessionType: BeeimSessionType =
      typeNum === 1 ? "p2p" : typeNum === 2 ? "team" : typeNum === 3 ? "superTeam" : "p2p";
    return { sessionType, targetId: parts[2] };
  }
  return { sessionType: "p2p", targetId: "" };
}

/**
 * 构建 conversationId
 */
function buildConversationId(nim: any, accountId: string, sessionType: BeeimSessionType): string {
  const conversationIdUtil = nim.V2NIMConversationIdUtil;
  if (conversationIdUtil) {
    switch (sessionType) {
      case "p2p":
        return conversationIdUtil.p2pConversationId(accountId) || "";
      case "team":
        return conversationIdUtil.teamConversationId(accountId) || "";
      case "superTeam":
        return conversationIdUtil.superTeamConversationId(accountId) || "";
      default:
        return conversationIdUtil.p2pConversationId(accountId) || "";
    }
  }
  // fallback: 手动构建
  const typeNum = sessionType === "p2p" ? 1 : sessionType === "team" ? 2 : 3;
  return `0|${typeNum}|${accountId}`;
}

/**
 * 解析 V2 消息附件
 */
function parseV2Attachment(msg: any): BeeimAttachment | undefined {
  const attachment = msg.attachment;
  if (!attachment) return undefined;

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
 * 将 V2 消息转换为我们的消息事件格式
 */
function convertV2ToMessageEvent(msg: any): BeeimMessageEvent {
  const { sessionType } = parseConversationId(msg.conversationId || "");

  // Extract forcePushAccountIds from V2 push config
  const forcePushAccountIds: string[] | undefined =
    msg.pushConfig?.forcePushAccountIds ?? undefined;

  return {
    msgId: String(msg.messageServerId || msg.messageClientId || ""),
    clientMsgId: String(msg.messageClientId || ""),
    sessionType,
    from: String(msg.senderId || ""),
    to: String(msg.receiverId || ""),
    type: convertMessageType(msg.messageType),
    text: msg.text || "",
    time: msg.createTime || Date.now(),
    attach: parseV2Attachment(msg),
    ext: msg.serverExtension ? JSON.parse(msg.serverExtension) : undefined,
    forcePushAccountIds,
    fromNick: msg.senderName || undefined,
    rawMsg: msg,
  };
}

/**
 * 创建 BeeIM 客户端实例 (@yxim/nim-bot)
 */
export async function createBeeimClient(cfg: BeeimInstanceConfig): Promise<BeeimClientInstance> {
  const creds = resolveBeeimCredentials(cfg);
  if (!creds) {
    throw new Error("BeeIM credentials not configured");
  }

  const cacheKey = `${creds.appKey}:${creds.account}`;

  // 检查缓存
  const cached = clientCache.get(cacheKey);
  if (cached && cached.initialized) {
    return cached;
  }

  // 动态导入 @yxim/nim-bot
  const NIMModule = await import("@yxim/nim-bot");
  const NIM = NIMModule.default;

  // Build privateConf from advanced config fields
  const privateConf: Record<string, unknown> = {};
  const adv = cfg.advanced;
  if (adv?.weblbsUrl) privateConf.weblbsUrl = adv.weblbsUrl;
  if (adv?.link_web) privateConf.link_web = adv.link_web;
  if (adv?.nos_uploader) privateConf.nos_uploader = adv.nos_uploader;
  if (adv?.nos_downloader_v2) privateConf.nos_downloader_v2 = adv.nos_downloader_v2;
  if (adv?.nosSsl !== undefined) privateConf.nosSsl = adv.nosSsl;
  if (adv?.nos_accelerate) privateConf.nos_accelerate = adv.nos_accelerate;
  if (adv?.nos_accelerate_host !== undefined)
    privateConf.nos_accelerate_host = adv.nos_accelerate_host;

  const otherOptions: Record<string, unknown> = {};
  if (Object.keys(privateConf).length > 0) {
    otherOptions.privateConf = privateConf;
  }

  //@ts-ignore
  const nim = new NIM(
    {
      appkey: creds.appKey,
      apiVersion: "v2",
      debugLevel: cfg.advanced?.debug ? "debug" : "off",
    },
    Object.keys(otherOptions).length > 0 ? otherOptions : undefined,
  );

  if (Object.keys(privateConf).length > 0) {
    console.log(`[beeim] privateConf applied — keys: ${Object.keys(privateConf).join(", ")}`);
  }

  let loggedIn = false;
  const msgCallbackSet = new Set<(msg: BeeimMessageEvent) => void>();
  const connCallbackSet = new Set<(state: string) => void>();

  messageCallbacks.set(cacheKey, msgCallbackSet);
  connectionCallbacks.set(cacheKey, connCallbackSet);

  // Gate that opens once the SDK's initial offline-message sync completes.
  // Until then, onReceiveMessages carries offline backlog — we skip it.
  let syncFinished = false;
  let offlineDropped = 0;

  // 获取服务引用
  const loginService = nim.V2NIMLoginService;
  const messageService = nim.V2NIMMessageService;
  const messageCreator = nim.V2NIMMessageCreator;
  const friendService = nim.V2NIMFriendService;

  // Mutable policy state — updated via updateP2pPolicy() when config reloads.
  let liveP2pPolicy = (cfg.p2p?.policy as BeeimP2pPolicy) ?? "open";
  let liveP2pAllowFrom: Array<string | number> = cfg.p2p?.allowFrom ?? [];

  if (friendService) {
    friendService.on("onFriendAddApplication", async (application: any) => {
      const applicantId = String(application.applicantAccountId ?? "");
      if (!applicantId) {
        console.log("[beeim] friend request ignored — missing applicant id");
        return;
      }

      console.log(`[beeim] friend request received — applicant: ${applicantId}`);

      const check = isBeeimP2pAllowed({
        p2pPolicy: liveP2pPolicy,
        allowFrom: liveP2pAllowFrom,
        senderId: applicantId,
      });

      if (!check.allowed) {
        console.log(
          `[beeim] friend request not auto-accepted — applicant: ${applicantId}, reason: ${check.reason ?? "policy"}`,
        );
        return;
      }

      try {
        await friendService.acceptAddApplication(application);
        console.log(`[beeim] friend request auto-accepted — applicant: ${applicantId}`);
      } catch (err: any) {
        const errorMessage = err?.message ?? err?.desc ?? String(err);
        console.error(
          `[beeim] friend request accept failed — applicant: ${applicantId}, error: ${errorMessage}`,
        );
      }
    });
    console.log(`[beeim] friend request listener registered — policy: ${liveP2pPolicy}`);
  }

  if (!loginService || !messageService) {
    throw new Error("BeeIM SDK V2 services not available");
  }

  // Offline message batch — logged and dropped, not dispatched to handlers.
  messageService.on("onReceiveOfflineMessages", (messages: any[]) => {
    console.log(`[beeim] offline messages received — count: ${messages.length} (skipped)`);
    offlineDropped += messages.length;
  });

  // Sync completion — from this point onReceiveMessages carries live messages only.
  loginService.on("onDataSync", (type: number, state: number, error: any) => {
    // V2NIMDataSyncState: 2 = complete
    if (state === 2) {
      if (!syncFinished) {
        syncFinished = true;
        console.log(
          `[beeim] sync finished — ready for live messages, offline messages dropped: ${offlineDropped}`,
        );
      }
    }
  });

  // 注册消息接收回调
  // Dedup set: tracks msgIds seen in the current session to avoid processing
  // the same message twice (SDK occasionally delivers duplicates in one batch).
  const recentMsgIds = new Set<string>();
  messageService.on("onReceiveMessages", (messages: any[]) => {
    if (!syncFinished) {
      console.log(
        `[beeim] onReceiveMessages before sync — dropping ${messages.length} message(s) (offline backlog)`,
      );
      offlineDropped += messages.length;
      return;
    }
    console.log(`[beeim] received messages — count: ${messages.length}`);
    for (const msg of messages) {
      const event = convertV2ToMessageEvent(msg);
      const dedupKey = event.msgId || event.clientMsgId;
      if (dedupKey && recentMsgIds.has(dedupKey)) {
        console.log(`[beeim] duplicate message dropped — id: ${dedupKey}`);
        continue;
      }
      if (dedupKey) {
        recentMsgIds.add(dedupKey);
        // Keep the set bounded to the last 200 ids.
        if (recentMsgIds.size > 200) {
          recentMsgIds.delete(recentMsgIds.values().next().value!);
        }
      }
      console.log(
        `[beeim] received message — sender: ${event.from}, type: ${event.type}, session: ${event.sessionType}, target: ${event.to}, message id: ${event.msgId}, timestamp: ${event.time}`,
      );
      msgCallbackSet.forEach((cb) => cb(event));
    }
  });

  // 注册发送消息状态回调
  messageService.on("onSendMessage", (msg: any) => {
    console.log(
      `[beeim] send status update — message id: ${msg.messageClientId ?? "unknown"}, state: ${msg.sendingState}`,
    );
  });

  // 注册登录状态回调
  loginService.on("onLoginStatus", (status: number) => {
    console.log(`[beeim] login status changed — status: ${status}`);
    // V2NIMLoginStatus: 0=LOGOUT, 1=LOGINED, 2=LOGINING
    if (status === 1) {
      loggedIn = true;
      connCallbackSet.forEach((cb) => cb("connected"));
    } else if (status === 0) {
      loggedIn = false;
      connCallbackSet.forEach((cb) => cb("logout"));
    }
  });

  loginService.on("onKickedOffline", (detail: any) => {
    const detailMessage = detail?.reasonDesc ?? detail?.reason ?? String(detail);
    console.log(`[beeim] kicked offline — reason: ${detailMessage}`);
    loggedIn = false;
    connCallbackSet.forEach((cb) => cb("kickout"));
  });

  loginService.on("onDisconnected", (error: any) => {
    const errorMessage = error?.message ?? error?.desc ?? String(error);
    console.log(`[beeim] disconnected — error: ${errorMessage}`);
    connCallbackSet.forEach((cb) => cb("disconnected"));
  });

  const instance: BeeimClientInstance = {
    initialized: true,
    loggedIn: false,
    account: creds.account,
    nativeNim: nim,

    updateP2pPolicy(policy: BeeimP2pPolicy, allowFrom: Array<string | number>) {
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

        console.log(
          `[beeim] login started — account: ${creds.account}, aiBot: ${aiBotValue} (legacyLogin: ${legacyLogin})`,
        );
        await loginService.login(creds.account, creds.token, {
          aiBot: aiBotValue,
        });
        loggedIn = true;
        instance.loggedIn = true;
        console.log(`[beeim] login successful — account: ${creds.account}, aiBot: ${aiBotValue}`);
        return true;
      } catch (error: any) {
        const errorMessage = error?.message ?? error?.desc ?? String(error);
        const errorCode = error?.code ?? error?.res_code;
        console.error(
          `[beeim] login failed — error: ${errorMessage}${errorCode ? ` (code: ${errorCode})` : ""}`,
        );
        return false;
      }
    },

    async logout(): Promise<void> {
      try {
        await loginService.logout();
        loggedIn = false;
        instance.loggedIn = false;
        console.log(`[beeim] logout complete — account: ${creds.account}`);
      } catch (error) {
        const errorMessage = (error as any)?.message ?? String(error);
        console.error(`[beeim] logout failed — error: ${errorMessage}`);
      }
    },

    async sendText(
      to: string,
      text: string,
      sessionType: BeeimSessionType = "p2p",
    ): Promise<BeeimSendResult> {
      try {
        const message = messageCreator?.createTextMessage(text);
        if (!message) {
          return { success: false, error: "Failed to create text message" };
        }

        const conversationId = buildConversationId(nim, to, sessionType);
        console.log(
          `[beeim] sending text — target: ${conversationId}, session: ${sessionType}, length: ${text.length}`,
        );

        const result = await messageService.sendMessage(message, conversationId, {
          antispamConfig: {
            antispamEnabled: cfg.antispamEnabled ?? true,
          },
        });

        console.log(
          `[beeim] text sent — message id: ${result.message?.messageServerId ?? "unknown"}`,
        );
        return {
          success: true,
          msgId: result.message?.messageServerId,
          clientMsgId: result.message?.messageClientId,
        };
      } catch (error: any) {
        const errorMessage = error?.message ?? error?.desc ?? String(error);
        const errorCode = error?.code ?? error?.res_code;
        console.error(
          `[beeim] text send failed — error: ${errorMessage}${errorCode ? ` (code: ${errorCode})` : ""}`,
        );
        return { success: false, error: error.message || String(error) };
      }
    },

    async sendImage(
      to: string,
      filePath: string,
      sessionType: BeeimSessionType = "p2p",
    ): Promise<BeeimSendResult> {
      try {
        const { basename } = await import("path");
        const message = messageCreator?.createImageMessage(filePath, basename(filePath));
        if (!message) {
          return { success: false, error: "Failed to create image message" };
        }

        const conversationId = buildConversationId(nim, to, sessionType);
        console.log(
          `[beeim] sending image — target: ${conversationId}, session: ${sessionType}, file: ${basename(filePath)}`,
        );

        const result = await messageService.sendMessage(message, conversationId, {});

        return {
          success: true,
          msgId: result.message?.messageServerId,
          clientMsgId: result.message?.messageClientId,
        };
      } catch (error: any) {
        const errorMessage = error?.message ?? error?.desc ?? String(error);
        const errorCode = error?.code ?? error?.res_code;
        console.error(
          `[beeim] image send failed — error: ${errorMessage}${errorCode ? ` (code: ${errorCode})` : ""}`,
        );
        return { success: false, error: error.message || String(error) };
      }
    },

    async sendFile(
      to: string,
      filePath: string,
      sessionType: BeeimSessionType = "p2p",
    ): Promise<BeeimSendResult> {
      try {
        const { basename } = await import("path");
        const message = messageCreator?.createFileMessage(filePath, basename(filePath));
        if (!message) {
          return { success: false, error: "Failed to create file message" };
        }

        const conversationId = buildConversationId(nim, to, sessionType);
        console.log(
          `[beeim] sending file — target: ${conversationId}, session: ${sessionType}, file: ${basename(filePath)}`,
        );

        const result = await messageService.sendMessage(message, conversationId, {});

        return {
          success: true,
          msgId: result.message?.messageServerId,
          clientMsgId: result.message?.messageClientId,
        };
      } catch (error: any) {
        const errorMessage = error?.message ?? error?.desc ?? String(error);
        const errorCode = error?.code ?? error?.res_code;
        console.error(
          `[beeim] file send failed — error: ${errorMessage}${errorCode ? ` (code: ${errorCode})` : ""}`,
        );
        return { success: false, error: error.message || String(error) };
      }
    },

    async sendAudio(
      to: string,
      filePath: string,
      duration: number,
      sessionType: BeeimSessionType = "p2p",
    ): Promise<BeeimSendResult> {
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
      } catch (error: any) {
        const errorMessage = error?.message ?? error?.desc ?? String(error);
        const errorCode = error?.code ?? error?.res_code;
        console.error(
          `[beeim] audio send failed — error: ${errorMessage}${errorCode ? ` (code: ${errorCode})` : ""}`,
        );
        return { success: false, error: error.message || String(error) };
      }
    },

    async sendVideo(
      to: string,
      filePath: string,
      duration: number,
      width: number,
      height: number,
      sessionType: BeeimSessionType = "p2p",
    ): Promise<BeeimSendResult> {
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
      } catch (error: any) {
        const errorMessage = error?.message ?? error?.desc ?? String(error);
        const errorCode = error?.code ?? error?.res_code;
        console.error(
          `[beeim] video send failed — error: ${errorMessage}${errorCode ? ` (code: ${errorCode})` : ""}`,
        );
        return { success: false, error: error.message || String(error) };
      }
    },

    async replyText(
      to: string,
      text: string,
      originalMsg: unknown,
      forcePushAccountIds: string[],
      sessionType: BeeimSessionType = "p2p",
    ): Promise<BeeimSendResult> {
      try {
        const replyMsg = messageCreator?.createTextMessage(text);
        if (!replyMsg) {
          return {
            success: false,
            error: "Failed to create reply text message",
          };
        }

        const sendParams = {
          pushConfig: {
            forcePush: true,
            forcePushAccountIds,
          },
          antispamConfig: {
            antispamEnabled: cfg.antispamEnabled ?? true,
          },
        };

        const conversationId = buildConversationId(nim, to, sessionType);
        console.log(
          `[beeim] sending reply — target: ${conversationId}, session: ${sessionType}, force-push: [${forcePushAccountIds.join(", ")}]`,
        );

        const result = await messageService.replyMessage(replyMsg, originalMsg as any, sendParams);
        console.log(
          `[beeim] reply sent — message id: ${result.message?.messageServerId ?? "unknown"}`,
        );
        return {
          success: true,
          msgId: result.message?.messageServerId,
          clientMsgId: result.message?.messageClientId,
        };
      } catch (error: any) {
        const errorMessage = error?.message ?? error?.desc ?? String(error);
        const errorCode = error?.code ?? error?.res_code;
        console.error(
          `[beeim] reply failed — error: ${errorMessage}${errorCode ? ` (code: ${errorCode})` : ""}`,
        );
        return {
          success: false,
          error: error.message || error.desc || String(error),
        };
      }
    },

    async sendStreamMessage(params: {
      to: string;
      sessionType?: BeeimSessionType;
      baseMessage?: any;
      streamChunkParams: {
        text: string;
        index?: number;
        finish?: number;
      };
    }): Promise<BeeimSendResult> {
      try {
        const { to, sessionType = "p2p", baseMessage, streamChunkParams } = params;

        let message = baseMessage;

        if (!message) {
          message = messageCreator?.createTextMessage(streamChunkParams.text);
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
      } catch (error: any) {
        const errorMessage = error?.message ?? error?.desc ?? String(error);
        const errorCode = error?.code ?? error?.res_code;
        console.error(
          `[beeim] stream message failed — error: ${errorMessage}${errorCode ? ` (code: ${errorCode})` : ""}`,
        );
        return {
          success: false,
          error: error.message || error.desc || String(error),
        };
      }
    },

    onMessage(callback: (msg: BeeimMessageEvent) => void): void {
      msgCallbackSet.add(callback);
    },

    offMessage(callback: (msg: BeeimMessageEvent) => void): void {
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
 * 获取缓存的客户端
 */
export function getCachedBeeimClient(cfg: BeeimInstanceConfig): BeeimClientInstance | undefined {
  const creds = resolveBeeimCredentials(cfg);
  if (!creds) return undefined;
  const cacheKey = `${creds.appKey}:${creds.account}`;
  return clientCache.get(cacheKey);
}

/**
 * 清除客户端缓存
 */
export async function clearBeeimClientCache(cfg?: BeeimInstanceConfig): Promise<void> {
  if (cfg) {
    const creds = resolveBeeimCredentials(cfg);
    if (!creds) return;
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
