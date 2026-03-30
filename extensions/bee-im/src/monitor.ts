/**
 * BeeIM 消息监听器
 * 用于 Gateway 启动时监听消息，通过 OpenClaw ChannelRuntime dispatch 给 AI
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BeeIMClient } from "./client.js";
import { setBeeIMRuntimeStatus } from "./runtime.js";
import type { BeeIMMessage, ParsedMessageContent, ResolvedBeeIMAccount } from "./types.js";

export interface MonitorBeeIMParams {
  runtime: unknown;
  channelRuntime?: unknown;
  cfg: unknown;
  abortSignal?: AbortSignal;
  accountId: string;
  account: ResolvedBeeIMAccount;
}

/**
 * 全局客户端缓存，供 outbound sendText 使用。
 * 启动新连接前必须先 disconnect + delete 旧实例，防止多实例并发登录互踢。
 */
export const activeClients = new Map<string, BeeIMClient>();

/** ChannelRuntime 缓存 (RuntimeEnv["channel"])，由 startAccount ctx 注入 */
let channelRuntimeRef: unknown = null;
let cfgRef: unknown = null;

type ChannelRuntime = {
  reply: {
    dispatchReplyWithBufferedBlockDispatcher: (params: {
      ctx: Record<string, unknown>;
      cfg: unknown;
      dispatcherOptions: {
        deliver: (payload: { text?: string }, info: { kind: string }) => Promise<void>;
        onError?: (err: unknown, info: { kind: string }) => void;
        onIdle?: () => void;
      };
    }) => Promise<{ queuedFinal: boolean; counts: Record<string, number> }>;
  };
};

function getChannelRuntime(): ChannelRuntime {
  if (!channelRuntimeRef) throw new Error("ChannelRuntime not initialized");
  return channelRuntimeRef as ChannelRuntime;
}

/**
 * 启动 BeeIM 消息监听（挂起直到 abortSignal 触发）
 */
