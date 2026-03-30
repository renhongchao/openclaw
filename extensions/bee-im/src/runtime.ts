/**
 * BeeIM 运行时状态管理
 */

import type { BeeIMRuntimeStatus } from "./types.js";

/** 运行时状态存储 */
const runtimeStore = new Map<string, BeeIMRuntimeStatus>();

/**
 * 获取账户运行时状态
 */
export function getBeeIMRuntimeStatus(accountId: string): BeeIMRuntimeStatus | undefined {
  return runtimeStore.get(accountId);
}

/**
 * 设置账户运行时状态
 */
export function setBeeIMRuntimeStatus(
  accountId: string,
  status: Partial<BeeIMRuntimeStatus>,
): void {
  const existing = runtimeStore.get(accountId);
  runtimeStore.set(accountId, {
    accountId,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    ...existing,
    ...status,
  });
}

/**
 * 清除账户运行时状态
 */
export function clearBeeIMRuntimeStatus(accountId: string): void {
  runtimeStore.delete(accountId);
}

/**
 * 获取所有运行时状态
 */
export function getAllBeeIMRuntimeStatus(): Map<string, BeeIMRuntimeStatus> {
  return new Map(runtimeStore);
}

/** 全局 BeeIM 运行时接口 */
export interface BeeIMRuntime {
  channel: {
    text: {
      chunkMarkdownText?: (text: string, limit: number) => string[];
    };
  };
}

let beeIMRuntime: BeeIMRuntime | null = null;

/**
 * 设置全局运行时
 */
export function setBeeIMRuntime(runtime: BeeIMRuntime): void {
  beeIMRuntime = runtime;
}

/**
 * 获取全局运行时
 */
export function getBeeIMRuntime(): BeeIMRuntime {
  if (!beeIMRuntime) {
    // 返回默认实现
    return {
      channel: {
        text: {
          chunkMarkdownText: (text: string, limit: number) => {
            // 简单的文本分块实现
            const chunks: string[] = [];
            let remaining = text;
            while (remaining.length > 0) {
              chunks.push(remaining.slice(0, limit));
              remaining = remaining.slice(limit);
            }
            return chunks.length > 0 ? chunks : [text];
          },
        },
      },
    };
  }
  return beeIMRuntime;
}
