/**
 * BeeIM 账户解析
 */

import type { BeeIMAccountConfig, BeeIMCoreConfig, ResolvedBeeIMAccount } from "./types.js";

const DEFAULT_WS_URL = "ws://10.195.240.187:13102/sub";
const DEFAULT_APP = "beeClaw";
const DEFAULT_BUSINESS = "common";
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * 获取所有账户 ID 列表
 */
export function listBeeIMAccountIds(cfg: BeeIMCoreConfig): string[] {
  const beeImConfig = cfg.channels?.["bee-im"];
  if (!beeImConfig) {
    return [];
  }

  // 检查是否是单账户配置（直接包含 passport/token 等字段）
  if (typeof beeImConfig === "object" && ("passport" in beeImConfig || "token" in beeImConfig)) {
    return [DEFAULT_ACCOUNT_ID];
  }

  // 多账户配置
  return Object.keys(beeImConfig as Record<string, BeeIMAccountConfig>);
}

/**
 * 获取默认账户 ID
 */
export function resolveDefaultBeeIMAccountId(cfg: BeeIMCoreConfig): string {
  const accountIds = listBeeIMAccountIds(cfg);
  return accountIds.length > 0 ? accountIds[0] : DEFAULT_ACCOUNT_ID;
}

/**
 * 获取账户原始配置
 */
export function resolveBeeIMAccountConfig(params: {
  cfg: BeeIMCoreConfig;
  accountId: string;
}): BeeIMAccountConfig | undefined {
  const { cfg, accountId } = params;
  const beeImConfig = cfg.channels?.["bee-im"];

  if (!beeImConfig) {
    return undefined;
  }

  // 单账户配置
  if (typeof beeImConfig === "object" && ("passport" in beeImConfig || "token" in beeImConfig)) {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return beeImConfig as BeeIMAccountConfig;
    }
    return undefined;
  }

  // 多账户配置
  return (beeImConfig as Record<string, BeeIMAccountConfig>)[accountId];
}

/**
 * 解析账户配置
 */
export function resolveBeeIMAccount(params: {
  cfg: BeeIMCoreConfig;
  accountId: string;
}): ResolvedBeeIMAccount {
  const { cfg, accountId } = params;
  const accountConfig = resolveBeeIMAccountConfig(params);

  const passport = accountConfig?.passport || process.env.BEE_IM_PASSPORT || "";
  const token = accountConfig?.token || process.env.BEE_IM_TOKEN || "";
  const wsUrl = accountConfig?.wsUrl || process.env.BEE_IM_WS_URL || DEFAULT_WS_URL;
  const app = accountConfig?.app || process.env.BEE_IM_APP || DEFAULT_APP;
  const business = accountConfig?.business || process.env.BEE_IM_BUSINESS || DEFAULT_BUSINESS;

  const configured = Boolean(passport && token);
  const enabled = accountConfig?.enabled !== false;

  return {
    accountId,
    name: accountConfig?.name || accountId,
    enabled,
    configured,
    wsUrl,
    passport,
    token,
    app,
    business,
    config: accountConfig || {},
  };
}

/**
 * 规范化允许列表条目
 */
export function normalizeBeeIMAllowEntry(entry: string): string {
  return entry.trim().toLowerCase();
}

/**
 * 规范化允许列表
 */
export function normalizeBeeIMAllowList(allowFrom: string[] | undefined): string[] {
  if (!allowFrom || !Array.isArray(allowFrom)) return [];
  return allowFrom.map(normalizeBeeIMAllowEntry).filter(Boolean);
}
