import { z } from "zod";

/**
 * Coerce value to string — handles number inputs from YAML
 * (e.g. `clientId: 123456` parsed as number).
 * Uses z.coerce.string() which is the zod v4 recommended approach.
 */
const coerceToString = z.coerce.string();

/** Union type for allow-list entries (string or number from YAML) */
const AllowEntryArray = z.array(z.union([z.string(), z.number()])).optional();

/**
 * P2P (direct message) sub-configuration.
 */
export const P2pSubConfigSchema = z.object({
  /**
   * Access policy.
   *   open      — accept messages from anyone (default)
   *   allowlist — only accept senders listed in allowFrom
   *   disabled  — reject all P2P messages
   */
  policy: z.enum(["open", "allowlist", "disabled"]).optional().default("open"),

  /** Allowed sender IDs (used when policy="allowlist") */
  allowFrom: AllowEntryArray,
});

/**
 * Team (group) sub-configuration.
 */
export const TeamSubConfigSchema = z.object({
  /**
   * Access policy.
   *   open      — accept messages from any group (default)
   *   allowlist — only accept groups (and optionally senders) listed in allowFrom
   *   disabled  — reject all team messages
   */
  policy: z.enum(["open", "allowlist", "disabled"]).optional().default("open"),

  /**
   * Allowlist entries (used when policy="allowlist").
   * Supported formats (case-insensitive):
   *   "groupId"           — any sender in this group
   *   "groupId|accountId" — specific sender in this group
   */
  allowFrom: AllowEntryArray,
});

/**
 * Advanced sub-configuration.
 */
export const AdvancedSubConfigSchema = z.object({
  /** Maximum media file size in MB */
  mediaMaxMb: z.number().min(0).optional().default(30),

  /** Text chunk limit for splitting long messages */
  textChunkLimit: z.number().min(1).optional().default(4000),

  /** Enable debug logging */
  debug: z.boolean().optional().default(false),

  /** Internal: legacy login mode */
  legacyLogin: z.boolean().optional().default(false),

  /** Private deployment: custom LBS URL */
  weblbsUrl: z.string().optional(),

  /** Private deployment: default WebSocket/TCP link address */
  link_web: z.string().optional(),

  /** Private deployment: NOS upload address */
  nos_uploader: z.string().optional(),

  /** Private deployment: NOS download URL format */
  nos_downloader_v2: z.string().optional(),

  /** Private deployment: whether NOS download uses HTTPS */
  nosSsl: z.boolean().optional(),

  /** Private deployment: CDN accelerate URL format */
  nos_accelerate: z.string().optional(),

  /** Private deployment: CDN accelerate host domain (empty string to disable) */
  nos_accelerate_host: z.string().optional(),

  /**
   * XiaoMiFeng HTTP API base URL.
   * Production (default): https://api.mifengs.com
   * Test environment:      http://api-test.mifengs.com
   */
  apiBase: z.string().url().optional().default("https://api.mifengs.com"),
});

/**
 * XiaoMiFeng channel configuration schema (single account).
 *
 * Flat structure — configured directly under `channels.xiaomifeng`:
 *   { clientId: "...", clientSecret: "...", botPassport: "...", p2p: {...}, ... }
 *
 * accountId equals clientId directly — no manual id needed.
 *
 * Credentials:
 *   clientId     — bot account ID issued by XiaoMiFeng platform
 *   clientSecret — authentication token issued by XiaoMiFeng platform
 *
 * Internally derived NIM token: FIXED_APP_KEY + '-' + clientId + '-' + clientSecret
 */
export const XiaomifengConfigSchema = z.object({
  /** Whether the channel is enabled. Defaults to true. */
  enabled: z.boolean().optional().default(true),

  /** Client ID — bot account ID issued by XiaoMiFeng platform */
  clientId: coerceToString.optional(),

  /** Client Secret — authentication token issued by XiaoMiFeng platform */
  clientSecret: coerceToString.optional(),

  /**
   * Bot passport (business-layer identity) for custom message @-mention detection.
   * Example: "youdaoclaw_1016@bee.163.com"
   * When set, group custom messages are only processed if atUsers contains this passport.
   * Can be left empty.
   */
  botPassport: z.string().optional(),

  /** Whether to enable anti-spam protection */
  antispamEnabled: z.boolean().optional().default(true),

  /** P2P (direct message) sub-configuration */
  p2p: P2pSubConfigSchema.optional(),

  /** Team (group) sub-configuration */
  team: TeamSubConfigSchema.optional(),

  /** Advanced sub-configuration */
  advanced: AdvancedSubConfigSchema.optional(),
});

/**
 * XiaoMiFeng instance config type — same as the top-level config now (single account).
 * Kept as alias for backward compatibility with code that references XiaomifengInstanceConfig.
 */
export const XiaomifengInstanceConfigSchema = XiaomifengConfigSchema;
