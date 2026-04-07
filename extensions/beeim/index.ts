import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { beeimPlugin } from "./src/channel.js";
import { setBeeimRuntime } from "./src/runtime.js";

export { beeimPlugin } from "./src/channel.js";
export { setBeeimRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "beeim",
  name: "BeeIM",
  description: "BeeIM (网易小蜜蜂 IM) channel plugin",
  plugin: beeimPlugin,
  setRuntime: setBeeimRuntime,
});
