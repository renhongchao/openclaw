/**
 * Custom Message Processor
 * Handles NIM V2 custom messages (type=100 / type="custom").
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";
import { XIAOMIFENG_API_CONFIG, buildApiUrls, getAccessToken } from "./http-api.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function safeParseJSON<T = unknown>(raw: string | undefined | null, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function coerceUnknownToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value == null) {
    return "";
  }
  const json = JSON.stringify(value);
  return typeof json === "string" ? json : "";
}

function getXiaomifengMediaCacheDir(): string {
  return join(homedir(), ".openclaw", "cache", "channels", "xiaomifeng");
}

// ─── image download ────────────────────────────────────────────────────────────

/**
 * Download an image URL to the local XiaoMiFeng cache directory.
 * Returns the local path on success, or null on failure.
 */
export async function downloadImageToLocal(imageUrl: string): Promise<string | null> {
  if (!imageUrl) {
    return null;
  }
  try {
    const urlHash = createHash("md5").update(imageUrl).digest("hex").substring(0, 8);
    const filename = `xiaomifeng-image-${urlHash}-${Date.now()}.jpg`;
    const cacheDir = getXiaomifengMediaCacheDir();
    const localPath = join(cacheDir, filename);

    await fs.mkdir(cacheDir, { recursive: true });

    const response = await fetch(imageUrl);
    if (!response.ok) {
      console.error(
        `[xiaomifeng] image download failed — status: ${response.status}, url: ${imageUrl}`,
      );
      return null;
    }

    await fs.writeFile(localPath, Buffer.from(await response.arrayBuffer()));
    return localPath;
  } catch (error) {
    console.error(`[xiaomifeng] image download error — url: ${imageUrl}, error: ${String(error)}`);
    return null;
  }
}

// ─── file check + download (msgType=22) ───────────────────────────────────────

interface FileCheckResponse {
  code: number;
  message: string;
  data: {
    url: string;
    status: boolean;
    validDay: number;
  };
}

/**
 * Call the file check API to get a verified download URL for the given file URL.
 *
 * New endpoint: GET /worklife-go/api/v1/claw/im/file/check
 *   ?url=<fileUrl>&accessToken=<token>&clientId=<accid>&appKey=youdaoClaw
 *
 * Returns the resolved URL on success, or null on failure.
 */
async function checkFileUrl(
  fileUrl: string,
  auth: { accid: string; token: string },
  apiBase: string = XIAOMIFENG_API_CONFIG.DEFAULT_API_BASE,
): Promise<string | null> {
  const { fileCheckBaseUrl } = buildApiUrls(apiBase);
  try {
    const accessToken = await getAccessToken(auth.accid, auth.token, apiBase);
    const params = new URLSearchParams({
      url: fileUrl,
      accessToken,
      clientId: auth.accid,
      appKey: XIAOMIFENG_API_CONFIG.APP_NAME,
    });
    const apiUrl = `${fileCheckBaseUrl}?${params.toString()}`;
    const response = await fetch(apiUrl);
    if (!response.ok) {
      console.error(
        `[xiaomifeng] file check API failed — status: ${response.status}, url: ${fileUrl}, accid: ${auth.accid}, apiBase: ${apiBase}`,
      );
      return null;
    }
    const json = (await response.json()) as FileCheckResponse;
    if (json.code !== 0 || !json.data?.url) {
      console.error(
        `[xiaomifeng] file check API returned error — code: ${json.code}, message: ${json.message}`,
      );
      return null;
    }
    return json.data.url;
  } catch (err) {
    console.error(`[xiaomifeng] file check API error — url: ${fileUrl}, error: ${String(err)}`);
    return null;
  }
}

/**
 * Download a file URL (after check API resolution) to the local XiaoMiFeng cache directory.
 * Infers the filename from the content-disposition header or the URL path.
 * Returns the local path on success, or null on failure.
 */
