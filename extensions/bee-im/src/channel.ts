/**
 * BeeIM Channel 插件定义
 * 集成到 OpenClaw 的 Channel 系统
 */

import {
  listBeeIMAccountIds,
  resolveBeeIMAccount,
  resolveBeeIMAccountConfig,
  resolveDefaultBeeIMAccountId,
  normalizeBeeIMAllowList,
  DEFAULT_ACCOUNT_ID,
} from "./accounts.js";
import { BeeIMClient } from "./client.js";
import { BeeIMConfigSchema } from "./config-schema.js";
import { activeClients } from "./monitor.js";
import { getBeeIMRuntime, getBeeIMRuntimeStatus, setBeeIMRuntimeStatus } from "./runtime.js";
import type {
  ResolvedBeeIMAccount,
  BeeIMCoreConfig,
  BeeIMRuntimeStatus,
  BeeIMProbeResult,
  BeeIMAccountSnapshot,
} from "./types.js";

// ============================================================================
// Helpers
// ============================================================================

/** Channel 插件元数据 */
const meta = {
  id: "bee-im",
  label: "BeeIM",
  selectionLabel: "BeeIM (小蜜蜂 IM)",
  docsPath: "/channels/bee-im",
  docsLabel: "bee-im",
  blurb: "小蜜蜂 IM WebSocket 消息通道",
  order: 80,
  quickstartAllowFrom: true,
};

/** 规范化消息目标 */
function normalizeBeeIMMessagingTarget(raw: string): string | undefined {
  let normalized = raw.trim();
  if (!normalized) {
    return undefined;
  }
  const lowered = normalized.toLowerCase();
  if (lowered.startsWith("bee-im:") || lowered.startsWith("beeim:")) {
    normalized = normalized.slice(normalized.indexOf(":") + 1).trim();
  }
  const stripped = normalized.replace(/^(private|group|user|chat):/i, "").trim();
  return stripped || undefined;
}

/** 构建 Channel 配置 Schema */
function buildChannelConfigSchema(schema: typeof BeeIMConfigSchema) {
  return schema;
}

/** 构建探测状态摘要 */
function buildProbeChannelStatusSummary(
  snapshot: BeeIMAccountSnapshot,
  extra: { wsUrl: string | null },
): string {
  const parts: string[] = [];

  if (snapshot.running) {
    parts.push("running");
  } else {
    parts.push("stopped");
  }

  if (snapshot.probe?.ok) {
    parts.push("connected");
  } else if (snapshot.probe?.error) {
    parts.push(`error: ${snapshot.probe.error}`);
  }

  if (extra.wsUrl) {
    parts.push(`ws: ${extra.wsUrl}`);
  }

  return parts.join(", ");
}

/** 收集状态问题 */
function collectStatusIssuesFromLastError(
  channelId: string,
  accounts: Array<{ accountId: string; lastError: string | null }>,
): string[] {
  const issues: string[] = [];
  for (const account of accounts) {
    if (account.lastError) {
      issues.push(`[${channelId}:${account.accountId}] ${account.lastError}`);
    }
  }
  return issues;
}

// ============================================================================
// Helpers: 等待 gateway 客户端认证完成
// ============================================================================

/**
 * 等待 BeeIMClient 认证完成（轮询 authenticated 标志）
 * 仅在 outbound.sendText 复用 gateway 连接时使用。
 * @returns true=认证成功, false=超时
 */
async function waitForAuth(client: BeeIMClient, timeoutMs: number): Promise<boolean> {
  if (client.authenticated) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 200));
    if (client.authenticated) return true;
  }
  return false;
}

// ============================================================================
// BeeIM Channel 插件
// ============================================================================