export async function monitorBeeIMProvider(params: MonitorBeeIMParams): Promise<void> {
  const { cfg, abortSignal, accountId, account } = params;

  if (!account.configured) {
    throw new Error(`BeeIM account ${accountId} is not configured (missing passport or token)`);
  }

  // 保存 channelRuntime 和 cfg（每次都更新，不做条件判断）
  if (params.channelRuntime) channelRuntimeRef = params.channelRuntime;
  if (cfg) cfgRef = cfg;

  // ── 先清理旧实例，避免同账号多连接互踢 ──
  const existing = activeClients.get(accountId);
  if (existing) {
    console.log(
      `[BeeIM Monitor] Disconnecting existing client for account ${accountId} before re-connecting`,
    );
    existing.disconnect();
    activeClients.delete(accountId);
  }

  const client = new BeeIMClient({
    wsUrl: account.wsUrl,
    passport: account.passport,
    token: account.token,
    app: account.app,
    business: account.business,
  });

  activeClients.set(accountId, client);

  setBeeIMRuntimeStatus(accountId, {
    running: true,
    lastStartAt: Date.now(),
    wsUrl: account.wsUrl,
  });

  // 监听消息
  client.on("message", async (message: BeeIMMessage) => {
    if (activeClients.get(accountId) !== client) return;

    // 提取消息内容：支持文本消息(msgType=1)和图片消息(msgType=2)
    const extracted = await extractMessageContent(message);
    if (!extracted) {
      console.log(
        `[BeeIM Monitor] Skipping unsupported message: msgId=${message.msgId}, msgType=${message.lastMessage.msgType}`,
      );
      return;
    }

    if (!channelRuntimeRef) {
      console.warn(`[BeeIM Monitor] channelRuntime not available, cannot dispatch`);
      return;
    }

    try {
      const core = getChannelRuntime();
      const currentCfg = cfgRef;
      const isGroup = message.chatType === 2;
      const from = message.senderId;
      const to = isGroup ? message.chatId : account.passport;
      const sessionKey = `bee-im:${accountId}:${message.sessionId}`;
      const replyTo = isGroup ? message.chatId : from;

      // MsgContext — OpenClaw 用于路由和 AI 处理的上下文对象
      const ctx: Record<string, unknown> = {
        Body: extracted.body,
        RawBody: extracted.body,
        CommandBody: extracted.body,
        From: from,
        To: to,
        SessionKey: sessionKey,
        AccountId: accountId,
        ChatType: isGroup ? "group" : "direct",
        SenderName: from,
        SenderId: from,
        Provider: "bee-im",
        Surface: "bee-im",
        MessageSid: String(message.msgId),
        Timestamp: message.sendTime,
        WasMentioned: false,
        CommandAuthorized: true,
        OriginatingChannel: "bee-im",
        OriginatingTo: to,
      };

      // 图片消息：附加文件路径和附件信息
      if (extracted.attachedFilePath) {
        ctx.AttachedFilePath = extracted.attachedFilePath;
      }
      if (extracted.attachments && extracted.attachments.length > 0) {
        ctx.Attachments = extracted.attachments;
      }

      console.log(
        `[BeeIM Monitor] Dispatching message from ${from}, session=${sessionKey}, type=${extracted.type}`,
      );

      const result = await core.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg: currentCfg,
        dispatcherOptions: {
          deliver: async (payload: { text?: string }) => {
            const replyText = payload.text ?? "";
            if (!replyText.trim()) return;
            console.log(
              `[BeeIM Monitor] deliver: "${replyText.slice(0, 200)}${replyText.length > 200 ? "..." : ""}"`,
            );
            try {
              await client.sendTextMessage({ to: replyTo, text: replyText });
              console.log(`[BeeIM Monitor] Reply sent to ${replyTo}`);
            } catch (err) {
              console.error(`[BeeIM Monitor] Failed to send reply to ${replyTo}:`, err);
            }
          },
          onError: (err: unknown) => {
            console.error(`[BeeIM Monitor] Reply error:`, err);
          },
          onIdle: () => {},
        },
      });

      console.log(
        `[BeeIM Monitor] Dispatch result: queuedFinal=${result?.queuedFinal}, counts=${JSON.stringify(result?.counts)}`,
      );
    } catch (err) {
      console.error(`[BeeIM Monitor] Failed to dispatch message:`, err);
    }
  });

  // 监听错误
  client.on("error", (error) => {
    if (activeClients.get(accountId) !== client) return;
    console.error(`[BeeIM Monitor] Error for account ${accountId}:`, error);
    setBeeIMRuntimeStatus(accountId, { lastError: error.message });
  });

  // 监听断开连接
  client.on("disconnected", (info) => {
    if (activeClients.get(accountId) !== client) return;
    console.log(`[BeeIM Monitor] Disconnected: ${accountId}`, info);
    setBeeIMRuntimeStatus(accountId, { running: false, lastStopAt: Date.now() });
  });

  // 监听重连成功
  client.on("connected", () => {
    if (activeClients.get(accountId) !== client) return;
    setBeeIMRuntimeStatus(accountId, { running: true, lastStartAt: Date.now(), lastError: null });
  });

  // 监听重连失败
  client.on("reconnect_failed", () => {
    if (activeClients.get(accountId) !== client) return;
    console.error(`[BeeIM Monitor] Reconnect exhausted for account ${accountId}, giving up`);
    setBeeIMRuntimeStatus(accountId, {
      running: false,
      lastStopAt: Date.now(),
      lastError: "Reconnect failed after max attempts",
    });
    activeClients.delete(accountId);
  });

  // 监听认证失败（不会重连）
  client.on("auth_failed", (reason) => {
    if (activeClients.get(accountId) !== client) return;
    console.error(`[BeeIM Monitor] Auth failed for account ${accountId}:`, reason);
    setBeeIMRuntimeStatus(accountId, {
      running: false,
      lastStopAt: Date.now(),
      lastError: `Auth failed: ${JSON.stringify(reason)}`,
    });
    activeClients.delete(accountId);
  });

  // 连接服务器
  try {
    await client.connect();
    console.log(`[BeeIM Monitor] Connected successfully for account ${accountId}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[BeeIM Monitor] Initial connect failed for account ${accountId}:`, errorMessage);
    if (activeClients.get(accountId) === client) {
      activeClients.delete(accountId);
    }
    setBeeIMRuntimeStatus(accountId, {
      running: false,
      lastStopAt: Date.now(),
      lastError: errorMessage,
    });
    throw error;
  }

  // ── 关键：挂起直到 abortSignal 触发，防止 OpenClaw 认为 provider 结束而 auto-restart ──
  return new Promise<void>((resolve) => {
    const handleAbort = () => {
      console.log(`[BeeIM Monitor] Abort signal received for account ${accountId}, shutting down`);
      client.disconnect();
      if (activeClients.get(accountId) === client) {
        activeClients.delete(accountId);
      }
      setBeeIMRuntimeStatus(accountId, { running: false, lastStopAt: Date.now() });
      resolve();
    };

    if (abortSignal?.aborted) {
      handleAbort();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    // 没有 abortSignal 时，监听最终停止事件
    const onFinalStop = () => {
      if (activeClients.get(accountId) === client) {
        activeClients.delete(accountId);
      }
      resolve();
    };
    client.once("reconnect_failed", onFinalStop);
    client.once("auth_failed", onFinalStop);
  });
}

// ============================================================================
// Message Content Extraction (支持文本 + 图片)
// ============================================================================

/** 提取后的消息内容 */
interface ExtractedContent {
  /** 消息类型标记 */
  type: "text" | "image";
  /** 用于 Body/RawBody/CommandBody 的文本 */
  body: string;
  /** 图片下载到本地的路径 (仅图片消息) */
  attachedFilePath?: string;
  /** 附件信息列表 (仅图片消息) */
  attachments?: Array<{
    type: "image";
    url: string;
    width?: number;
    height?: number;
    localPath?: string;
  }>;
}

/**
 * 从 URL 推断图片扩展名
 */
