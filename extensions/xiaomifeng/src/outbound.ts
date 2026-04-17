import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  sendImageXiaomifeng,
  sendFileXiaomifeng,
  sendAudioXiaomifeng,
  sendVideoXiaomifeng,
  inferMessageType,
} from "./media.js";
import { splitMessageIntoChunks, sendMessageViaHttpApi } from "./send.js";
import { normalizeXiaomifengTarget, parseXiaomifengTarget } from "./targets.js";

/**
 * Text chunk limit exposed to core outbound.  Set high so that core does NOT
 * split messages — sendXiaomifengMessage (http-api.ts) handles its own 1500-char
 * chunking internally.
 */
const CORE_OUTBOUND_CHUNK_LIMIT = 100_000;

/**
 * Outbound send result type
 */
export type XiaomifengOutboundResult = {
  channel: "xiaomifeng";
  ok: boolean;
  messageId: string;
  msgId?: string;
  clientMsgId?: string;
  error?: string;
};

/**
 * Outbound message options (legacy, for backward compatibility)
 */
export type XiaomifengOutboundOptions = {
  cfg: OpenClawConfig;
  to: string;
  text?: string;
  mediaPath?: string;
};

/**
 * Target resolution result
 */
type TargetResolveResult = { ok: true; to: string } | { ok: false; error: Error };

/**
 * Resolve XiaoMiFeng target from various input formats.
 */
export function resolveXiaomifengOutboundTarget(params: {
  to?: string;
  allowFrom?: string[];
  mode?: "explicit" | "implicit" | "heartbeat";
}): TargetResolveResult {
  const { to, allowFrom, mode } = params;
  const trimmed = to?.trim() ?? "";

  // Normalize allowFrom list
  const allowListRaw = (allowFrom ?? []).map((entry) => entry.trim()).filter(Boolean);
  const hasWildcard = allowListRaw.includes("*");
  const allowList = allowListRaw
    .filter((entry) => entry !== "*")
    .map((entry) => normalizeXiaomifengTarget(entry))
    .filter((entry): entry is string => Boolean(entry));

  // If explicit target provided
  if (trimmed) {
    // Preserve team:/superTeam: prefixes for downstream session type detection
    const lc = trimmed.toLowerCase();
    if (lc.startsWith("team:") || lc.startsWith("superteam:")) {
      const parsed = parseXiaomifengTarget(trimmed);
      if (parsed) {
        return { ok: true, to: trimmed };
      }
    }

    const normalizedTo = normalizeXiaomifengTarget(trimmed);
    if (!normalizedTo) {
      if ((mode === "implicit" || mode === "heartbeat") && allowList.length > 0) {
        return { ok: true, to: allowList[0] };
      }
      return {
        ok: false,
        error: new Error(
          `Invalid XiaoMiFeng target: ${trimmed}. Provide a valid XiaoMiFeng account ID or configure channels.xiaomifeng.allowFrom.`,
        ),
      };
    }

    if (mode === "implicit" || mode === "heartbeat") {
      if (hasWildcard || allowList.length === 0) {
        return { ok: true, to: normalizedTo };
      }
      if (allowList.includes(normalizedTo)) {
        return { ok: true, to: normalizedTo };
      }
      return { ok: true, to: allowList[0] };
    }

    return { ok: true, to: normalizedTo };
  }

  // No explicit target - use allowFrom
  if (allowList.length > 0) {
    return { ok: true, to: allowList[0] };
  }

  return {
    ok: false,
    error: new Error(
      `Missing XiaoMiFeng target. Provide a target ID or configure channels.xiaomifeng.allowFrom.`,
    ),
  };
}

/**
 * Send text message through XiaoMiFeng channel.
 * All messages are routed via the XiaoMiFeng HTTP API (not the NIM SDK).
 */
export async function sendXiaomifengOutboundText(params: {
  to: string;
  text: string;
  cfg: OpenClawConfig;
  accountId?: string;
}): Promise<XiaomifengOutboundResult> {
  const { to, text, cfg } = params;
  const parsed = parseXiaomifengTarget(to);
  const targetId = parsed?.id ?? normalizeXiaomifengTarget(to) ?? to;
  const isGroup = parsed?.sessionType === "team" || parsed?.sessionType === "superTeam";

  try {
    const result = await sendMessageViaHttpApi({
      cfg,
      chatId: targetId,
      text,
      accountId: params.accountId,
      isGroup,
    });

    if (!result.success) {
      console.error(
        `[xiaomifeng] outbound text send failed — chatId: ${targetId}, error: ${result.error}`,
      );
    }

    return {
      channel: "xiaomifeng",
      ok: result.success,
      messageId: "",
      error: result.success ? undefined : result.error,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      channel: "xiaomifeng",
      ok: false,
      messageId: "",
      error: errorMsg,
    };
  }
}

/**
 * Send media message through XiaoMiFeng channel.
 */
