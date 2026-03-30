/**
 * BeeIM Channel 插件入口
 * OpenClaw Channel 插件
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { beeIMPlugin } from "./channel.js";
import { setBeeIMRuntime } from "./runtime.js";

export { beeIMPlugin } from "./channel.js";
export { setBeeIMRuntime, getBeeIMRuntime } from "./runtime.js";
export { BeeIMClient } from "./client.js";
export * from "./types.js";

export default defineChannelPluginEntry({
  id: "bee-im",
  name: "BeeIM",
  description: "小蜜蜂 IM WebSocket 消息通道插件",
  plugin: beeIMPlugin,
  setRuntime: setBeeIMRuntime,
});
