/**
 * BeeIM Monitor - 消息监听模块
 */

import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { resolveBeeimCredentials, resolveBeeimAccountById } from "./accounts.js";
import { handleBeeimMessage } from "./bot.js";
import { createBeeimClient, clearBeeimClientCache } from "./client.js";
import type {
  BeeimInstanceConfig,
  BeeimClientInstance,
  BeeimMessageEvent,
  BeeimP2pPolicy,
} from "./types.js";

// ─── Message deduplication ──────────────────────────────────────────────────
// The NIM SDK sometimes fires the same message callback more than once for a
// single server event.  We keep a bounded set of recently-seen message keys
// (`sessionType:msgId`) and drop duplicates silently.

const DEDUP_MAX_SIZE = 500;
const DEDUP_TTL_MS = 30_000; // 30 seconds

interface DedupEntry {
  key: string;
  ts: number;
}

class MessageDeduplicator {
  private seen = new Map<string, number>(); // key → timestamp
  private queue: DedupEntry[] = []; // insertion-order for eviction

  /** Returns `true` if the message is a duplicate and should be dropped. */
  isDuplicate(sessionType: string, target: string, msgId: string): boolean {
    const key = `${sessionType}:${target}:${msgId}`;
    const now = Date.now();

    // Evict expired entries
    while (this.queue.length > 0 && now - this.queue[0]!.ts > DEDUP_TTL_MS) {
      const evicted = this.queue.shift()!;
      // Only delete from map if the map entry matches the evicted timestamp
      // (it might have been refreshed by a later duplicate).
      if (this.seen.get(evicted.key) === evicted.ts) {
        this.seen.delete(evicted.key);
      }
    }

    if (this.seen.has(key)) {
      return true; // duplicate
    }

    // Evict oldest if at capacity
    if (this.seen.size >= DEDUP_MAX_SIZE) {
      const oldest = this.queue.shift();
      if (oldest) this.seen.delete(oldest.key);
    }

    this.seen.set(key, now);
    this.queue.push({ key, ts: now });
    return false;
  }
}

// ─── Monitor state ──────────────────────────────────────────────────────────

/** 监控状态 */
interface MonitorState {
  client: BeeimClientInstance;
  running: boolean;
  abortController: AbortController;
  /** In-memory group chat history for silent ingest (per group ID). */
  groupHistories: Map<string, HistoryEntry[]>;
  /** Per-connection message deduplicator. */
  dedup: MessageDeduplicator;
}

/** 监控状态缓存 */
const monitorStates = new Map<string, MonitorState>();

/**
 * 启动 BeeIM 消息监听（多实例版本）
 * accountId 指定要启动的实例（"appKey:accid"），与 monitorStates Map 的键一致。
 */
