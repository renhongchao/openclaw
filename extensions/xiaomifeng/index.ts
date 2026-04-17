import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { xiaomifengPlugin } from "./src/channel.js";
import { setXiaomifengRuntime } from "./src/runtime.js";

export { xiaomifengPlugin } from "./src/channel.js";
export { setXiaomifengRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "xiaomifeng",
  name: "XiaoMiFeng",
  description: "XiaoMiFeng (小蜜蜂 IM) channel plugin",
  plugin: xiaomifengPlugin,
  setRuntime: setXiaomifengRuntime,
});
