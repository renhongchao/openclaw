/**
 * XiaoMiFeng Monitor - message monitoring module.
 */

import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { resolveXiaomifengCredentials, resolveXiaomifengAccountById } from "./accounts.js";
import { handleXiaomifengMessage } from "./bot.js";
import { createXiaomifengClient, clearXiaomifengClientCache } from "./client.js";
import type {
  XiaomifengInstanceConfig,
  XiaomifengClientInstance,
  XiaomifengMessageEvent,
  XiaomifengP2pPolicy,
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
    while (this.queue.length > 0 && now - this.queue[0].ts > DEDUP_TTL_MS) {
      const evicted = this.queue.shift()!;
      if (this.seen.get(evicted.key) === evicted.ts) {
        this.seen.delete(evicted.key);
      }
    }

    if (this.seen.has(key)) {
      return true;
    }

    if (this.seen.size >= DEDUP_MAX_SIZE) {
      const oldest = this.queue.shift();
      if (oldest) {
        this.seen.delete(oldest.key);
      }
    }

    this.seen.set(key, now);
    this.queue.push({ key, ts: now });
    return false;
  }
}

// ─── Monitor state ──────────────────────────────────────────────────────────

interface MonitorState {
  client: XiaomifengClientInstance;
  running: boolean;
  abortController: AbortController;
  groupHistories: Map<string, HistoryEntry[]>;
  dedup: MessageDeduplicator;
}

const monitorStates = new Map<string, MonitorState>();

/**
 * Start XiaoMiFeng monitoring (multi-instance).
 */
export async function monitorXiaomifengProvider(params: {
  cfg: OpenClawConfig;
  accountId: string;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { cfg, runtime, abortSignal } = params;

  const account = resolveXiaomifengAccountById({ cfg, accountId: params.accountId });
  const instCfg = account.configured ? account.config : undefined;

  if (!instCfg) {
    console.error(`[xiaomifeng] instance not configured — accountId: ${params.accountId}`);
    return;
  }

  const creds = resolveXiaomifengCredentials(instCfg);
  if (!creds) {
    console.error(`[xiaomifeng] credentials not configured — accountId: ${params.accountId}`);
    return;
  }
  const monitorKey = `${creds.appKey}:${creds.account}`;

  if (monitorStates.has(monitorKey)) {
    throw new Error(`XiaoMiFeng monitor already running for ${creds.account}`);
  }

  try {
    const client = await createXiaomifengClient(instCfg);

    const liveP2pPolicy = (instCfg.p2p?.policy as XiaomifengP2pPolicy) ?? "open";
    const liveP2pAllowFrom = instCfg.p2p?.allowFrom ?? [];
    client.updateP2pPolicy(liveP2pPolicy, liveP2pAllowFrom);

    const loginSuccess = await client.login();
    if (!loginSuccess) {
      console.error("[xiaomifeng] login failed — monitor not started");
      return;
    }

    const abortController = new AbortController();
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

    const messageHandler = async (msg: XiaomifengMessageEvent) => {
      if (!state.running) {
        return;
      }
      if (msg.from === creds.account) {
        return;
      }

      const msgIdStr = msg.msgId || msg.clientMsgId || "";
      const dedupTarget = msg.to || msg.from || "";
      if (msgIdStr && state.dedup.isDuplicate(msg.sessionType, dedupTarget, msgIdStr)) {
        return;
      }

      try {
        await handleXiaomifengMessage({
          cfg,
          accountId: params.accountId,
          runtime,
          message: msg,
          groupHistories,
        });
      } catch (error) {
        console.error(
          `[xiaomifeng] message handling failed — ${(error as Error)?.message ?? error}`,
        );
      }
    };

    client.onMessage(messageHandler);

    client.onConnectionChange((status) => {
      if (status === "kickout") {
        console.warn(`[xiaomifeng] account kicked out — account: ${creds.account}`);
        void stopXiaomifengMonitorByKey(monitorKey);
      } else if (status === "disconnected") {
        console.warn("[xiaomifeng] disconnected — SDK auto-reconnecting");
      }
    });

    // Keep the returned Promise pending until abort signal fires.
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        void stopXiaomifengMonitorByKey(monitorKey).finally(resolve);
      };

      if (abortSignal?.aborted) {
        onAbort();
        return;
      }

      if (abortSignal) {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      abortController.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } catch (error) {
    console.error(`[xiaomifeng] monitor start failed — ${(error as Error)?.message ?? error}`);
    throw error;
  }
}

/**
 * Stop monitor by key — internal use.
 */
async function stopXiaomifengMonitorByKey(monitorKey: string): Promise<void> {
  const state = monitorStates.get(monitorKey);
  if (!state) {
    return;
  }

  state.running = false;
  state.abortController.abort();

  try {
    await state.client.logout();
  } catch (error) {
    console.error(`[xiaomifeng] logout failed — ${(error as Error)?.message ?? error}`);
  }

  monitorStates.delete(monitorKey);
}

/**
 * Stop monitoring by instance config.
 */
export async function stopXiaomifengMonitor(cfg: XiaomifengInstanceConfig): Promise<void> {
  const creds = resolveXiaomifengCredentials(cfg);
  if (!creds) {
    return;
  }
  await stopXiaomifengMonitorByKey(`${creds.appKey}:${creds.account}`);
}

/**
 * Check whether monitor is running.
 */
export function isXiaomifengMonitorRunning(cfg: XiaomifengInstanceConfig): boolean {
  const creds = resolveXiaomifengCredentials(cfg);
  if (!creds) {
    return false;
  }
  return monitorStates.get(`${creds.appKey}:${creds.account}`)?.running ?? false;
}

/**
 * Stop all monitors.
 */
export async function stopAllXiaomifengMonitors(): Promise<void> {
  for (const [key, state] of monitorStates.entries()) {
    state.running = false;
    state.abortController.abort();
    try {
      await state.client.logout();
    } catch (error) {
      console.error(
        `[xiaomifeng] monitor stop failed — key: ${key}, ${(error as Error)?.message ?? error}`,
      );
    }
  }

  monitorStates.clear();
  await clearXiaomifengClientCache();
}
