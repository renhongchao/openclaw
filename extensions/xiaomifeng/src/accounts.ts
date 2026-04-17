import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type {
  XiaomifengConfig,
  XiaomifengInstanceConfig,
  ResolvedXiaomifengAccount,
  XiaomifengP2pPolicy,
  XiaomifengTeamPolicy,
} from "./types.js";

/**
 * Fixed NIM App Key for XiaoMiFeng platform.
 * Users only need to provide clientId + clientSecret.
 */
export const XIAOMIFENG_FIXED_APP_KEY = "1c114416fb93ec4d5489e885a64eb6c5";

/**
 * Coerce a value to string.
 */
function coerceToString(value: unknown): string {
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

/**
 * Derive the internal NIM SDK token string from clientId + clientSecret.
 * Format: FIXED_APP_KEY + '-' + clientId + '-' + clientSecret
 */
function deriveNimToken(clientId: string, clientSecret: string): string {
  return `${XIAOMIFENG_FIXED_APP_KEY}-${clientId}-${clientSecret}`;
}

/**
 * Parse NIM token string ("appKey-accid-token") into parts.
 */
function parseNimToken(
  nimToken: string | undefined,
): { appKey: string; account: string; token: string } | null {
  if (!nimToken) {
    return null;
  }
  const parts = nimToken.split("-");
  if (parts.length !== 3) {
    return null;
  }
  const [appKey, account, token] = parts.map((p) => p.trim());
  if (!appKey || !account || !token) {
    return null;
  }
  return { appKey, account, token };
}

/**
 * Resolve XiaoMiFeng credentials from config.
 * Derives NIM token from clientId + clientSecret using the fixed app key.
 * Returns null if required credentials are missing.
 */
export function resolveXiaomifengCredentials(
  cfg: XiaomifengInstanceConfig | undefined,
): { appKey: string; account: string; token: string } | null {
  const clientId = cfg?.clientId ? coerceToString(cfg.clientId).trim() : "";
  const clientSecret = cfg?.clientSecret ? coerceToString(cfg.clientSecret).trim() : "";

  if (!clientId || !clientSecret) {
    return null;
  }

  return parseNimToken(deriveNimToken(clientId, clientSecret));
}

/**
 * Derive accountId — equals clientId directly.
 */
export function deriveXiaomifengAccountId(
  cfg: XiaomifengInstanceConfig | undefined,
): string | null {
  const clientId = cfg?.clientId ? coerceToString(cfg.clientId).trim() : "";
  if (!clientId) {
    return null;
  }
  return clientId;
}

/**
 * Resolve config into a ResolvedXiaomifengAccount.
 */
function resolveInstance(cfg: XiaomifengInstanceConfig): ResolvedXiaomifengAccount {
  const creds = resolveXiaomifengCredentials(cfg);
  const clientId = cfg.clientId ? coerceToString(cfg.clientId).trim() : "";

  return {
    id: clientId,
    accountId: clientId,
    appKey: creds?.appKey ?? XIAOMIFENG_FIXED_APP_KEY,
    account: creds?.account ?? clientId,
    token: creds?.token ?? "",
    enabled: cfg.enabled ?? true,
    configured: Boolean(creds),
    p2pPolicy: (cfg.p2p?.policy as XiaomifengP2pPolicy) ?? "open",
    allowFrom: cfg.p2p?.allowFrom ?? [],
    teamPolicy: (cfg.team?.policy as XiaomifengTeamPolicy) ?? "open",
    teamIds: cfg.team?.allowFrom ?? [],
    config: cfg,
  };
}

/**
 * Resolve the XiaoMiFeng account from config (single-account, flat structure).
 * Reads directly from channels.xiaomifeng as a flat object.
 * Returns an array with one element for framework compatibility, or empty if not configured.
 */
export function resolveAllXiaomifengAccounts(params: {
  cfg: OpenClawConfig;
}): ResolvedXiaomifengAccount[] {
  const { cfg } = params;
  const xiaomifengCfg = cfg.channels?.xiaomifeng as XiaomifengConfig | undefined;
  if (!xiaomifengCfg) {
    return [];
  }

  // Flat structure: channels.xiaomifeng is the config object directly.
  if (xiaomifengCfg.clientId) {
    return [resolveInstance(xiaomifengCfg)];
  }

  return [];
}

/**
 * Resolve account by accountId (= clientId).
 * Returns a not-configured stub if not found.
 */
export function resolveXiaomifengAccountById(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): ResolvedXiaomifengAccount {
  const { cfg, accountId } = params;
  const all = resolveAllXiaomifengAccounts({ cfg });
  const found = all.find((a) => a.accountId === accountId);
  if (found) {
    return found;
  }

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
    config: {} as XiaomifengInstanceConfig,
  };
}

