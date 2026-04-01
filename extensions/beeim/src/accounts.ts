import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type {
  BeeimConfig,
  BeeimInstanceConfig,
  ResolvedBeeimAccount,
  BeeimP2pPolicy,
  BeeimTeamPolicy,
} from "./types.js";

/**
 * Default account ID for BeeIM (legacy single-account mode, kept for compatibility).
 * @deprecated Multi-instance mode uses derived "appKey:accid" keys.
 */
export const DEFAULT_BEEIM_ACCOUNT_ID = "default";

/**
 * Coerce a value to string.
 * Handles cases where YAML parses numeric values (e.g., account: 123456) as numbers.
 */
function coerceToString(value: unknown): string {
  if (typeof value === "number") {
    return String(value);
  }
  return String(value ?? "");
}

/**
 * Parse the shorthand beeImToken field ("appKey-accid-token").
 * Returns the three credential parts, or null if the format is invalid.
 */
function parseNimToken(
  beeImToken: string | undefined,
): { appKey: string; account: string; token: string } | null {
  if (!beeImToken) return null;
  const parts = beeImToken.split("-");
  if (parts.length !== 3) return null;
  const [appKey, account, token] = parts.map((p) => p.trim());
  if (!appKey || !account || !token) return null;
  return { appKey, account, token };
}

/**
 * Resolve BeeIM credentials from a single instance configuration.
 * Priority: beeImToken (shorthand) > individual appKey/account/token fields.
 * Returns null if required credentials are missing.
 */
export function resolveBeeimCredentials(
  cfg: BeeimInstanceConfig | undefined,
): { appKey: string; account: string; token: string } | null {
  // 1. Try beeImToken shorthand first
  const fromToken = parseNimToken(cfg?.beeImToken);
  if (fromToken) {
    return fromToken;
  }

  // 2. Fall back to individual fields
  if (!cfg?.appKey || !cfg?.account || !cfg?.token) {
    return null;
  }
  return {
    appKey: coerceToString(cfg.appKey),
    account: coerceToString(cfg.account),
    token: coerceToString(cfg.token),
  };
}

/**
 * Derive the accountId key for an instance: "<appKey>:<accid>".
 * Returns null if credentials cannot be resolved.
 */
export function deriveBeeimAccountId(cfg: BeeimInstanceConfig | undefined): string | null {
  const creds = resolveBeeimCredentials(cfg);
  if (!creds) return null;
  return `${creds.appKey}:${creds.account}`;
}

/**
 * Resolve a single BeeIM instance config into a ResolvedBeeimAccount.
 */
function resolveInstance(inst: BeeimInstanceConfig): ResolvedBeeimAccount {
  const creds = resolveBeeimCredentials(inst);
  const accountId = creds ? `${creds.appKey}:${creds.account}` : "";

  return {
    id: accountId,
    accountId,
    appKey: creds?.appKey ?? coerceToString(inst.appKey),
    account: creds?.account ?? coerceToString(inst.account),
    token: creds?.token ?? "",
    enabled: inst.enabled ?? false,
    configured: Boolean(creds),
    p2pPolicy: (inst.p2p?.policy as BeeimP2pPolicy) ?? "open",
    allowFrom: inst.p2p?.allowFrom ?? [],
    teamPolicy: (inst.team?.policy as BeeimTeamPolicy) ?? "open",
    teamIds: inst.team?.allowFrom ?? [],
    config: inst,
  };
}

/**
 * Resolve all BeeIM instances from OpenClaw configuration.
 * Supports the multi-instance format: channels.beeim.instances = [...]
 * Returns an empty array if channels.beeim is not configured.
 */
export function resolveAllBeeimAccounts(params: { cfg: OpenClawConfig }): ResolvedBeeimAccount[] {
  const { cfg } = params;
  const beeimCfg = cfg.channels?.beeim as BeeimConfig | undefined;
  if (!beeimCfg) return [];

  // Multi-instance format: { instances: [...] }
  const instances = (beeimCfg as { instances?: unknown }).instances;
  if (Array.isArray(instances) && instances.length > 0) {
    return instances.map(resolveInstance);
  }

  return [];
}

/**
 * Resolve a single BeeIM account by its derived accountId ("appKey:accid").
 * Returns a not-configured stub if not found.
 */
export function resolveBeeimAccountById(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): ResolvedBeeimAccount {
  const { cfg, accountId } = params;
  const all = resolveAllBeeimAccounts({ cfg });
  const found = all.find((a) => a.accountId === accountId);
  if (found) return found;

  // Return a not-configured stub so callers don't need to handle undefined
  return {
    id: accountId,
    accountId,
    appKey: "",
    account: "",
    token: "",
    enabled: false,
    configured: false,
    p2pPolicy: "open",
    allowFrom: [],
    teamPolicy: "open",
    teamIds: [],
    config: {} as BeeimInstanceConfig,
  };
}

/**
 * Resolve a single BeeIM account by its derived accountId ("appKey:accid").
 * Alias for resolveBeeimAccountById — used by channel.ts.
 */
