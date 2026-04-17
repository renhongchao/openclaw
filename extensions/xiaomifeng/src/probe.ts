/**
 * XiaoMiFeng Probe - connection probe module.
 */

import { resolveXiaomifengCredentials } from "./accounts.js";
import { createXiaomifengClient, getCachedXiaomifengClient } from "./client.js";
import type { XiaomifengInstanceConfig, XiaomifengProbeResult } from "./types.js";

/**
 * Probe XiaoMiFeng connection status (cached client).
 */
export async function probeXiaomifeng(
  cfg: XiaomifengInstanceConfig,
): Promise<XiaomifengProbeResult> {
  try {
    const creds = resolveXiaomifengCredentials(cfg);
    const client = getCachedXiaomifengClient(cfg);

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
 * Probe XiaoMiFeng connection status (attempt connection).
 */
export async function probeXiaomifengWithConnect(
  cfg: XiaomifengInstanceConfig,
): Promise<XiaomifengProbeResult> {
  try {
    const creds = resolveXiaomifengCredentials(cfg);

    // Attempt to create client and login.
    const client = await createXiaomifengClient(cfg);
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
 * Quick check for configuration completeness.
 */
export function isXiaomifengConfigComplete(cfg: XiaomifengInstanceConfig): boolean {
  try {
    const creds = resolveXiaomifengCredentials(cfg);
    return !!(creds?.appKey && creds?.account && creds?.token);
  } catch {
    return false;
  }
}
