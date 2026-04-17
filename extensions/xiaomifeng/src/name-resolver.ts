/**
 * Name Resolver — user nick + group name lookup.
 *
 * Queries names via the NIM SDK V2 API and caches them in-memory (TTL).
 */

/** Cache TTL: 5 minutes. */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const userNickCache = new Map<string, CacheEntry>();
const teamNameCache = new Map<string, CacheEntry>();

interface NimUserService {
  getUserList(accids: string[]): Promise<Array<{ name?: string; nick?: string }>>;
}

interface NimTeamService {
  getTeamInfo(teamId: string, teamType: number): Promise<{ name?: string } | null | undefined>;
}

interface NimSdkLookup {
  V2NIMUserService?: NimUserService;
  V2NIMTeamService?: NimTeamService;
}

function getCached(cache: Map<string, CacheEntry>, key: string): string | undefined {
  const entry = cache.get(key);
  if (!entry) {
    return undefined;
  }
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCache(cache: Map<string, CacheEntry>, key: string, value: string): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Resolve user nickname.
 * Prefer message-provided fromNick, otherwise query V2NIMUserService.
 * Fall back to accid on failure.
 */
export async function resolveUserNick(
  nim: unknown,
  accid: string,
  fromNick?: string,
): Promise<string> {
  const nimObj = nim as NimSdkLookup;
  // 1. Prefer message-provided nick.
  if (fromNick) {
    setCache(userNickCache, accid, fromNick);
    return fromNick;
  }

  // 2. Cache hit.
  const cached = getCached(userNickCache, accid);
  if (cached) {
    return cached;
  }

  // 3. Query via SDK.
  try {
    const userService = nimObj.V2NIMUserService;
    if (userService) {
      const users = await userService.getUserList([accid]);
      if (users && users.length > 0) {
        const nick = users[0].name || users[0].nick || "";
        if (nick) {
          setCache(userNickCache, accid, nick);
          return nick;
        }
      }
    }
  } catch (err) {
    console.error(`[xiaomifeng] resolveUserNick failed — accid: ${accid}, error: ${String(err)}`);
  }

  // 4. Fallback.
  return accid;
}

/**
 * Resolve team name.
 * Query V2NIMTeamService.
 * Fall back to teamId on failure.
 */
export async function resolveTeamName(
  nim: unknown,
  teamId: string,
  sessionType: "team" | "superTeam" = "team",
): Promise<string> {
  const nimObj = nim as NimSdkLookup;
  const cacheKey = `${sessionType}:${teamId}`;

  // 1. Cache hit.
  const cached = getCached(teamNameCache, cacheKey);
  if (cached) {
    return cached;
  }

  // 2. Query via SDK.
  try {
    const teamService = nimObj.V2NIMTeamService;
    if (teamService) {
      // V2NIM_TEAM_TYPE_ADVANCED = 1 (normal/advanced team), V2NIM_TEAM_TYPE_SUPER = 2 (super team)
      const teamType = sessionType === "superTeam" ? 2 : 1;
      const teamInfo = await teamService.getTeamInfo(teamId, teamType);
      const name = teamInfo?.name || "";
      if (name) {
        setCache(teamNameCache, cacheKey, name);
        return name;
      }
    }
  } catch (err) {
    console.error(`[xiaomifeng] resolveTeamName failed — teamId: ${teamId}, error: ${String(err)}`);
  }

  // 3. Fallback.
  return teamId;
}

/**
 * Build a conversation label.
 */
export function buildConversationLabel(kind: "p2p" | "team", displayName: string): string {
  switch (kind) {
    case "p2p":
      return `小蜜蜂·单聊·${displayName}`;
    case "team":
      return `小蜜蜂·群聊·${displayName}`;
    default:
      return displayName;
  }
}
