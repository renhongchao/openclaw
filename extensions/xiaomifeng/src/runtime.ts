import type { PluginRuntime } from "openclaw/plugin-sdk";

/**
 * Global runtime environment reference.
 */
let xiaomifengRuntime: PluginRuntime | null = null;

/**
 * Set the XiaoMiFeng runtime environment.
 */
export function setXiaomifengRuntime(runtime: PluginRuntime): void {
  xiaomifengRuntime = runtime;
}

/**
 * Get the XiaoMiFeng runtime environment.
 * Throws if runtime is not set.
 */
export function getXiaomifengRuntime(): PluginRuntime {
  if (!xiaomifengRuntime) {
    throw new Error("XiaoMiFeng runtime not initialized. Call setXiaomifengRuntime first.");
  }
  return xiaomifengRuntime;
}

/**
 * Check if XiaoMiFeng runtime is initialized.
 */
export function isXiaomifengRuntimeInitialized(): boolean {
  return xiaomifengRuntime !== null;
}

/**
 * Clear the XiaoMiFeng runtime reference.
 */
export function clearXiaomifengRuntime(): void {
  xiaomifengRuntime = null;
}