export async function monitorBeeimProvider(params: {
  cfg: OpenClawConfig;
  /** The derived accountId ("appKey:accid") for this instance. */
  accountId: string;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { cfg, runtime, abortSignal } = params;

  const account = resolveBeeimAccountById({ cfg, accountId: params.accountId });
  console.log(
    `[beeim] monitor init — account resolved: configured=${account.configured}, account=${account.account || "none"}`,
  );
  const nimInstCfg = account.configured ? account.config : undefined;

  if (!nimInstCfg) {
    console.error(`[beeim] instance not configured — accountId: ${params.accountId}`);
    return;
  }

  const creds = resolveBeeimCredentials(nimInstCfg);
  if (!creds) {
    console.error(`[beeim] credentials not configured — accountId: ${params.accountId}`);
    return;
  }
  const monitorKey = `${creds.appKey}:${creds.account}`;

  // 检查是否已有监控在运行
  if (monitorStates.has(monitorKey)) {
    console.log(`[beeim] monitor already running — account: ${creds.account}`);
    throw new Error(`BeeIM monitor already running for ${creds.account}`);
  }

  console.log(`[beeim] monitor starting — account: ${creds.account}`);

  try {
    // 创建客户端（IM 初始化）
    const client = await createBeeimClient(nimInstCfg);

    // Sync P2P policy to the cached client
    const liveP2pPolicy = (nimInstCfg.p2p?.policy as BeeimP2pPolicy) ?? "open";
    const liveP2pAllowFrom = nimInstCfg.p2p?.allowFrom ?? [];
    client.updateP2pPolicy(liveP2pPolicy, liveP2pAllowFrom);

    // IM 登录
    const loginSuccess = await client.login();

    if (!loginSuccess) {
      console.error("[beeim] login failed — monitor not started");
      return;
    }

    console.log(`[beeim] login successful — account: ${creds.account}`);

    // 创建 AbortController 用于停止监控
    const abortController = new AbortController();

    // 保存监控状态
    const groupHistories = new Map<string, HistoryEntry[]>();
    const dedup = new MessageDeduplicator();
    const state: MonitorState = {
      client,
      running: true,
      abortController,
      groupHistories,
      dedup,
    };
    monitorStates.set(monitorKey, state);

    // 注册消息处理回调
    const messageHandler = async (msg: BeeimMessageEvent) => {
      if (!state.running) return;

      // 忽略自己发送的消息
      if (msg.from === creds.account) {
        return;
      }

      // ── Dedup: drop messages already seen in this connection ──
      const msgIdStr = String(msg.msgId ?? msg.clientMsgId ?? "");
      const dedupTarget = String(msg.to ?? msg.from ?? "");
      if (msgIdStr && state.dedup.isDuplicate(msg.sessionType, dedupTarget, msgIdStr)) {
        console.log(
          `[beeim] duplicate message dropped — session: ${msg.sessionType}, msgId: ${msgIdStr}`,
        );
        return;
      }

      // NOTE: "received message" is already logged by client.ts onReceiveMessages;
      // no need to log again here.

      try {
        await handleBeeimMessage({
          cfg,
          accountId: params.accountId,
          runtime,
          message: msg,
          groupHistories,
        });
      } catch (error) {
        const errorMessage = (error as any)?.message ?? String(error);
        console.error(`[beeim] message handling failed — error: ${errorMessage}`);
      }
    };

    client.onMessage(messageHandler);

    // 注册连接状态回调
    client.onConnectionChange((status) => {
      console.log(`[beeim] connection status changed — status: ${status}`);

      if (status === "kickout") {
        console.warn(`[beeim] account kicked out — account: ${creds.account}`);
        stopBeeimMonitorByKey(monitorKey);
      } else if (status === "disconnected") {
        console.warn("[beeim] disconnected — reconnecting");
        // SDK 会自动重连
      }
    });

    console.log(`[beeim] monitor started — account: ${creds.account}`);

    // Keep the returned Promise pending until abort signal fires.
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        console.log("[beeim] abort signal received — stopping monitor");
        stopBeeimMonitorByKey(monitorKey).finally(resolve);
      };

      if (abortSignal?.aborted) {
        onAbort();
        return;
      }

      if (abortSignal) {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      // Also resolve when the internal abortController fires (e.g. kickout)
      abortController.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  } catch (error) {
    const errorMessage = (error as any)?.message ?? String(error);
    console.error(`[beeim] monitor start failed — error: ${errorMessage}`);
    throw error;
  }
}

/**
 * 按 monitorKey ("appKey:account") 停止监控 — 内部使用
 */
async function stopBeeimMonitorByKey(monitorKey: string): Promise<void> {
  const state = monitorStates.get(monitorKey);
  if (!state) {
    console.log(`[beeim] monitor not running — key: ${monitorKey}`);
    return;
  }

  console.log(`[beeim] monitor stopping — key: ${monitorKey}`);

  state.running = false;
  state.abortController.abort();

  try {
    await state.client.logout();
  } catch (error) {
    const errorMessage = (error as any)?.message ?? String(error);
    console.error(`[beeim] logout failed during monitor stop — error: ${errorMessage}`);
  }

  monitorStates.delete(monitorKey);
  console.log(`[beeim] monitor stopped — key: ${monitorKey}`);
}

/**
 * 停止 BeeIM 消息监听（按实例配置）
 */
export async function stopBeeimMonitor(cfg: BeeimInstanceConfig): Promise<void> {
  const creds = resolveBeeimCredentials(cfg);
  if (!creds) {
    console.log("[beeim] monitor stop skipped — missing credentials");
    return;
  }
  await stopBeeimMonitorByKey(`${creds.appKey}:${creds.account}`);
}

/**
 * 检查监控是否在运行
 */
export function isBeeimMonitorRunning(cfg: BeeimInstanceConfig): boolean {
  const creds = resolveBeeimCredentials(cfg);
  if (!creds) return false;
  const monitorKey = `${creds.appKey}:${creds.account}`;
  const state = monitorStates.get(monitorKey);
  return state?.running ?? false;
}

/**
 * 停止所有监控
 */
export async function stopAllBeeimMonitors(): Promise<void> {
  console.log("[beeim] stopping all monitors");

  for (const [key, state] of monitorStates.entries()) {
    state.running = false;
    state.abortController.abort();
    try {
      await state.client.logout();
    } catch (error) {
      const errorMessage = (error as any)?.message ?? String(error);
      console.error(`[beeim] monitor stop failed — account: ${key}, error: ${errorMessage}`);
    }
  }

  monitorStates.clear();
  await clearBeeimClientCache();

  console.log("[beeim] all monitors stopped");
}
