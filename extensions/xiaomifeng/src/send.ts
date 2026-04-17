/**
 * XiaoMiFeng Send - message sending module.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveXiaomifengAccountById, resolveAllXiaomifengAccounts } from "./accounts.js";
import { createXiaomifengClient, getCachedXiaomifengClient } from "./client.js";
import { XIAOMIFENG_API_CONFIG } from "./http-api.js";
import { sendXiaomifengMessage } from "./http-api.js";
import { normalizeXiaomifengTarget } from "./targets.js";
import type {
  XiaomifengInstanceConfig,
  XiaomifengSendResult,
  XiaomifengSessionType,
} from "./types.js";

function getErrorMessage(error: unknown): string {
  const err = error as { message?: unknown; desc?: unknown };
  return (
    (typeof err.message === "string" ? err.message : undefined) ??
    (typeof err.desc === "string" ? err.desc : undefined) ??
    String(error)
  );
}

/**
 * Resolve the XiaoMiFeng instance config for a given accountId, or fall back to
 * the first configured instance if no accountId is provided.
 */
export function resolveInstCfg(
  cfg: OpenClawConfig,
  accountId?: string,
): XiaomifengInstanceConfig | null {
  if (accountId && accountId !== "default") {
    const acct = resolveXiaomifengAccountById({ cfg, accountId });
    if (acct.configured) {
      return acct.config;
    }
    // accountId provided but not found — fall through to default lookup
  }
  const all = resolveAllXiaomifengAccounts({ cfg });
  return all.find((a) => a.configured)?.config ?? null;
}

/** Max characters per message. */
const MAX_MESSAGE_LENGTH = 5000;

/**
 * Send a text message.
 */
export async function sendMessageXiaomifeng(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  sessionType?: XiaomifengSessionType;
  accountId?: string;
}): Promise<XiaomifengSendResult> {
  const { cfg, to, text, sessionType = "p2p", accountId } = params;
  const instCfg = resolveInstCfg(cfg, accountId);

  if (!instCfg) {
    return { success: false, error: "XiaoMiFeng channel not configured" };
  }

  const targetId = normalizeXiaomifengTarget(to);

  try {
    let client = getCachedXiaomifengClient(instCfg);
    if (!client || !client.loggedIn) {
      client = await createXiaomifengClient(instCfg);
      await client.login();
    }

    return await client.sendText(targetId!, text, sessionType);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Reply to a group message (quote + force-push to @ mentions).
 */
export async function replyMessageXiaomifeng(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  originalMsg: unknown;
  forcePushAccountIds: string[];
  sessionType?: XiaomifengSessionType;
  accountId?: string;
}): Promise<XiaomifengSendResult> {
  const {
    cfg,
    to,
    text,
    originalMsg,
    forcePushAccountIds,
    sessionType = "team",
    accountId,
  } = params;
  const instCfg = resolveInstCfg(cfg, accountId);

  if (!instCfg) {
    return { success: false, error: "XiaoMiFeng channel not configured" };
  }

  const targetId = normalizeXiaomifengTarget(to);

  try {
    let client = getCachedXiaomifengClient(instCfg);
    if (!client || !client.loggedIn) {
      client = await createXiaomifengClient(instCfg);
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
    const errorMessage = getErrorMessage(error);
    console.error(`[xiaomifeng] reply exception — error: ${errorMessage}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Edit a message (XiaoMiFeng does not support true edits; resend instead).
 */
export async function editMessageXiaomifeng(params: {
  cfg: OpenClawConfig;
  msgId: string;
  to: string;
  newText: string;
  sessionType?: XiaomifengSessionType;
}): Promise<XiaomifengSendResult> {
  const { cfg, to, newText, sessionType = "p2p" } = params;
  return sendMessageXiaomifeng({ cfg, to, text: newText, sessionType });
}

/**
 * Split long text into multiple messages.
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

    // Prefer splitting on newline.
    let splitIndex = remaining.lastIndexOf("\n", maxLength);

    // If no newline, try splitting on space.
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }

    // If still not a good split, hard-split at maxLength.
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

/**
 * Send a streaming message (P2P).
 */
export async function sendStreamMessageXiaomifeng(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  sessionType?: XiaomifengSessionType;
  chunkIndex: number;
  isComplete: boolean;
  baseMessage?: unknown;
  accountId?: string;
}): Promise<XiaomifengSendResult> {
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
  const instCfg = resolveInstCfg(cfg, accountId);

  if (!instCfg) {
    return { success: false, error: "XiaoMiFeng channel not configured" };
  }

  const targetId = normalizeXiaomifengTarget(to);

  try {
    let client = getCachedXiaomifengClient(instCfg);
    if (!client || !client.loggedIn) {
      client = await createXiaomifengClient(instCfg);
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
    console.error(`[xiaomifeng] stream message failed — error: ${String(error)}`);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send a text message via the XiaoMiFeng HTTP API.
 * Used for custom-message (type=100) reply flows where the NIM SDK send path
 * is not available and the HTTP API must be used instead.
 *
 * Internally derived from clientId + clientSecret via the fixed app key.
 *
 * Parameter mapping:
 * - appKey: fixed app key (HTTP API send)
 * - accid: clientId (token auth)
 * - token: clientSecret (token auth)
 */
export async function sendMessageViaHttpApi(params: {
  cfg: OpenClawConfig;
  chatId: string;
  text: string;
  accountId?: string;
  isGroup?: boolean;
}): Promise<XiaomifengSendResult> {
  const { cfg, chatId, text, accountId, isGroup = false } = params;
  const instCfg = resolveInstCfg(cfg, accountId);

  if (!instCfg) {
    console.error(
      `[xiaomifeng] sendMessageViaHttpApi — XiaoMiFeng channel not configured, accountId: "${accountId ?? "none"}"`,
    );
    return { success: false, error: "XiaoMiFeng channel not configured" };
  }

  const { resolveXiaomifengCredentials } = await import("./accounts.js");
  const creds = resolveXiaomifengCredentials(instCfg);

  if (!creds) {
    console.error("[xiaomifeng] sendMessageViaHttpApi — credentials not resolved");
    return { success: false, error: "XiaoMiFeng credentials not configured" };
  }

  // Resolve auth params from credentials.
  // creds.appKey = fixed app key
  // creds.account = clientId (token auth)
  // creds.token = clientSecret (token auth)
  const { appKey, account: accid, token } = creds;
  const apiBase = instCfg.advanced?.apiBase ?? XIAOMIFENG_API_CONFIG.DEFAULT_API_BASE;

  try {
    // sendXiaomifengMessage params: chatId, text, appKey, accid, token, isGroup, apiBase
    await sendXiaomifengMessage(chatId, text, appKey, accid, token, isGroup, apiBase);
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[xiaomifeng] sendMessageViaHttpApi failed — error: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}
