/**
 * XiaoMiFeng HTTP API - send messages via XiaoMiFeng HTTP API.
 *
 * Based on the xiaomifengGateway.ts implementation.
 * Access token acquisition and message send helpers.
 */

import { randomUUID } from "node:crypto";

/**
 * HTTP API URLs and configuration.
 */
export const XIAOMIFENG_API_CONFIG = {
  DEFAULT_API_BASE: "https://api.mifengs.com",
  FIXED_HTTP_FROM: "youdaoClaw",
  APP_NAME: "youdaoClaw", // Fixed app name for API auth.
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
 * Access token cache.
 */
interface TokenCache {
  accessToken: string;
  expiry: number;
}

/** Per-accid token cache — multi-instance safe. */
const tokenCacheMap = new Map<string, TokenCache>();

function getErrorMessage(error: unknown): string {
  const err = error as { message?: unknown; desc?: unknown };
  return (
    (typeof err.message === "string" ? err.message : undefined) ??
    (typeof err.desc === "string" ? err.desc : undefined) ??
    String(error)
  );
}

/**
 * Fetch an access token.
 *
 * Parameter mapping (two separate concepts):
 *
 * Internally derived from clientId + clientSecret via fixed app key.
 *
 * Token auth requires:
 *   AppKey = clientId (for token auth)
 *   AppSecret = clientSecret (for token auth)
 *   AppName = 'youdaoClaw' (fixed app name for API auth)
 *
 * @param accid clientId (used for token auth)
 * @param token clientSecret (used for token auth)
 * @returns accessToken
 */
export async function getAccessToken(
  accid: string,
  token: string,
  apiBase: string = XIAOMIFENG_API_CONFIG.DEFAULT_API_BASE,
): Promise<string> {
  if (!accid || !token) {
    throw new Error("[xiaomifeng] accessToken requires clientId and clientSecret");
  }

  const now = Date.now();

  // Per-accid cache — reuse if more than 60 s remaining.
  const cached = tokenCacheMap.get(accid);
  if (cached && cached.expiry > now + 60_000) {
    return cached.accessToken;
  }

  const { tokenUrl } = buildApiUrls(apiBase);

  // Token auth uses AppKey (clientId), AppSecret (clientSecret), AppName.
  const tokenPayload = {
    AppKey: accid,
    AppSecret: token,
    AppName: XIAOMIFENG_API_CONFIG.APP_NAME,
  };

  const requestBody = JSON.stringify(tokenPayload);

  try {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error(
        `[xiaomifeng] token API failed — status: ${response.status}, response: ${responseText}`,
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
      console.error(`[xiaomifeng] token API missing accessToken — response: ${responseText}`);
      throw new Error(`Failed to get accessToken: ${JSON.stringify(result)}`);
    }

    tokenCacheMap.set(accid, { accessToken, expiry: now + expiresIn * 1000 });
    return accessToken;
  } catch (error) {
    console.error(`[xiaomifeng] accessToken fetch failed — error: ${getErrorMessage(error)}`);
    throw error;
  }
}

/**
 * Clear cached access tokens.
 */
export function clearAccessToken(accid?: string): void {
  if (accid) {
    tokenCacheMap.delete(accid);
  } else {
    tokenCacheMap.clear();
  }
}

/**
 * Split long text into chunks.
 * @param text text content
 * @param maxLength max length (default 1500)
 * @returns array of chunks
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

    // Prefer splitting on newline.
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      // Fall back to splitting on space.
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      // Force a hard split at maxLength.
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

/**
 * Send a message via the HTTP API.
 *
 * Parameter mapping:
 * - appKey: fixed app key (internal; derived from clientId + clientSecret)
 * - accid: clientId (token auth)
 * - token: clientSecret (token auth)
 *
 * @param chatId chat ID (recipient ID)
 * @param text message text
 * @param appKey fixed app key
 * @param accid clientId
 * @param token clientSecret
 * @param isRetry whether this is a retry (internal)
 * @param _chunkMsgIds reuse chunk clientMsgId for retries (internal)
 */
export async function sendXiaomifengMessage(
  chatId: string,
  text: string,
  appKey: string,
  accid: string,
  token: string,
  isGroup: boolean = false,
  apiBase: string = XIAOMIFENG_API_CONFIG.DEFAULT_API_BASE,
  isRetry: boolean = false,
  _chunkMsgIds?: string[],
): Promise<void> {
  if (!appKey || !accid || !token) {
    throw new Error("[xiaomifeng] HTTP API credentials require appKey, clientId, and clientSecret");
  }

  // Split long messages.
  const chunks = splitMessageIntoChunks(text);

  // Generate a clientMsgId per chunk; reuse on retries for server de-dupe.
  const chunkMsgIds: string[] =
    _chunkMsgIds && _chunkMsgIds.length === chunks.length
      ? _chunkMsgIds
      : chunks.map(() => randomUUID());

  // Fetch accessToken once for all chunks.
  const accessToken = await getAccessToken(accid, token, apiBase);

  const { sendUrl } = buildApiUrls(apiBase);

  // Send chunks in order.
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const clientMsgId = chunkMsgIds[i];

    // send API payload — appKey uses accid to match token auth.
    // group: chatType "group" + to; direct: chatType "single" + chatId.
    const payload = {
      clientMsgId,
      from: XIAOMIFENG_API_CONFIG.FIXED_HTTP_FROM,
      appKey: accid,
      accessToken: accessToken,
      chatType: isGroup ? "group" : "single",
      msgType: "text",
      ...(isGroup ? { to: chatId } : { chatId: chatId }),
      content: JSON.stringify({ text: chunk }),
    };

    try {
      const response = await fetch(sendUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${responseText}`);
      }

      let result;
      try {
        result = JSON.parse(responseText);
      } catch {
        result = responseText;
      }

      // Check token auth failure (code: 1440000).
      if (result && result.code === 1440000) {
        const chunkInfo = chunks.length > 1 ? ` (chunk ${i + 1}/${chunks.length})` : "";
        console.warn(
          `[xiaomifeng] token validation failed (code: 1440000)${chunkInfo}: ${result.message}`,
        );

        // If already retrying, do not retry again.
        if (isRetry) {
          throw new Error(`Token validation failed (already retried): ${result.message}`);
        }

        // Clear token and retry using the same clientMsgId set.
        clearAccessToken(accid);
        await sendXiaomifengMessage(
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
        return; // Return after successful retry.
      }
    } catch (error) {
      const chunkInfo = chunks.length > 1 ? ` (chunk ${i + 1}/${chunks.length})` : "";
      console.error(`[xiaomifeng] HTTP message send failed${chunkInfo}: ${getErrorMessage(error)}`);
      throw error;
    }

    // Delay between chunks to avoid rate limits.
    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
