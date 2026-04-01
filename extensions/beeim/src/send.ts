/**
 * BeeIM Send - 消息发送模块
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveBeeimAccountById, resolveAllBeeimAccounts } from "./accounts.js";
import { createBeeimClient, getCachedBeeimClient } from "./client.js";
import { sendBeeMessage } from "./http-api.js";
import { normalizeBeeimTarget } from "./targets.js";
import type { BeeimInstanceConfig, BeeimSendResult, BeeimSessionType } from "./types.js";

/**
 * Resolve the BeeIM instance config for a given accountId, or fall back to
 * the first configured instance if no accountId is provided.
 */
export function resolveInstCfg(
  cfg: OpenClawConfig,
  accountId?: string,
): BeeimInstanceConfig | null {
  if (accountId) {
    const acct = resolveBeeimAccountById({ cfg, accountId });
    return acct.configured ? acct.config : null;
  }
  const all = resolveAllBeeimAccounts({ cfg });
  return all.find((a) => a.configured)?.config ?? null;
}

/** 单条消息最大字符数 */
const MAX_MESSAGE_LENGTH = 5000;

/**
 * 发送文本消息
 */
export async function sendMessageBeeim(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  sessionType?: BeeimSessionType;
  accountId?: string;
}): Promise<BeeimSendResult> {
  const { cfg, to, text, sessionType = "p2p", accountId } = params;
  const nimCfg = resolveInstCfg(cfg, accountId);

  if (!nimCfg) {
    return { success: false, error: "BeeIM channel not configured" };
  }

  const targetId = normalizeBeeimTarget(to);

  console.log(
    `[beeim] sendMessageBeeim — accountId: "${accountId ?? "none"}", target: ${targetId}, session: ${sessionType}, account in config: ${nimCfg.account}`,
  );

  try {
    let client = getCachedBeeimClient(nimCfg);
    if (!client || !client.loggedIn) {
      client = await createBeeimClient(nimCfg);
      await client.login();
    }

    console.log(`[beeim] sendMessageBeeim using client — account: ${client.account}`);

    return await client.sendText(targetId!, text, sessionType);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 回复群组消息（引用原消息 + 强制推送给 @ 的人）
 */
export async function replyMessageBeeim(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  originalMsg: unknown;
  forcePushAccountIds: string[];
  sessionType?: BeeimSessionType;
  accountId?: string;
}): Promise<BeeimSendResult> {
  const {
    cfg,
    to,
    text,
    originalMsg,
    forcePushAccountIds,
    sessionType = "team",
    accountId,
  } = params;
  const nimCfg = resolveInstCfg(cfg, accountId);

  if (!nimCfg) {
    console.log("[beeim] reply skipped — channel not configured");
    return { success: false, error: "BeeIM channel not configured" };
  }

  const targetId = normalizeBeeimTarget(to);
  console.log(
    `[beeim] replyMessageBeeim — accountId: "${accountId ?? "none"}", target: ${targetId}, session: ${sessionType}, force-push: [${forcePushAccountIds.join(", ")}], account in config: ${nimCfg.account}`,
  );

  try {
    let client = getCachedBeeimClient(nimCfg);
    if (!client || !client.loggedIn) {
      client = await createBeeimClient(nimCfg);
      await client.login();
    }

    const result = await client.replyText(
      targetId!,
      text,
      originalMsg,
      forcePushAccountIds,
      sessionType,
    );
    return result;
  } catch (error) {
    const errorMessage = (error as any)?.message ?? String(error);
    console.error(`[beeim] reply exception — error: ${errorMessage}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 编辑消息（BeeIM 不支持真正的编辑，通过重发模拟）
 */
export async function editMessageBeeim(params: {
  cfg: OpenClawConfig;
  msgId: string;
  to: string;
  newText: string;
  sessionType?: BeeimSessionType;
}): Promise<BeeimSendResult> {
  const { cfg, to, newText, sessionType = "p2p" } = params;
  return sendMessageBeeim({ cfg, to, text: newText, sessionType });
}

/**
 * 将长文本分割成多条消息
 */
export function splitMessageIntoChunks(
  text: string,
  maxLength: number = MAX_MESSAGE_LENGTH,
): string[] {
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

    // 如果没有换行符，尝试在空格处分割
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }

    // 如果还是找不到合适的分割点，强制在 maxLength 处分割
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

/**
 * 发送流式消息（P2P）
 */
export async function sendStreamMessageBeeim(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  sessionType?: BeeimSessionType;
  chunkIndex: number;
  isComplete: boolean;
  baseMessage?: any;
  accountId?: string;
}): Promise<BeeimSendResult> {
  const {
    cfg,
    to,
    text,
    sessionType = "p2p",
    chunkIndex,
    isComplete,
    baseMessage,
    accountId,
  } = params;
  const nimCfg = resolveInstCfg(cfg, accountId);

  if (!nimCfg) {
    return { success: false, error: "BeeIM channel not configured" };
  }

  const targetId = normalizeBeeimTarget(to);

  try {
    let client = getCachedBeeimClient(nimCfg);
    if (!client || !client.loggedIn) {
      client = await createBeeimClient(nimCfg);
      await client.login();
    }

    const sendParams = {
      to: targetId!,
      sessionType,
      baseMessage,
      streamChunkParams: {
        text,
        index: chunkIndex,
        finish: isComplete ? 1 : 0,
      },
    };

    return await client.sendStreamMessage(sendParams);
  } catch (error) {
    console.error(`[beeim] stream message failed — error: ${error}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send a text message via the BeeIM HTTP API.
 * Used for custom-message (type=100) reply flows where the NIM SDK send path
 * is not available and the HTTP API must be used instead.
 *
 * nimToken 格式: appKey-accid-token
 * 例如: daaae4918fcb957b65cc1f1dde0b2faa-515686154947791701-529e6255784bba712a7a007a58ec63a9
 *
 * 参数说明（重要！）：
 * - appKey: nimToken 的第一部分（用于 HTTP API 发送）
 * - accid: nimToken 的第二部分（用于 token 认证）
 * - token: nimToken 的第三部分（用于 token 认证）
 */
export async function sendMessageViaHttpApi(params: {
  cfg: OpenClawConfig;
  chatId: string;
  text: string;
  accountId?: string;
}): Promise<BeeimSendResult> {
  const { cfg, chatId, text, accountId } = params;
  const nimCfg = resolveInstCfg(cfg, accountId);

  if (!nimCfg) {
    return { success: false, error: "BeeIM channel not configured" };
  }

  const { resolveBeeimCredentials } = await import("./accounts.js");
  const creds = resolveBeeimCredentials(nimCfg);

  if (!creds) {
    console.error("[beeim] sendMessageViaHttpApi — credentials not resolved");
    return { success: false, error: "BeeIM credentials not configured" };
  }

  // 从凭证解析参数
  // creds.appKey = nimToken 的第一部分
  // creds.account = nimToken 的第二部分（accid）
  // creds.token = nimToken 的第三部分
  const { appKey, account: accid, token } = creds;

  console.log(
    `[beeim] sendMessageViaHttpApi — chatId: ${chatId}, length: ${text.length}, accountId: "${accountId ?? "none"}", appKey: ${appKey}, accid: ${accid}`,
  );

  try {
    // sendBeeMessage 参数：chatId, text, appKey, accid, token
    await sendBeeMessage(chatId, text, appKey, accid, token);
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[beeim] sendMessageViaHttpApi failed — error: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}