/**
 * Return accountId for the configured account, or empty array.
 */
export function listXiaomifengAccountIds(cfg: OpenClawConfig): string[] {
  return resolveAllXiaomifengAccounts({ cfg })
    .map((a) => a.accountId)
    .filter(Boolean);
}

/**
 * Resolve the single XiaoMiFeng account.
 */
export function resolveXiaomifengAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedXiaomifengAccount {
  const { cfg, accountId } = params;
  if (accountId) {
    return resolveXiaomifengAccountById({ cfg, accountId });
  }
  const all = resolveAllXiaomifengAccounts({ cfg });
  if (all.length > 0) {
    return all[0];
  }
  return resolveXiaomifengAccountById({ cfg, accountId: "" });
}

/**
 * Normalize an allow-list into a set for fast matching.
 */
export function normalizeXiaomifengAllowFrom(configAllowFrom: Array<string | number>): {
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
export function resolveXiaomifengAllowlistMatch(params: {
  allowFrom: Array<string | number>;
  senderId: string;
}): { allowed: boolean; matchedEntry?: string; matchSource?: string } {
  const { senderId } = params;
  const { hasWildcard, entries } = normalizeXiaomifengAllowFrom(params.allowFrom);

  if (hasWildcard) {
    return { allowed: true, matchedEntry: "*", matchSource: "wildcard" };
  }

  const normalizedSenderId = senderId.toLowerCase();
  if (entries.has(normalizedSenderId)) {
    return { allowed: true, matchedEntry: normalizedSenderId, matchSource: "id" };
  }

  return { allowed: false };
}

/**
 * Check if P2P message is allowed based on policy and sender.
 */
export function isXiaomifengP2pAllowed(params: {
  p2pPolicy: XiaomifengP2pPolicy;
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

  if (!params.allowFrom || params.allowFrom.length === 0) {
    return { allowed: false, reason: "disabled" };
  }

  const match = resolveXiaomifengAllowlistMatch({ allowFrom: params.allowFrom, senderId });
  if (match.allowed) {
    return { allowed: true };
  }
  return { allowed: false, reason: "blocked" };
}

/**
 * Check if a team message is allowed.
 */
export function isXiaomifengTeamAllowed(params: {
  teamPolicy: XiaomifengTeamPolicy;
  teamIds: Array<string | number>;
  groupId: string;
  senderId: string;
  sessionType: "team" | "superTeam";
}): boolean {
  const { teamPolicy, teamIds, groupId, senderId, sessionType } = params;

  if (teamPolicy === "disabled") {
    return false;
  }
  if (teamPolicy === "open") {
    return true;
  }
  if (!teamIds || teamIds.length === 0) {
    return false;
  }

  const nGroupId = groupId.toLowerCase();
  const nSenderId = senderId.toLowerCase();

  return teamIds.some((entry) => {
    const parts = String(entry).split("|");
    const first = parts[0].trim();

    let entryType: string | null = null;
    let entryTeamId: string;
    let entrySender: string;

    if (first === "1" || first === "2") {
      entryType = first;
      entryTeamId = (parts[1] ?? "").trim().toLowerCase();
      entrySender = (parts[2] ?? "").trim().toLowerCase();
    } else {
      entryTeamId = first.toLowerCase();
      entrySender = (parts[1] ?? "").trim().toLowerCase();
    }

    if (entryType !== null) {
      const expectedType = entryType === "1" ? "team" : "superTeam";
      if (sessionType !== expectedType) {
        return false;
      }
    }

    if (entryTeamId !== nGroupId) {
      return false;
    }
    return !entrySender || entrySender === nSenderId;
  });
}
