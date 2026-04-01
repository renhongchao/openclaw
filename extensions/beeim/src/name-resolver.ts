/**
 * Name Resolver — 用户昵称、群名解析模块
 *
 * 通过 NIM SDK V2 API 查询名称，并使用内存缓存（TTL）减少 API 调用。
 */

/** 缓存 TTL：5 分钟 */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const userNickCache = new Map<string, CacheEntry>();
const teamNameCache = new Map<string, CacheEntry>();

function getCached(cache: Map<string, CacheEntry>, key: string): string | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
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
 * 解析用户昵称。
 * 优先使用消息中自带的 fromNick，否则通过 V2NIMUserService 查询。
 * 查询失败时 fallback 到 accid。
 */
export async function resolveUserNick(nim: any, accid: string, fromNick?: string): Promise<string> {
  // 1. 消息自带的 nick 最优先
  if (fromNick) {
    setCache(userNickCache, accid, fromNick);
    return fromNick;
  }

  // 2. 缓存命中
  const cached = getCached(userNickCache, accid);
  if (cached) return cached;

  // 3. 调用 SDK 查询
  try {
    const userService = nim.V2NIMUserService;
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
    console.error(`[beeim] resolveUserNick failed — accid: ${accid}, error: ${String(err)}`);
  }

  // 4. Fallback
  return accid;
}

/**
 * 解析群名称。
 * 通过 V2NIMTeamService 查询群名。
 * 查询失败时 fallback 到 teamId。
 */
export async function resolveTeamName(
  nim: any,
  teamId: string,
  sessionType: "team" | "superTeam" = "team",
): Promise<string> {
  const cacheKey = `${sessionType}:${teamId}`;

  // 1. 缓存命中
  const cached = getCached(teamNameCache, cacheKey);
  if (cached) return cached;

  // 2. 调用 SDK 查询
  try {
    const teamService = nim.V2NIMTeamService;
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
    console.error(`[beeim] resolveTeamName failed — teamId: ${teamId}, error: ${String(err)}`);
  }

  // 3. Fallback
  return teamId;
}

/**
 * 构建会话标签。
 */
export function buildConversationLabel(kind: "p2p" | "team", displayName: string): string {
  switch (kind) {
    case "p2p":
      return `云信·单聊·${displayName}`;
    case "team":
      return `云信·群聊·${displayName}`;
  }
}
