import { z } from "zod";

/**
 * Coerce value to string (handles number inputs from YAML).
 * YAML may parse values like `account: 123456` as numbers.
 */
const coerceToString = z.preprocess(
  (val) => (typeof val === "number" ? String(val) : val),
  z.string(),
);

/** Union type for allow-list entries (string or number from YAML) */
const AllowEntryArray = z.array(z.union([z.string(), z.number()])).optional();

/**
 * P2P (私聊) sub-configuration.
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
 * Team (群组) sub-configuration.
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
 * Advanced (基础设置) sub-configuration.
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
});

/**
 * A single BeeIM instance configuration (one bot account).
 * `accountId` is automatically derived as `appKey:accid` — no manual `id` needed.
 */
export const BeeimInstanceConfigSchema = z.object({
  /** Whether this instance is enabled (used when inside an `instances` array) */
  enabled: z.boolean().optional().default(false),

  /**
   * Shorthand credential: "appKey-accid-token" (3 segments separated by `-`).
   * When present and valid, takes priority over individual appKey/account/token fields.
   */
  nimToken: z.string().optional(),

  /** NIM App Key (coerced from number if needed) */
  appKey: coerceToString.optional(),

  /** Bot account ID (coerced from number if needed) */
  account: coerceToString.optional(),

  /** Authentication token (coerced from number if needed) */
  token: coerceToString.optional(),

  /** Whether to enable anti-spam protection */
  antispamEnabled: z.boolean().optional().default(true),

  /** P2P (私聊) sub-configuration */
  p2p: P2pSubConfigSchema.optional(),

  /** Team (群组) sub-configuration */
  team: TeamSubConfigSchema.optional(),

  /** Advanced (基础设置) sub-configuration */
  advanced: AdvancedSubConfigSchema.optional(),
});

const BeeimInstancesArraySchema = z
  .array(BeeimInstanceConfigSchema)
  .min(1, "channels.beeim.instances must have at least one instance")
  .max(3, "channels.beeim.instances may have at most 3 instances")
  .superRefine((instances, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      let key: string | null = null;
      if (inst.nimToken) {
        const parts = inst.nimToken.split("-");
        if (parts.length === 3) {
          key = `${parts[0].trim()}:${parts[1].trim()}`;
        }
      } else if (inst.appKey && inst.account) {
        key = `${inst.appKey}:${inst.account}`;
      }
      if (key) {
        if (seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate BeeIM instance credentials: "${key}" appears more than once`,
            path: [i],
          });
        }
        seen.add(key);
      }
    }
  });

/**
 * BeeIM channel configuration schema.
 *
 * Multi-instance format (up to 3 instances):
 *   { instances: [ { enabled, appKey, account, token, p2p, ... }, ... ] }
 *
 * The outer object wrapper is required so that the framework correctly detects
 * channels.beeim as a configured channel (isRecord check in config-presence.ts).
 * Each instance's accountId is automatically derived as "<appKey>:<accid>".
 */
export const BeeimConfigSchema = z.object({
  instances: BeeimInstancesArraySchema,
});