function inferImageExtension(imageUrl: string): string {
  try {
    const urlObj = new URL(imageUrl);
    const pathname = urlObj.pathname;
    const dotIdx = pathname.lastIndexOf(".");
    if (dotIdx >= 0) {
      const ext = pathname.slice(dotIdx + 1).toLowerCase();
      if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(ext)) {
        return ext;
      }
    }
  } catch {
    // URL 解析失败，使用默认
  }
  return "jpg";
}

/**
 * 下载图片到本地（参考 POPO 的 downloadFile 方式）
 *
 * 存储路径: ~/.openclaw/downloads/beeim-images/<timestamp>-<filename>
 */
async function downloadImageToLocal(imageUrl: string): Promise<string | null> {
  try {
    console.log(`[BeeIM Monitor] 📥 Downloading image: ${imageUrl}`);

    const response = await fetch(imageUrl, {
      signal: AbortSignal.timeout(30000), // 30s timeout
    });
    if (!response.ok) {
      console.error(
        `[BeeIM Monitor] ❌ Failed to download image: HTTP ${response.status} from ${imageUrl}`,
      );
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const data = Buffer.from(arrayBuffer);

    // 推断文件名和扩展名
    const ext = inferImageExtension(imageUrl);
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    // 确保下载目录存在
    const downloadDir = join(homedir(), ".openclaw", "downloads", "beeim-images");
    await mkdir(downloadDir, { recursive: true });

    const filePath = join(downloadDir, fileName);
    await writeFile(filePath, data);

    console.log(`[BeeIM Monitor] ✅ Image downloaded to: ${filePath} (${data.length} bytes)`);
    return filePath;
  } catch (err) {
    console.error(`[BeeIM Monitor] ❌ Failed to download image:`, err);
    return null;
  }
}

/**
 * 解析图片消息内容 (msgType=2)
 *
 * content 字段格式:
 * {
 *   "url": "http://...",    // 图片地址
 *   "height": 640,          // 图片像素高
 *   "width": 427            // 图片像素宽
 * }
 */
function parseImageContent(content: ParsedMessageContent | string): {
  url: string;
  width?: number;
  height?: number;
} | null {
  let parsed: Record<string, unknown>;

  if (typeof content === "string") {
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (typeof content === "object" && content !== null) {
    parsed = content as Record<string, unknown>;
  } else {
    return null;
  }

  if (typeof parsed.url !== "string" || !parsed.url) {
    return null;
  }

  return {
    url: parsed.url,
    width: typeof parsed.width === "number" ? parsed.width : undefined,
    height: typeof parsed.height === "number" ? parsed.height : undefined,
  };
}

/**
 * 从消息中提取内容（统一入口，支持文本和图片）
 *
 * - msgType=1: 文本消息
 * - msgType=2: 图片消息（下载到本地，作为附件传递给 AI）
 */
async function extractMessageContent(message: BeeIMMessage): Promise<ExtractedContent | null> {
  const lastMsg = message.lastMessage;

  // ── msgType=1: 文本消息 ──
  if (lastMsg.msgType === 1) {
    const text = extractTextFromContent(lastMsg.content);
    if (!text) return null;
    return { type: "text", body: text };
  }

  // ── msgType=2: 图片消息 ──
  if (lastMsg.msgType === 2) {
    const imageInfo = parseImageContent(lastMsg.content);
    if (!imageInfo) {
      console.warn(
        `[BeeIM Monitor] ⚠️ Image message (msgType=2) has invalid content: msgId=${message.msgId}`,
      );
      return null;
    }

    console.log(
      `[BeeIM Monitor] 🖼️ Image message detected: url=${imageInfo.url}, ${imageInfo.width}x${imageInfo.height}`,
    );

    // 下载图片到本地（参考 POPO 的做法）
    const localPath = await downloadImageToLocal(imageInfo.url);

    // 构建消息体文本（即使下载失败也要传递图片信息给 AI）
    const sizeInfo =
      imageInfo.width && imageInfo.height ? ` (${imageInfo.width}x${imageInfo.height})` : "";
    const body = localPath
      ? `[图片消息${sizeInfo}, 已下载到: ${localPath}]`
      : `[图片消息${sizeInfo}: ${imageInfo.url}]`;

    return {
      type: "image",
      body,
      attachedFilePath: localPath ?? undefined,
      attachments: [
        {
          type: "image",
          url: imageInfo.url,
          width: imageInfo.width,
          height: imageInfo.height,
          localPath: localPath ?? undefined,
        },
      ],
    };
  }

  // 其他 msgType 暂不支持
  console.log(`[BeeIM Monitor] Skipping unsupported msgType=${lastMsg.msgType}`);
  return null;
}

/**
 * 从消息内容中提取纯文本 (msgType=1 的文本消息)
 */
function extractTextFromContent(content: ParsedMessageContent | string): string | null {
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (typeof parsed.text === "string") return parsed.text || null;
    } catch {
      return content || null;
    }
  }

  if (typeof content === "object" && content !== null && "text" in content) {
    return typeof content.text === "string" ? content.text || null : null;
  }

  return null;
}
