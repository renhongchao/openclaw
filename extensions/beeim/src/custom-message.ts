/**
 * Custom Message Processor
 * Handles NIM V2 custom messages (type=100 / type="custom").
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";
import { join } from "path";

// ─── helpers ──────────────────────────────────────────────────────────────────

function safeParseJSON<T = unknown>(raw: string | undefined | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

function getBeemMediaCacheDir(): string {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return join(homeDir, ".openclaw", "cache", "channels", "beeim");
}

// ─── image download ────────────────────────────────────────────────────────────

/**
 * Download an image URL to the local BeeIM cache directory.
 * Returns the local path on success, or null on failure.
 */
export async function downloadImageToLocal(imageUrl: string): Promise<string | null> {
  if (!imageUrl) return null;
  try {
    const urlHash = createHash("md5").update(imageUrl).digest("hex").substring(0, 8);
    const filename = `beeim-image-${urlHash}-${Date.now()}.jpg`;
    const cacheDir = getBeemMediaCacheDir();
    const localPath = join(cacheDir, filename);

    await fs.mkdir(cacheDir, { recursive: true });

    const response = await fetch(imageUrl);
    if (!response.ok) {
      console.error(`[beeim] image download failed — status: ${response.status}, url: ${imageUrl}`);
      return null;
    }

    await fs.writeFile(localPath, Buffer.from(await response.arrayBuffer()));
    console.log(`[beeim] image downloaded — path: ${localPath}`);
    return localPath;
  } catch (error) {
    console.error(`[beeim] image download error — url: ${imageUrl}, error: ${error}`);
    return null;
  }
}

// ─── types ─────────────────────────────────────────────────────────────────────

export interface BeeCustomMessageContent {
  text?: string;
  url?: string;
  subType?: number;
  [key: string]: unknown;
}

/**
 * Parsed envelope from rawMsg.attachment.raw.
 *
 * Raw string shape (from the real SDK log):
 *   { senderId, chatId, chatType, clientMsgId, msgType, msgId, sendTime, content: "{\"text\":\"...\"}" }
 */
interface RawAttachmentEnvelope {
  senderId?: string;
  chatId?: string;
  chatType?: number;
  clientMsgId?: string;
  msgType?: number;
  msgId?: number;
  sendTime?: number;
  content?: string;
}

export interface ParsedCustomMessage {
  /** Business-layer sender ID (from raw envelope senderId). */
  senderId: string;
  /** Reply target (from raw envelope chatId). */
  chatId: string;
  /** NIM-level raw msgType from the envelope. */
  msgType?: number;
  content: BeeCustomMessageContent;
  isText: boolean;
  isImage: boolean;
  text?: string;
  imageUrl?: string;
}

// ─── parse ─────────────────────────────────────────────────────────────────────

/**
 * Parse a NIM custom message (type=100).
 *
 * Payload chain (confirmed from SDK log):
 *   msg.rawMsg.attachment.raw  — JSON string → RawAttachmentEnvelope
 *     .senderId                — business sender ID  (used as P2P session key)
 *     .chatId                  — reply target
 *     .content                 — JSON string → { text?, url?, ... }
 *
 * Falls back to msg.text (plain string) when rawMsg is absent.
 */
export function parseCustomMessage(msg: unknown): ParsedCustomMessage | null {
  // Always dump the full raw payload so the actual SDK shape is visible in logs.
  try {
    console.log(`[beeim] custom message raw — ${JSON.stringify(msg, null, 2)}`);
  } catch {
    console.log(`[beeim] custom message raw — (not serializable) ${String(msg)}`);
  }

  const m = msg as Record<string, unknown>;

  // ── 1. Extract the raw envelope from rawMsg.attachment.raw ─────────────────
  let envelope: RawAttachmentEnvelope | null = null;

  const rawMsg = m.rawMsg as Record<string, unknown> | undefined;
  const attachmentRaw = (rawMsg?.attachment as Record<string, unknown> | undefined)?.raw;

  if (typeof attachmentRaw === "string" && attachmentRaw.trim()) {
    envelope = safeParseJSON<RawAttachmentEnvelope | null>(attachmentRaw, null);
    if (envelope) {
      console.log(
        `[beeim] custom message envelope — senderId: ${envelope.senderId}, chatId: ${envelope.chatId}, msgType: ${envelope.msgType}`,
      );
    }
  }

  // ── 2. Determine business senderId and chatId ──────────────────────────────
  // Prefer envelope values; fall back to NIM-level from/to.
  const senderId = envelope?.senderId ?? String(m.from ?? "");
  const chatId = envelope?.chatId ?? String(m.to ?? "");

  // ── 3. Parse inner content ─────────────────────────────────────────────────
  // envelope.content is itself a JSON string: e.g. '{"text":"哈哈"}'
  let content: BeeCustomMessageContent = {};

  if (envelope?.content) {
    content = safeParseJSON<BeeCustomMessageContent>(envelope.content, {});
  } else if (typeof m.text === "string" && m.text.trim()) {
    // Plain text fallback (no rawMsg envelope present).
    content = safeParseJSON<BeeCustomMessageContent>(m.text, { text: m.text });
  }

  // ── 4. Classify ───────────────────────────────────────────────────────────
  const hasText = typeof content.text === "string" && content.text.length > 0;
  const hasUrl = typeof content.url === "string" && content.url.length > 0;
  const isImage = hasUrl || content.subType === 2;
  const isText = !isImage && (hasText || content.subType === 1);
  const text = isImage ? content.url : content.text;

  console.log(
    `[beeim] custom message parsed — senderId: ${senderId}, chatId: ${chatId}, isText: ${isText}, isImage: ${isImage}, text: ${text ? String(text).substring(0, 80) : "(empty)"}`,
  );

  return {
    senderId,
    chatId,
    msgType: envelope?.msgType,
    content,
    isText,
    isImage,
    text,
    imageUrl: isImage ? content.url : undefined,
  };
}

// ─── helpers ───────────────────────────────────────────────────────────────────

/** Returns true for NIM custom message type (100 or "custom"). */
export function isCustomMessage(msgType: string | number): boolean {
  return msgType === "custom" || msgType === 100;
}

/**
 * Extract the display text from a parsed custom message.
 * Images are represented as "[image] <url>".
 */
export function extractCustomMessageText(parsed: ParsedCustomMessage): string {
  if (parsed.isImage && parsed.imageUrl) {
    return `[image] ${parsed.imageUrl}`;
  }
  if (parsed.text) {
    return parsed.text;
  }
  console.log("[beeim] extractCustomMessageText — no text or image found");
  return "";
}
