/**
 * BeeIM Probe - 连接探测模块
 */

import { resolveBeeimCredentials } from "./accounts.js";
import { createBeeimClient, getCachedBeeimClient } from "./client.js";
import type { BeeimInstanceConfig, BeeimProbeResult } from "./types.js";

/**
 * 探测 BeeIM 连接状态（使用缓存的客户端）
 */
export async function probeBeeim(cfg: BeeimInstanceConfig): Promise<BeeimProbeResult> {
  try {
    const creds = resolveBeeimCredentials(cfg);
    const client = getCachedBeeimClient(cfg);

    if (client && client.loggedIn) {
      return {
        connected: true,
        account: creds?.account,
        loginState: "connected",
      };
    }

    return {
      connected: false,
      account: creds?.account,
      loginState: "not_connected",
    };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 探测 BeeIM 连接状态（尝试建立连接）
 */
export async function probeBeeimWithConnect(cfg: BeeimInstanceConfig): Promise<BeeimProbeResult> {
  try {
    const creds = resolveBeeimCredentials(cfg);

    // 尝试创建客户端并登录
    const client = await createBeeimClient(cfg);
    const loginSuccess = await client.login();

    if (loginSuccess) {
      return {
        connected: true,
        account: creds?.account,
        loginState: "connected",
      };
    } else {
      return {
        connected: false,
        account: creds?.account,
        error: "Login failed",
        loginState: "login_failed",
      };
    }
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : String(error),
      loginState: "error",
    };
  }
}

/**
 * 快速检查配置是否完整
 */
export function isBeeimConfigComplete(cfg: BeeimInstanceConfig): boolean {
  try {
    const creds = resolveBeeimCredentials(cfg);
    return !!(creds?.appKey && creds?.account && creds?.token);
  } catch {
    return false;
  }
}