/** BeeIM Channel 插件 */
export const beeIMPlugin = {
  id: "bee-im",
  meta,

  capabilities: {
    chatTypes: ["direct", "group"] as const,
    polls: false,
    reactions: false,
    threads: false,
    media: true, // 支持图片消息 (msgType=2)
  },

  reload: { configPrefixes: ["channels.bee-im"] },

  configSchema: buildChannelConfigSchema(BeeIMConfigSchema),

  config: {
    sectionKey: "bee-im",
    listAccountIds: (cfg: BeeIMCoreConfig) => listBeeIMAccountIds(cfg),
    resolveAccount: (cfg: BeeIMCoreConfig, accountId: string) =>
      resolveBeeIMAccount({ cfg, accountId }),
    resolveAccessorAccount: ({ cfg, accountId }: { cfg: BeeIMCoreConfig; accountId: string }) =>
      resolveBeeIMAccountConfig({ cfg, accountId }),
    defaultAccountId: (cfg: BeeIMCoreConfig) => resolveDefaultBeeIMAccountId(cfg),
    clearBaseFields: ["name", "wsUrl", "passport", "token", "app", "business"],
    resolveAllowFrom: (account: ResolvedBeeIMAccount) => {
      try {
        return account?.config?.dm?.allowFrom ?? undefined;
      } catch {
        return undefined;
      }
    },
    formatAllowFrom: (allowFrom: unknown) =>
      normalizeBeeIMAllowList(Array.isArray(allowFrom) ? allowFrom : undefined),
    isConfigured: (account: ResolvedBeeIMAccount) => account.configured,
    describeAccount: (account: ResolvedBeeIMAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      wsUrl: account.wsUrl,
    }),
  },

  /**
   * 安全/访问控制配置
   */
  security: {
    /** 收集安全警告 */
    collectWarnings: ({ account }: { account: ResolvedBeeIMAccount }) => {
      const warnings: string[] = [];
      const dmPolicy = account.config.dm?.policy ?? "open";
      if (dmPolicy === "open") {
        warnings.push(
          `[bee-im:${account.accountId}] dmPolicy="open" — 任何用户均可发送消息触发 AI。` +
            `建议设置 channels.bee-im.dm.policy="allowlist" 并配置 channels.bee-im.dm.allowFrom。`,
        );
      }
      return warnings;
    },
    /** 解析 DM 策略 */
    resolveDmPolicy: ({ account }: { account: ResolvedBeeIMAccount }) => {
      const policy = account.config.dm?.policy ?? "open";
      return {
        policy,
        allowFrom: account.config.dm?.allowFrom ?? null,
        policyPath: `channels.bee-im.dm.policy`,
        allowFromPath: `channels.bee-im.dm.allowFrom`,
        approveHint: "在配置文件中将用户 passport 加入 channels.bee-im.dm.allowFrom 列表",
      };
    },
  },

  /**
   * Setup adapter - 用于初始配置向导
   */
  setup: {
    resolveAccountId: ({ accountId }: { accountId?: string }) => accountId ?? DEFAULT_ACCOUNT_ID,

    applyAccountConfig: ({
      cfg,
      input,
    }: {
      cfg: BeeIMCoreConfig;
      accountId: string;
      input: Record<string, unknown>;
    }): BeeIMCoreConfig => {
      const channels = cfg.channels ?? {};
      const existing = (channels["bee-im"] ?? {}) as Record<string, unknown>;
      return {
        ...cfg,
        channels: {
          ...channels,
          "bee-im": {
            ...existing,
            ...input,
            enabled: true,
          },
        },
      };
    },

    validateInput: ({
      input,
    }: {
      cfg: BeeIMCoreConfig;
      accountId: string;
      input: Record<string, unknown>;
    }): string | null => {
      const errors: string[] = [];
      if (!input.passport) errors.push("passport（用户账号）是必填项");
      if (!input.token) errors.push("token（认证令牌）是必填项");
      if (!input.wsUrl) errors.push("wsUrl（WebSocket 服务器地址）是必填项");
      return errors.length > 0 ? errors.join("; ") : null;
    },
  },

  messaging: {
    normalizeTarget: normalizeBeeIMMessagingTarget,
    targetResolver: {
      looksLikeId: (raw: string) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return false;
        }
        if (/^(bee-im:|beeim:|private:|group:)/i.test(trimmed)) {
          return true;
        }
        // 邮箱格式
        return trimmed.includes("@");
      },
      hint: "<private:userId|group:groupId>",
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    } as BeeIMRuntimeStatus,

    collectStatusIssues: (accounts: BeeIMAccountSnapshot[]) =>
      collectStatusIssuesFromLastError("bee-im", accounts),

    buildChannelSummary: ({ snapshot }: { snapshot: BeeIMAccountSnapshot }) =>
      buildProbeChannelStatusSummary(snapshot, { wsUrl: snapshot.wsUrl ?? null }),

    probeAccount: async ({
      account,
      timeoutMs,
    }: {
      account: ResolvedBeeIMAccount;
      timeoutMs?: number;
      cfg: BeeIMCoreConfig;
    }): Promise<BeeIMProbeResult> => {
      const start = Date.now();
      try {
        if (!account.configured) {
          return {
            ok: false,
            error: "Account not configured (missing passport or token)",
            elapsedMs: Date.now() - start,
          };
        }

        // 检查缓存中的客户端连接状态
        const client = activeClients.get(account.accountId);
        if (client?.authenticated) {
          return {
            ok: true,
            elapsedMs: Date.now() - start,
            userId: account.passport,
          };
        }

        return {
          ok: false,
          error: "Not connected",
          elapsedMs: Date.now() - start,
          userId: account.passport,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          elapsedMs: Date.now() - start,
        };
      }
    },

    buildAccountSnapshot: ({
      account,
      runtime,
      probe,
    }: {
      account: ResolvedBeeIMAccount;
      runtime?: BeeIMRuntimeStatus;
      probe?: BeeIMProbeResult;
    }): BeeIMAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      wsUrl: account.wsUrl,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastProbeAt: runtime?.lastProbeAt ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx: {
      account: ResolvedBeeIMAccount;
      cfg: BeeIMCoreConfig;
      runtime: unknown;
      channelRuntime?: unknown;
      abortSignal?: AbortSignal;
      setStatus?: (status: Partial<BeeIMRuntimeStatus>) => void;
      log?: {
        info: (msg: string) => void;
        warn?: (msg: string) => void;
        error: (msg: string) => void;
      };
    }) => {
      const { account, cfg, runtime, channelRuntime, abortSignal, setStatus, log } = ctx;

      setStatus?.({
        accountId: account.accountId,
        wsUrl: account.wsUrl,
      });

      log?.info(`[${account.accountId}] starting BeeIM provider (${account.wsUrl})`);

      const { monitorBeeIMProvider } = await import("./monitor.js");

      return monitorBeeIMProvider({
        runtime,
        channelRuntime,
        cfg,
        abortSignal,
        accountId: account.accountId,
        account,
      });
    },

    stopAccount: async (ctx: { account: ResolvedBeeIMAccount; accountId: string }) => {
      activeClients.get(ctx.accountId)?.disconnect();
      activeClients.delete(ctx.accountId);
      setBeeIMRuntimeStatus(ctx.accountId, {
        running: false,
        lastStopAt: Date.now(),
      });
    },
  },

  outbound: {
    deliveryMode: "direct" as const,
    chunker: (text: string, limit: number) =>
      getBeeIMRuntime().channel.text.chunkMarkdownText?.(text, limit) ?? [text],
    chunkerMode: "plain" as const,
    textChunkLimit: 4000,

    /**
     * 发送文本消息
     */
    sendText: async (ctx: {
      cfg: BeeIMCoreConfig;
      to: string;
      text: string;
      accountId?: string | null;
    }) => {
      const accountId = ctx.accountId ?? DEFAULT_ACCOUNT_ID;
      const account = resolveBeeIMAccount({ cfg: ctx.cfg, accountId });

      if (!account.configured) {
        return { ok: false, error: "BeeIM account not configured" };
      }

      // 获取 gateway 已建立的客户端（优先复用，避免重复建连）
      const existingClient = activeClients.get(accountId);

      // 如果 gateway 的连接已存在（无论是否认证完成），直接复用，不抢占
      // 只有完全没有客户端时才临时建连（如纯 CLI 模式下没有 gateway 运行）
      if (existingClient) {
        if (!existingClient.authenticated) {
          // 连接中但还未认证：等待最多 15s 让 gateway 认证完成
          const result = await waitForAuth(existingClient, 15000);
          if (!result) {
            return { ok: false, error: "BeeIM client not authenticated (gateway connecting)" };
          }
        }
        return existingClient.sendTextMessage({ to: ctx.to, text: ctx.text });
      }

      // 没有 gateway 运行时，临时建立一个独立连接（不存入 activeClients，避免与 monitor 冲突）
      const tempClient = new BeeIMClient({
        wsUrl: account.wsUrl,
        passport: account.passport,
        token: account.token,
        app: account.app,
        business: account.business,
      });
      try {
        await tempClient.connect();
        const result = await tempClient.sendTextMessage({ to: ctx.to, text: ctx.text });
        tempClient.disconnect();
        return result;
      } catch (err) {
        tempClient.disconnect();
        const error = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Failed to connect: ${error}` };
      }
    },
  },
};

export type BeeIMPlugin = typeof beeIMPlugin;
