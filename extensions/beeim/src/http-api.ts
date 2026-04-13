/**
 * BeeIM HTTP API - 通过小蜜蜂 HTTP API 发送消息
 *
 * 基于 xiaomifengGateway.ts 的实现
 * 获取 accessToken 和发送消息的相关代码
 */

import { randomUUID } from "node:crypto";

/**
 * HTTP API URLs 和配置
 */
export const BEE_API_CONFIG = {
  DEFAULT_API_BASE: "https://api.mifengs.com",
  FIXED_HTTP_FROM: "beeClaw",
  APP_NAME: "beeClaw", // appName 固定值
};

/** Build per-base URL helpers */
export function buildApiUrls(apiBase: string) {
  const base = apiBase.replace(/\/$/, "");
  return {
    tokenUrl: `${base}/worklife-go/api/v1/claw/im/oauth2/accessToken`,
    sendUrl: `${base}/worklife-go/api/v1/claw/im/send`,
    fileCheckBaseUrl: `${base}/worklife-go/api/v1/claw/im/file/check`,
  };
}

/**
 * Access Token 缓存
 */
interface TokenCache {
  accessToken: string;
  expiry: number;
}

/** Per-accid token cache — multi-instance safe. */
const tokenCacheMap = new Map<string, TokenCache>();

/**
 * 获取 accessToken
 *
 * 参数说明（重要！两套不同的概念）：
 *
 * nimToken 格式: appKey-accid-token
 * 例如: daaae4918fcb957b65cc1f1dde0b2faa-515686154947791701-529e6255784bba712a7a007a58ec63a9
 *
 * Token 获取（认证）需要：
 *   AppKey = accid （第二部分）
 *   AppSecret = token （第三部分）
 *   AppName = 'beeClaw' （固定值）
 *
 * @param accid accid（来自 nimToken 的第二部分，用于认证）
 * @param token token（来自 nimToken 的第三部分，用于认证）
 * @returns accessToken
 */
export async function getAccessToken(
  accid: string,
  token: string,
  apiBase: string = BEE_API_CONFIG.DEFAULT_API_BASE,
): Promise<string> {
  if (!accid || !token) {
    throw new Error("[beeim] 获取 accessToken 需要 accid 和 token");
  }

  const now = Date.now();

  // Per-accid cache — reuse if more than 60 s remaining.
  const cached = tokenCacheMap.get(accid);
  if (cached && cached.expiry > now + 60_000) {
    console.log(
      `[beeim] 使用缓存的 accessToken — accid: ${accid}, 剩余有效期: ${Math.round((cached.expiry - now) / 1000)}s`,
    );
    return cached.accessToken;
  }

  console.log("[beeim] 获取新的 accessToken...");

  const { tokenUrl } = buildApiUrls(apiBase);

  // Token 获取需要三个参数：AppKey（accid）, AppSecret（token）, AppName
  const tokenPayload = {
    AppKey: accid, // 来自 nimToken 的第二部分（accid）
    AppSecret: token, // 来自 nimToken 的第三部分（token）
    AppName: BEE_API_CONFIG.APP_NAME, // appName 固定值为 'beeClaw'
  };

  const requestBody = JSON.stringify(tokenPayload);
  console.log(`[beeim] token API request — url: ${tokenUrl}, body: ${requestBody}`);

  try {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });

    const responseText = await response.text();
    console.log(`[beeim] token API response — status: ${response.status}, body: ${responseText}`);

    if (!response.ok) {
      console.error(
        `[beeim] token API failed — request body: ${requestBody}, status: ${response.status}, response: ${responseText}`,
      );
      throw new Error(`HTTP ${response.status}: ${responseText}`);
    }

    const result = JSON.parse(responseText);

    const accessToken = result.data?.accessToken || result.accessToken || result.access_token;
    const expiresIn =
      result.data?.expireIn ||
      result.data?.expiresIn ||
      result.expireIn ||
      result.expiresIn ||
      result.expires_in ||
      7200;

    if (!accessToken) {
      console.error(
        `[beeim] token API missing accessToken — request body: ${requestBody}, response: ${responseText}`,
      );
      throw new Error(`获取 accessToken 失败: ${JSON.stringify(result)}`);
    }

    tokenCacheMap.set(accid, { accessToken, expiry: now + expiresIn * 1000 });
    console.log(`[beeim] 获得 accessToken，有效期: ${expiresIn}s`);
    return accessToken;
  } catch (error: any) {
    console.error(
      `[beeim] 获取 accessToken 失败 — request body: ${requestBody}, error: ${error.message}`,
    );
    throw error;
  }
}

/**
 * 清除缓存的 accessToken
 */
export function clearAccessToken(accid?: string): void {
  if (accid) {
    tokenCacheMap.delete(accid);
    console.log(`[beeim] 清除缓存的 accessToken — accid: ${accid}`);
  } else {
    tokenCacheMap.clear();
    console.log("[beeim] 清除所有缓存的 accessToken");
  }
}

/**
 * 将长文本分割成块
 * @param text 文本内容
 * @param maxLength 最大长度（默认 1500）
 * @returns 文本块数组
 */
