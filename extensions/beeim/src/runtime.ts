import type { PluginRuntime } from "openclaw/plugin-sdk";

/**
 * Global runtime environment reference.
 */
let beeimRuntime: PluginRuntime | null = null;

/**
 * Set the BeeIM runtime environment.
 */
export function setBeeimRuntime(runtime: PluginRuntime): void {
  beeimRuntime = runtime;
}

/**
 * Get the BeeIM runtime environment.
 * Throws if runtime is not set.
 */
export function getBeeimRuntime(): PluginRuntime {
  if (!beeimRuntime) {
    throw new Error("BeeIM runtime not initialized. Call setBeeimRuntime first.");
  }
  return beeimRuntime;
}

/**
 * Check if BeeIM runtime is initialized.
 */
export function isBeeimRuntimeInitialized(): boolean {
  return beeimRuntime !== null;
}

/**
 * Clear the BeeIM runtime reference.
 */
export function clearBeeimRuntime(): void {
  beeimRuntime = null;
}
