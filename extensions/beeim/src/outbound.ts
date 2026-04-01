import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  sendImageBeeim,
  sendFileBeeim,
  sendAudioBeeim,
  sendVideoBeeim,
  inferMessageType,
} from "./media.js";
import { sendMessageBeeim, splitMessageIntoChunks, resolveInstCfg } from "./send.js";
import { normalizeBeeimTarget, parseBeeimTarget } from "./targets.js";
import type { BeeimInstanceConfig } from "./types.js";

/** Default text chunk limit for BeeIM messages */
const DEFAULT_TEXT_CHUNK_LIMIT = 5000;

/**
 * Outbound send result type
 */
export type BeeimOutboundResult = {
  channel: "beeim";
  ok: boolean;
  messageId: string;
  msgId?: string;
  clientMsgId?: string;
  error?: string;
};

/**
 * Outbound message options (legacy, for backward compatibility)
 */
export type BeeimOutboundOptions = {
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
 * Resolve BeeIM target from various input formats.
 */
export function resolveBeeimOutboundTarget(params: {
  to?: string;
  allowFrom?: string[];
  mode?: "explicit" | "implicit" | "heartbeat";
}): TargetResolveResult {
  const { to, allowFrom, mode } = params;
  const trimmed = to?.trim() ?? "";

  // Normalize allowFrom list
  const allowListRaw = (allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
  const hasWildcard = allowListRaw.includes("*");
  const allowList = allowListRaw
    .filter((entry) => entry !== "*")
    .map((entry) => normalizeBeeimTarget(entry))
    .filter((entry): entry is string => Boolean(entry));

  // If explicit target provided
  if (trimmed) {
    // Preserve team:/superTeam: prefixes for downstream session type detection
    const lc = trimmed.toLowerCase();
    if (lc.startsWith("team:") || lc.startsWith("superteam:")) {
      const parsed = parseBeeimTarget(trimmed);
      if (parsed) {
        return { ok: true, to: trimmed };
      }
    }

    const normalizedTo = normalizeBeeimTarget(trimmed);
    if (!normalizedTo) {
      if ((mode === "implicit" || mode === "heartbeat") && allowList.length > 0) {
        return { ok: true, to: allowList[0] };
      }
      return {
        ok: false,
        error: new Error(
          `Invalid BeeIM target: ${trimmed}. Provide a valid BeeIM account ID or configure channels.beeim.allowFrom.`,
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
      `Missing BeeIM target. Provide a target ID or configure channels.beeim.allowFrom.`,
    ),
  };
}

/**
 * Send text message through BeeIM channel.
 */
export async function sendBeeimOutboundText(params: {
  to: string;
  text: string;
  cfg: OpenClawConfig;
  accountId?: string;
}): Promise<BeeimOutboundResult> {
  const { to, text, cfg } = params;
  const parsed = parseBeeimTarget(to);
  const targetId = parsed?.id ?? normalizeBeeimTarget(to) ?? to;
  const sessionType = parsed?.sessionType ?? "p2p";

  console.log(
    `[beeim] outbound text send — target: ${targetId}, session: ${sessionType}, length: ${text.length}`,
  );

  try {
    const result = await sendMessageBeeim({
      cfg,
      to: targetId,
      text,
      sessionType,
    });

    if (result.success) {
      return {
        channel: "beeim",
        ok: true,
        messageId: result.msgId ?? "",
        msgId: result.msgId,
        clientMsgId: result.clientMsgId,
      };
    } else {
      return {
        channel: "beeim",
        ok: false,
        messageId: "",
        error: result.error,
      };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      channel: "beeim",
      ok: false,
      messageId: "",
      error: errorMsg,
    };
  }
}

/**
 * Send media message through BeeIM channel.
 */
export async function sendBeeimOutboundMedia(params: {
  to: string;
  text?: string;
  mediaUrl?: string;
  mediaPath?: string;
  cfg: OpenClawConfig;
  accountId?: string;
}): Promise<BeeimOutboundResult> {
  const { to, text, mediaUrl, mediaPath, cfg, accountId } = params;
  const media = mediaPath || mediaUrl;
  const parsed = parseBeeimTarget(to);
  const targetId = parsed?.id ?? normalizeBeeimTarget(to) ?? to;
  const sessionType = parsed?.sessionType ?? "p2p";

  try {
    if (media) {
      const mediaType = inferMessageType(media);
      let mediaResult;

      if (mediaType === "image") {
        mediaResult = await sendImageBeeim({
          cfg,
          to: targetId,
          imagePath: media,
          sessionType,
          accountId,
        });
      } else if (mediaType === "audio") {
        mediaResult = await sendAudioBeeim({
          cfg,
          to: targetId,
          audioPath: media,
          duration: 0,
          sessionType,
          accountId,
        });
      } else if (mediaType === "video") {
        mediaResult = await sendVideoBeeim({
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
        mediaResult = await sendFileBeeim({
          cfg,
          to: targetId,
          filePath: media,
          sessionType,
          accountId,
        });
      }

      if (!mediaResult.success) {
        return {
          channel: "beeim",
          ok: false,
          messageId: "",
          error: mediaResult.error,
        };
      }

      if (!text) {
        return {
          channel: "beeim",
          ok: true,
          messageId: mediaResult.msgId ?? "",
          msgId: mediaResult.msgId,
          clientMsgId: mediaResult.clientMsgId,
        };
      }
    }

    if (text) {
      return await sendBeeimOutboundText({ to, text, cfg });
    }

    return {
      channel: "beeim",
      ok: true,
      messageId: "",
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      channel: "beeim",
      ok: false,
      messageId: "",
      error: errorMsg,
    };
  }
}

/**
 * BeeIM outbound configuration object.
 */
export const beeimOutboundConfig = {
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
  textChunkLimit: DEFAULT_TEXT_CHUNK_LIMIT,

  /**
   * Resolve target address from various input formats
   */
  resolveTarget: resolveBeeimOutboundTarget,

  /**
   * Send a text message
   */
  sendText: async (params: {
    to: string;
    text: string;
    cfg: OpenClawConfig;
    accountId?: string | null;
    deps?: unknown;
  }): Promise<BeeimOutboundResult> => {
    return sendBeeimOutboundText({ ...params, accountId: params.accountId ?? undefined });
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
  }): Promise<BeeimOutboundResult> => {
    return sendBeeimOutboundMedia({
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
 * Handle outbound messages for the BeeIM channel.
 * @deprecated Use beeimOutboundConfig.sendText/sendMedia instead
 */
export async function beeimOutbound(params: BeeimOutboundOptions): Promise<void> {
  const { cfg, to, text, mediaPath } = params;
  const nimCfg = resolveInstCfg(cfg);

  const targetId = normalizeBeeimTarget(to);
  if (!targetId) {
    throw new Error(`Invalid BeeIM target: ${to}`);
  }

  if (mediaPath) {
    const result = await sendBeeimOutboundMedia({
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
    const chunkLimit = nimCfg?.advanced?.textChunkLimit ?? DEFAULT_TEXT_CHUNK_LIMIT;
    const chunks = splitMessageIntoChunks(text, chunkLimit);

    for (const chunk of chunks) {
      const result = await sendBeeimOutboundText({
        cfg,
        to: targetId,
        text: chunk,
      });
      if (!result.ok) {
        throw new Error(result.error || "Failed to send text");
      }
    }
  }
}