export async function sendXiaomifengOutboundMedia(params: {
  to: string;
  text?: string;
  mediaUrl?: string;
  mediaPath?: string;
  cfg: OpenClawConfig;
  accountId?: string;
}): Promise<XiaomifengOutboundResult> {
  const { to, text, mediaUrl, mediaPath, cfg, accountId } = params;
  const media = mediaPath || mediaUrl;
  const parsed = parseXiaomifengTarget(to);
  const targetId = parsed?.id ?? normalizeXiaomifengTarget(to) ?? to;
  const sessionType = parsed?.sessionType ?? "p2p";

  try {
    if (media) {
      const mediaType = inferMessageType(media);
      let mediaResult;

      if (mediaType === "image") {
        mediaResult = await sendImageXiaomifeng({
          cfg,
          to: targetId,
          imagePath: media,
          sessionType,
          accountId,
        });
      } else if (mediaType === "audio") {
        mediaResult = await sendAudioXiaomifeng({
          cfg,
          to: targetId,
          audioPath: media,
          duration: 0,
          sessionType,
          accountId,
        });
      } else if (mediaType === "video") {
        mediaResult = await sendVideoXiaomifeng({
          cfg,
          to: targetId,
          videoPath: media,
          duration: 0,
          width: 1920,
          height: 1080,
          sessionType,
          accountId,
        });
      } else {
        mediaResult = await sendFileXiaomifeng({
          cfg,
          to: targetId,
          filePath: media,
          sessionType,
          accountId,
        });
      }

      if (!mediaResult.success) {
        return {
          channel: "xiaomifeng",
          ok: false,
          messageId: "",
          error: mediaResult.error,
        };
      }

      if (!text) {
        return {
          channel: "xiaomifeng",
          ok: true,
          messageId: mediaResult.msgId ?? "",
          msgId: mediaResult.msgId,
          clientMsgId: mediaResult.clientMsgId,
        };
      }
    }

    if (text) {
      return await sendXiaomifengOutboundText({ to, text, cfg });
    }

    return {
      channel: "xiaomifeng",
      ok: true,
      messageId: "",
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      channel: "xiaomifeng",
      ok: false,
      messageId: "",
      error: errorMsg,
    };
  }
}

/**
 * XiaoMiFeng outbound configuration object.
 */
export const xiaomifengOutboundConfig = {
  /**
   * Delivery mode - "gateway" means messages go through the gateway process
   */
  deliveryMode: "gateway" as const,

  /**
   * Text chunker function for splitting long messages
   */
  chunker: splitMessageIntoChunks,

  /**
   * Maximum characters per text chunk
   */
  textChunkLimit: CORE_OUTBOUND_CHUNK_LIMIT,

  /**
   * Resolve target address from various input formats
   */
  resolveTarget: resolveXiaomifengOutboundTarget,

  /**
   * Send a text message
   */
  sendText: async (params: {
    to: string;
    text: string;
    cfg: OpenClawConfig;
    accountId?: string | null;
    deps?: unknown;
  }): Promise<XiaomifengOutboundResult> => {
    return sendXiaomifengOutboundText({ ...params, accountId: params.accountId ?? undefined });
  },

  /**
   * Send a media message (with optional text caption)
   */
  sendMedia: async (params: {
    to: string;
    text?: string;
    mediaUrl?: string;
    cfg: OpenClawConfig;
    accountId?: string | null;
    deps?: unknown;
  }): Promise<XiaomifengOutboundResult> => {
    return sendXiaomifengOutboundMedia({
      ...params,
      accountId: params.accountId ?? undefined,
      mediaPath: params.mediaUrl,
    });
  },
};

// ============================================================================
// Legacy functions for backward compatibility
// ============================================================================

/**
 * Handle outbound messages for the XiaoMiFeng channel.
 * @deprecated Use xiaomifengOutboundConfig.sendText/sendMedia instead
 */
export async function xiaomifengOutbound(params: XiaomifengOutboundOptions): Promise<void> {
  const { cfg, to, text, mediaPath } = params;

  const targetId = normalizeXiaomifengTarget(to);
  if (!targetId) {
    throw new Error(`Invalid XiaoMiFeng target: ${to}`);
  }

  if (mediaPath) {
    const result = await sendXiaomifengOutboundMedia({
      cfg,
      to: targetId,
      mediaPath,
      text,
    });
    if (!result.ok) {
      throw new Error(result.error || "Failed to send media");
    }
    return;
  }

  if (text) {
    // sendXiaomifengOutboundText → sendMessageViaHttpApi → sendXiaomifengMessage handles
    // its own 1500-char chunking, so pass the full text without pre-splitting.
    const result = await sendXiaomifengOutboundText({
      cfg,
      to: targetId,
      text,
    });
    if (!result.ok) {
      throw new Error(result.error || "Failed to send text");
    }
  }
}