export async function downloadFileToLocal(
  fileUrl: string,
  hint?: { name?: string; apiBase?: string; accid?: string; token?: string },
): Promise<string | null> {
  if (!fileUrl) {
    return null;
  }
  const apiBase = hint?.apiBase ?? XIAOMIFENG_API_CONFIG.DEFAULT_API_BASE;
  const accid = hint?.accid ?? "";
  const token = hint?.token ?? "";
  if (!accid || !token) {
    console.error(`[xiaomifeng] file download skipped — missing accid/token for file check auth`);
    return null;
  }
  try {
    // First resolve via check API (requires accessToken auth)
    const resolvedUrl = await checkFileUrl(fileUrl, { accid, token }, apiBase);
    if (!resolvedUrl) {
      return null;
    }

    const response = await fetch(resolvedUrl);
    if (!response.ok) {
      console.error(
        `[xiaomifeng] file download failed — status: ${response.status}, url: ${resolvedUrl}`,
      );
      return null;
    }

    // Determine filename: prefer hint.name, then Content-Disposition, then URL path
    let filename = hint?.name ?? "";
    if (!filename) {
      const disposition = response.headers.get("content-disposition") ?? "";
      const match = /filename[^;=\n]*=(?:(['"])(?<q>[^'"]*)\1|(?<bare>[^;\n]*))/i.exec(disposition);
      filename = match?.groups?.q ?? match?.groups?.bare ?? "";
    }
    if (!filename) {
      // Extract last path segment from URL, strip query
      const urlPath = new URL(resolvedUrl).pathname;
      filename = urlPath.split("/").pop() ?? "";
    }
    if (!filename) {
      const urlHash = createHash("md5").update(fileUrl).digest("hex").substring(0, 8);
      filename = `xiaomifeng-file-${urlHash}`;
    }

    // Prefix with hash+timestamp to avoid collisions
    const urlHash = createHash("md5").update(fileUrl).digest("hex").substring(0, 8);
    const safeFilename = `xiaomifeng-file-${urlHash}-${Date.now()}-${filename}`;
    const cacheDir = getXiaomifengMediaCacheDir();
    const localPath = join(cacheDir, safeFilename);

    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(localPath, Buffer.from(await response.arrayBuffer()));
    return localPath;
  } catch (err) {
    console.error(`[xiaomifeng] file download error — url: ${fileUrl}, error: ${String(err)}`);
    return null;
  }
}

// ─── types ─────────────────────────────────────────────────────────────────────

export interface XiaomifengCustomMessageContent {
  text?: string;
  url?: string;
  subType?: number;
  /** msgType=22: file name */
  name?: string;
  /** msgType=14: share card fields */
  cardType?: number;
  title?: string;
  titleIcon?: string;
  subTitle?: string;
  imgsrc?: string;
  imageRatio?: number;
  skipUrl?: string;
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
  /** Chat type from raw envelope (1=single, 2=group). */
  chatType?: number;
  /** NIM-level raw msgType from the envelope. */
  msgType?: number;
  content: XiaomifengCustomMessageContent;
  isText: boolean;
  isImage: boolean;
  /** msgType=22: content is a file attachment */
  isFile: boolean;
  /** msgType=14: content is a share card */
  isShareCard: boolean;
  text?: string;
  imageUrl?: string;
  /** msgType=22: remote file URL (before check API resolution) */
  fileUrl?: string;
  /** msgType=22: original filename hint */
  fileName?: string;
  /** msgType=14: composed text to feed to the agent */
  shareCardText?: string;
  /** Passport list from atUsers in content (used for @-mention detection). */
  atPassports: string[];
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
  const m = msg as Record<string, unknown>;

  // ── 1. Extract the raw envelope from rawMsg.attachment.raw ─────────────────
  let envelope: RawAttachmentEnvelope | null = null;

  const rawMsg = m.rawMsg as Record<string, unknown> | undefined;
  const attachmentRaw = (rawMsg?.attachment as Record<string, unknown> | undefined)?.raw;

  if (typeof attachmentRaw === "string" && attachmentRaw.trim()) {
    envelope = safeParseJSON<RawAttachmentEnvelope | null>(attachmentRaw, null);
  }

  // ── 2. Determine business senderId and chatId ──────────────────────────────
  // Prefer envelope values; fall back to NIM-level from/to.
  const senderId = envelope?.senderId ?? coerceUnknownToString(m.from);
  const chatId = envelope?.chatId ?? coerceUnknownToString(m.to);

  // ── 3. Parse inner content ─────────────────────────────────────────────────
  // envelope.content is itself a JSON string: e.g. '{"text":"哈哈"}'
  let content: XiaomifengCustomMessageContent = {};

  if (envelope?.content) {
    content = safeParseJSON<XiaomifengCustomMessageContent>(envelope.content, {});
  } else if (typeof m.text === "string" && m.text.trim()) {
    // Plain text fallback (no rawMsg envelope present).
    content = safeParseJSON<XiaomifengCustomMessageContent>(m.text, { text: m.text });
  }

  // ── 4. Classify ───────────────────────────────────────────────────────────
  const innerMsgType = envelope?.msgType;
  const hasText = typeof content.text === "string" && content.text.length > 0;
  const hasUrl = typeof content.url === "string" && content.url.length > 0;

  // msgType=22: file attachment
  const isFile = innerMsgType === 22;

  // msgType=14: share card (only cardType=1 dynamic handled)
  const isShareCard = innerMsgType === 14;

  // Image: url present and not a file or share card
  const isImage = !isFile && !isShareCard && (hasUrl || content.subType === 2);

  // Text: not image/file/shareCard
  const isText = !isImage && !isFile && !isShareCard && (hasText || content.subType === 1);

  // Build text representation
  let text: string | undefined;
  let fileUrl: string | undefined;
  let fileName: string | undefined;
  let shareCardText: string | undefined;

  if (isFile) {
    fileUrl = typeof content.url === "string" ? content.url : undefined;
    fileName = typeof content.name === "string" ? content.name : undefined;
    text = fileName ? `[文件] ${fileName}` : "[文件]";
  } else if (isShareCard) {
    const cardTitle = typeof content.title === "string" ? content.title : "";
    const cardSubTitle = typeof content.subTitle === "string" ? content.subTitle : "";
    const rawSkipUrl = typeof content.skipUrl === "string" ? content.skipUrl : "";
    const cardSkipUrl = convertNewsappUrl(rawSkipUrl);
    shareCardText = `分享了一批标题为「${cardTitle}」副标题为「${cardSubTitle}」访问地址为 ${cardSkipUrl} 的笔记`;
    text = shareCardText;
  } else if (isImage) {
    text = content.url;
  } else {
    text = content.text;
  }

  // ── 5. Extract @-mentioned passports from atUsers ─────────────────────────
  const atUsers = Array.isArray(content.atUsers) ? content.atUsers : [];
  const atPassports: string[] = atUsers
    .map((u: Record<string, unknown>) =>
      typeof u.passport === "string" ? u.passport.toLowerCase() : "",
    )
    .filter(Boolean);

  return {
    senderId,
    chatId,
    chatType: envelope?.chatType,
    msgType: envelope?.msgType,
    content,
    isText,
    isImage,
    isFile,
    isShareCard,
    text,
    imageUrl: isImage ? content.url : undefined,
    fileUrl,
    fileName,
    shareCardText,
    atPassports,
  };
}

// ─── helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert app-internal deep-link URLs to accessible HTTP URLs.
 *
 *   newsapp://nc/rec/{ID}        → https://m.mifengs.com/reader/{ID}.html
 *   ntescommunity://nc/recImg?id={ID} → https://m.mifengs.com/reader/{ID}.html
 *
 * Returns the original URL unchanged if it doesn't match any known scheme.
 */
function convertNewsappUrl(url: string): string {
  // newsapp://nc/rec/{ID}
  const newsapp = /^newsapp:\/\/nc\/rec\/([A-Za-z0-9]+)/.exec(url);
  if (newsapp) {
    return `https://m.mifengs.com/reader/${newsapp[1]}.html`;
  }
  // ntescommunity://nc/recImg?id={ID}
  const community = /^ntescommunity:\/\/nc\/recImg\?id=([A-Za-z0-9]+)/.exec(url);
  if (community) {
    return `https://m.mifengs.com/reader/${community[1]}.html`;
  }
  return url;
}

/** Returns true for NIM custom message type (100 or "custom"). */
export function isCustomMessage(msgType: string | number): boolean {
  return msgType === "custom" || msgType === 100;
}

/**
 * Extract the display text from a parsed custom message.
 * Images use a placeholder so the media pipeline provides the downloaded local
 * path via MediaPath/MediaUrl instead of embedding the remote CDN URL in the
 * body text (mirrors the native NIM image message behaviour).
 * Files use a placeholder; the actual file is passed via MediaPath.
 * Share cards are composed into readable text.
 */
export function extractCustomMessageText(parsed: ParsedCustomMessage): string {
  if (parsed.isImage && parsed.imageUrl) {
    return "[图片]";
  }
  if (parsed.isFile) {
    return parsed.fileName ? `[文件] ${parsed.fileName}` : "[文件]";
  }
  if (parsed.isShareCard && parsed.shareCardText) {
    return parsed.shareCardText;
  }
  if (parsed.text) {
    return parsed.text;
  }
  return "";
}
