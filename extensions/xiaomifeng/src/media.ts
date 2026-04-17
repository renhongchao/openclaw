/**
 * XiaoMiFeng Media - media message handling (@yxim/nim-bot version).
 */

import { extname } from "path";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { createXiaomifengClient, getCachedXiaomifengClient } from "./client.js";
import { resolveInstCfg } from "./send.js";
import { normalizeXiaomifengTarget } from "./targets.js";
import type { XiaomifengSendResult, XiaomifengMediaInfo, XiaomifengSessionType } from "./types.js";

/**
 * Send an image message.
 */
export async function sendImageXiaomifeng(params: {
  cfg: OpenClawConfig;
  to: string;
  imagePath: string;
  sessionType?: XiaomifengSessionType;
  accountId?: string;
}): Promise<XiaomifengSendResult> {
  const { cfg, to, imagePath, sessionType = "p2p", accountId } = params;
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

    return await client.sendImage(targetId!, imagePath, sessionType);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send a file message.
 */
export async function sendFileXiaomifeng(params: {
  cfg: OpenClawConfig;
  to: string;
  filePath: string;
  sessionType?: XiaomifengSessionType;
  accountId?: string;
}): Promise<XiaomifengSendResult> {
  const { cfg, to, filePath, sessionType = "p2p", accountId } = params;
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

    return await client.sendFile(targetId!, filePath, sessionType);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send an audio message.
 */
export async function sendAudioXiaomifeng(params: {
  cfg: OpenClawConfig;
  to: string;
  audioPath: string;
  duration: number;
  sessionType?: XiaomifengSessionType;
  accountId?: string;
}): Promise<XiaomifengSendResult> {
  const { cfg, to, audioPath, duration, sessionType = "p2p", accountId } = params;
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

    return await client.sendAudio(targetId!, audioPath, duration, sessionType);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send a video message.
 */
export async function sendVideoXiaomifeng(params: {
  cfg: OpenClawConfig;
  to: string;
  videoPath: string;
  duration: number;
  width: number;
  height: number;
  sessionType?: XiaomifengSessionType;
  accountId?: string;
}): Promise<XiaomifengSendResult> {
  const { cfg, to, videoPath, duration, width, height, sessionType = "p2p", accountId } = params;
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

    return await client.sendVideo(targetId!, videoPath, duration, width, height, sessionType);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Build a payload from the media info list.
 *
 * Uses the standard MediaPath/MediaUrl/MediaPaths/MediaUrls keys so the core
 * media-understanding pipeline (normalizeAttachments) picks them up correctly.
 * localPath is preferred over the remote CDN URL when available.
 */
export function buildXiaomifengMediaPayload(
  mediaList: XiaomifengMediaInfo[],
): Record<string, unknown> {
  if (!mediaList || mediaList.length === 0) {
    return {};
  }

  if (mediaList.length === 1) {
    const m = mediaList[0];
    const effectivePath = m.localPath || undefined;
    const effectiveUrl = m.url || undefined;
    return {
      ...(effectivePath ? { MediaPath: effectivePath } : {}),
      ...(effectiveUrl ? { MediaUrl: effectiveUrl } : {}),
    };
  }

  const paths = mediaList.map((m) => m.localPath ?? "");
  const urls = mediaList.map((m) => m.url ?? "");
  const hasPaths = paths.some(Boolean);
  return {
    ...(hasPaths ? { MediaPaths: paths } : {}),
    MediaUrls: urls,
  };
}

/**
 * Infer the media placeholder (for UI display).
 */
export function inferMediaPlaceholder(messageType: string): string {
  switch (messageType) {
    case "image":
      return "[图片]";
    case "audio":
      return "[语音消息]";
    case "video":
      return "[视频]";
    case "file":
      return "[文件]";
    case "geo":
    case "location":
      return "[位置]";
    default:
      return "[多媒体消息]";
  }
}

/**
 * Infer message type from file extension.
 */
export function inferMessageType(filePath: string): "image" | "file" | "audio" | "video" {
  const ext = extname(filePath).toLowerCase();

  const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
  const audioExts = [".mp3", ".wav", ".aac", ".m4a", ".ogg", ".amr"];
  const videoExts = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv"];

  if (imageExts.includes(ext)) {
    return "image";
  }
  if (audioExts.includes(ext)) {
    return "audio";
  }
  if (videoExts.includes(ext)) {
    return "video";
  }
  return "file";
}