export function resolveBeeimAccountByKey(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): ResolvedBeeimAccount {
  return resolveBeeimAccountById(params);
}

/**
 * Return derived accountId keys for all configured instances (enabled or disabled).
 */
export function listBeeimAccountIds(cfg: OpenClawConfig): string[] {
  return resolveAllBeeimAccounts({ cfg }).map((a) => a.accountId);
}

/**
 * @deprecated Use resolveBeeimAccountById instead.
 * Kept for compatibility with channel.ts single-account references.
 */
export function resolveBeeimAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedBeeimAccount {
  const { cfg, accountId } = params;
  if (accountId) {
    return resolveBeeimAccountById({ cfg, accountId });
  }
  // Fallback: return first instance
  const all = resolveAllBeeimAccounts({ cfg });
  if (all.length > 0) return all[0];
  return resolveBeeimAccountById({ cfg, accountId: "" });
}

/**
 * Normalize an allow-list into a set for fast matching.
 * Supports wildcard "*" detection.
 */
export function normalizeBeeimAllowFrom(configAllowFrom: Array<string | number>): {
  hasWildcard: boolean;
  hasEntries: boolean;
  entries: Set<string>;
} {
  const combined = (configAllowFrom ?? [])
    .map((v) => String(v).trim().toLowerCase())
    .filter(Boolean);

  const hasWildcard = combined.includes("*");
  const entries = new Set(combined.filter((e) => e !== "*"));

  return { hasWildcard, hasEntries: entries.size > 0, entries };
}

/**
 * Check if a sender is in the allowlist.
 */
export function resolveBeeimAllowlistMatch(params: {
  allowFrom: Array<string | number>;
  senderId: string;
}): {
  allowed: boolean;
  matchedEntry?: string;
  matchSource?: string;
} {
  const { senderId } = params;
  const { hasWildcard, entries } = normalizeBeeimAllowFrom(params.allowFrom);

  if (hasWildcard) {
    return { allowed: true, matchedEntry: "*", matchSource: "wildcard" };
  }

  const normalizedSenderId = senderId.toLowerCase();
  if (entries.has(normalizedSenderId)) {
    return {
      allowed: true,
      matchedEntry: normalizedSenderId,
      matchSource: "id",
    };
  }

  return { allowed: false };
}

/**
 * Check if P2P message is allowed based on policy and sender.
 * Modes: open → allowlist → disabled.
 */
export function isBeeimP2pAllowed(params: {
  p2pPolicy: BeeimP2pPolicy;
  allowFrom: Array<string | number>;
  senderId: string;
}): { allowed: boolean; reason?: "blocked" | "disabled" } {
  const { p2pPolicy, senderId } = params;

  if (p2pPolicy === "disabled") {
    return { allowed: false, reason: "disabled" };
  }

  if (p2pPolicy === "open") {
    return { allowed: true };
  }

  // "allowlist" with empty list — treat as disabled
  if (!params.allowFrom || params.allowFrom.length === 0) {
    return { allowed: false, reason: "disabled" };
  }

  // "allowlist" — check the allowlist
  const match = resolveBeeimAllowlistMatch({
    allowFrom: params.allowFrom,
    senderId,
  });

  if (match.allowed) {
    return { allowed: true };
  }

  // allowlist mode — silent block
  return { allowed: false, reason: "blocked" };
}

/**
 * Check if a team message is allowed based on team policy, group ID, sender, and session type.
 */
export function isBeeimTeamAllowed(params: {
  teamPolicy: BeeimTeamPolicy;
  teamIds: Array<string | number>;
  groupId: string;
  senderId: string;
  sessionType: "team" | "superTeam";
}): boolean {
  const { teamPolicy, teamIds, groupId, senderId, sessionType } = params;

  if (teamPolicy === "disabled") return false;
  if (teamPolicy === "open") return true;

  // "allowlist" with empty list — treat as disabled
  if (!teamIds || teamIds.length === 0) return false;

  const nGroupId = groupId.toLowerCase();
  const nSenderId = senderId.toLowerCase();

  return teamIds.some((entry) => {
    const parts = String(entry).split("|");
    const first = parts[0].trim();

    let entryType: string | null = null;
    let entryTeamId: string;
    let entrySender: string;

    if (first === "1" || first === "2") {
      // Type-prefixed entry: "1|teamId" or "2|superTeamId" (with optional sender)
      entryType = first;
      entryTeamId = (parts[1] ?? "").trim().toLowerCase();
      entrySender = (parts[2] ?? "").trim().toLowerCase();
    } else {
      // No type prefix — matches both team and superTeam
      entryTeamId = first.toLowerCase();
      entrySender = (parts[1] ?? "").trim().toLowerCase();
    }

    // If entry has a type prefix, enforce session type match
    if (entryType !== null) {
      const expectedType = entryType === "1" ? "team" : "superTeam";
      if (sessionType !== expectedType) return false;
    }

    if (entryTeamId !== nGroupId) return false;
    return !entrySender || entrySender === nSenderId;
  });
}