export function splitMessageIntoChunks(text: string, maxLength: number = 1500): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // 尝试在换行符处分割
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      // 尝试在空格处分割
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      // 强制在 maxLength 处分割
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

/**
 * 通过 HTTP API 发送消息
 *
 * 参数说明：
 * - appKey: nimToken 的第一部分（用于发送 API）
 * - accid: nimToken 的第二部分（用于 token 认证）
 * - token: nimToken 的第三部分（用于 token 认证）
 *
 * @param chatId 聊天 ID（接收者 ID）
 * @param text 消息文本
 * @param appKey appKey（nimToken 第一部分，用于发送 API）
 * @param accid accid（nimToken 第二部分，用于认证）
 * @param token token（nimToken 第三部分，用于认证）
 * @param isRetry 是否为重试（内部使用）
 * @param _chunkMsgIds 重试时复用的每块 clientMsgId（内部使用）
 */
export async function sendBeeMessage(
  chatId: string,
  text: string,
  appKey: string,
  accid: string,
  token: string,
  isGroup: boolean = false,
  apiBase: string = BEE_API_CONFIG.DEFAULT_API_BASE,
  isRetry: boolean = false,
  _chunkMsgIds?: string[],
): Promise<void> {
  if (!appKey || !accid || !token) {
    throw new Error("[beeim] HTTP API 配置不完整，需要 appKey, accid 和 token");
  }

  // 分割长消息
  const chunks = splitMessageIntoChunks(text);

  if (chunks.length > 1) {
    console.log(`[beeim] 消息过长 (${text.length} 字符)，分割为 ${chunks.length} 块`);
  }

  // 为每个分块生成 clientMsgId，重试时复用相同的 ID 以便服务端去重
  const chunkMsgIds: string[] =
    _chunkMsgIds && _chunkMsgIds.length === chunks.length
      ? _chunkMsgIds
      : chunks.map(() => randomUUID());

  // 获取 accessToken（会自动刷新）- 所有分块只需获取一次
  const accessToken = await getAccessToken(accid, token, apiBase);

  const { sendUrl } = buildApiUrls(apiBase);

  // 按顺序发送每个分块
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const clientMsgId = chunkMsgIds[i];

    // send API payload — appKey 字段使用 accid（与 token 认证保持一致）
    // 群聊用 chatType: "group" + to 键；单聊用 chatType: "single" + chatId 键
    const payload = {
      clientMsgId,
      from: BEE_API_CONFIG.FIXED_HTTP_FROM,
      appKey: accid,
      accessToken: accessToken,
      chatType: isGroup ? "group" : "single",
      msgType: "text",
      ...(isGroup ? { to: chatId } : { chatId: chatId }),
      content: JSON.stringify({ text: chunk }),
    };

    const chunkInfo = chunks.length > 1 ? ` (分块 ${i + 1}/${chunks.length})` : "";
    console.log(`[beeim] ========== HTTP 请求参数${chunkInfo} ==========`);
    console.log("[beeim] URL:", sendUrl);
    console.log("[beeim] Method: POST");
    console.log(
      "[beeim] Payload:",
      JSON.stringify(
        {
          clientMsgId,
          from: payload.from,
          appKey: payload.appKey,
          accessToken: payload.accessToken ? `${payload.accessToken.substring(0, 8)}****` : "(空)",
          chatType: payload.chatType,
          msgType: payload.msgType,
          ...(isGroup ? { to: chatId } : { chatId: chatId }),
          content: chunk.length > 100 ? chunk.substring(0, 100) + "..." : chunk,
          chunkLength: chunk.length,
        },
        null,
        2,
      ),
    );
    console.log("[beeim] =============================================");

    try {
      const response = await fetch(sendUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const responseText = await response.text();
      console.log(`[beeim] ========== HTTP 响应${chunkInfo} ==========`);
      console.log("[beeim] 状态:", response.status, response.statusText);
      console.log("[beeim] 响应体:", responseText);
      console.log("[beeim] ==================================");

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${responseText}`);
      }

      let result;
      try {
        result = JSON.parse(responseText);
      } catch {
        result = responseText;
      }

      // 检查 token 验证失败（code: 1440000）
      if (result && result.code === 1440000) {
        console.warn(`[beeim] Token 验证失败 (code: 1440000)${chunkInfo}:`, result.message);

        // 如果已经是重试，不再重试
        if (isRetry) {
          throw new Error(`Token 验证失败（已重试）: ${result.message}`);
        }

        // 清除 token 并重试整个发送，复用 clientMsgId 以便服务端去重
        console.log("[beeim] 清除 token 并重试...");
        clearAccessToken(accid);
        await sendBeeMessage(
          chatId,
          text,
          appKey,
          accid,
          token,
          isGroup,
          apiBase,
          true,
          chunkMsgIds,
        );
        return; // 成功重试后返回
      }

      console.log(`[beeim] HTTP 消息发送成功${chunkInfo}:`, result);
    } catch (error: any) {
      console.error(`[beeim] 发送 HTTP 消息失败${chunkInfo}:`, error.message);
      throw error;
    }

    // 分块之间添加延迟，避免速率限制
    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (chunks.length > 1) {
    console.log(`[beeim] 全部 ${chunks.length} 块发送成功`);
  }
}
