/**
 * BeeIM 认证 + 持续监听脚本
 *
 * 用法：
 *   node test-auth.mjs [passport] [token] [wsUrl]
 *
 * 或设置环境变量：
 *   BEE_IM_PASSPORT=xxx BEE_IM_TOKEN=yyy node test-auth.mjs
 *
 * 优先级：命令行参数 > 环境变量 > 默认值
 *
 * 认证成功后将持续保持连接，实时打印收到的消息。
 * 按 Ctrl+C 退出。
 */

import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// --------------------------------------------------------------------------
// 配置读取
// --------------------------------------------------------------------------

const [, , argPassport, argToken, argWsUrl] = process.argv;

const PASSPORT = argPassport || process.env.BEE_IM_PASSPORT || "";
const TOKEN = argToken || process.env.BEE_IM_TOKEN || "";
const WS_URL = argWsUrl || process.env.BEE_IM_WS_URL || "ws://10.195.240.187:13102/sub";
const APP = process.env.BEE_IM_APP || "beeClaw";
const BUSINESS = process.env.BEE_IM_BUSINESS || "common";

if (!PASSPORT || !TOKEN) {
  console.error("❌ 缺少必要参数：passport 和 token");
  console.error("");
  console.error("用法：");
  console.error("  node test-auth.mjs <passport> <token> [wsUrl]");
  console.error("");
  console.error("或设置环境变量：");
  console.error("  BEE_IM_PASSPORT=your@email.com BEE_IM_TOKEN=your-token node test-auth.mjs");
  process.exit(1);
}

// --------------------------------------------------------------------------
// 依赖加载（运行时按需 require）
// --------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
let WebSocket, protobuf, uuidv4;

try {
  WebSocket = (await import("ws")).default;
  protobuf = (await import("protobufjs")).default;
  const uuid = await import("uuid");
  uuidv4 = uuid.v4;
} catch (e) {
  console.error("❌ 缺少依赖，请先安装：");
  console.error("   cd extensions/bee-im && npm install");
  console.error("");
  console.error("原始错误：", e.message);
  process.exit(1);
}

// --------------------------------------------------------------------------
// Protobuf 协议加载
// --------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = join(__dirname, "protocol.proto");

let WSMessage;
try {
  const root = await protobuf.load(PROTO_PATH);
  WSMessage = root.lookupType("goim.protocol.Proto");
  console.log("✅ Protobuf 协议加载成功");
} catch (e) {
  console.error("❌ Protobuf 协议加载失败：", e.message);
  console.error("   请确认 protocol.proto 文件存在于：", PROTO_PATH);
  process.exit(1);
}

// --------------------------------------------------------------------------
// 工具函数
// --------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");
// protobufjs bytes 字段必须是 Uint8Array，不能是 number[]
const toBytes = (s) => enc.encode(s);
const toString = (b) => dec.decode(b instanceof Uint8Array ? b : new Uint8Array(b));

function buildProto(command, bodyStr) {
  const payload = {
    packId: uuidv4(),
    app: APP,
    command,
    version: 1,
    business: BUSINESS,
    timestamp: Date.now(),
    body: bodyStr ? toBytes(bodyStr) : new Uint8Array(0),
  };
  const msg = WSMessage.create(payload);
  return WSMessage.encode(msg).finish();
}

// --------------------------------------------------------------------------
// 命令码常量
// --------------------------------------------------------------------------
const CMD = {
  AUTH_REQUEST: 10010,
  AUTH_SUCCESS: 10,
  AUTH_FAILED: 30,
  HEARTBEAT_REQUEST: 10020,
  HEARTBEAT_RESPONSE: 20,
  MESSAGE_SINGLE: 60,
  MESSAGE_BATCH: 760,
  ACK_SINGLE: 10061,
  ACK_BATCH: 70761,
};

const AUTH_TIMEOUT_MS = 15000;

// --------------------------------------------------------------------------
// 消息计数
// --------------------------------------------------------------------------
let msgCount = 0;

// --------------------------------------------------------------------------
// 工具：格式化时间戳
// --------------------------------------------------------------------------
function fmtTime(ts) {
  return new Date(ts || Date.now()).toLocaleString("zh-CN", { hour12: false });
}

// --------------------------------------------------------------------------
// 工具：格式化消息内容
// --------------------------------------------------------------------------
function fmtContent(content) {
  if (typeof content === "string") {
    try {
      return JSON.stringify(JSON.parse(content), null, 4);
    } catch {
      return content;
    }
  }
  return JSON.stringify(content, null, 4);
}

// --------------------------------------------------------------------------
// 打印分隔线
// --------------------------------------------------------------------------
function printSep(char = "─", width = 60) {
  console.log(char.repeat(width));
}

// --------------------------------------------------------------------------
// 验证 + 持续监听逻辑
// --------------------------------------------------------------------------

console.log("");
console.log("=== BeeIM 认证 + 持续监听脚本 ===");
console.log(`  passport : ${PASSPORT}`);
console.log(`  token    : ${TOKEN.slice(0, 6)}${"*".repeat(Math.max(0, TOKEN.length - 6))}`);
console.log(`  wsUrl    : ${WS_URL}`);
console.log(`  app      : ${APP}`);
console.log(`  business : ${BUSINESS}`);
console.log("");

const startTime = Date.now();

async function run() {
  return new Promise((resolve, reject) => {
    console.log("🔌 正在连接 WebSocket...");
    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";

    let authenticated = false;
    let heartbeatTimer = null;

    // 认证超时保险（仅在认证阶段生效）
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        ws.close();
        reject(new Error(`认证超时（${AUTH_TIMEOUT_MS / 1000}s 内未收到服务端响应）`));
      }
    }, AUTH_TIMEOUT_MS);

    // ---------- 发送认证 ----------
    ws.on("open", () => {
      console.log("✅ WebSocket 连接成功");
      console.log("🔑 正在发送认证请求...");
      const authBody = JSON.stringify({ clientId: PASSPORT, token: TOKEN });
      try {
        ws.send(buildProto(CMD.AUTH_REQUEST, authBody));
      } catch (e) {
        clearTimeout(authTimer);
        ws.close();
        reject(new Error(`发送认证包失败：${e.message}`));
      }
    });

    // ---------- 启动心跳 ----------
    function startHeartbeat(intervalMs) {
      heartbeatTimer = setInterval(() => {
        try {
          ws.send(buildProto(CMD.HEARTBEAT_REQUEST, ""));
          process.stdout.write(`💓 [${fmtTime()}] 心跳已发送\r`);
        } catch (e) {
          console.error("\n[心跳] 发送失败：", e.message);
        }
      }, intervalMs);
    }

    // ---------- 发送 ACK ----------
    function sendAck(decoded, bodyText) {
      try {
        const messages = JSON.parse(bodyText);
        if (!Array.isArray(messages) || messages.length === 0) return;
        const lastMsg = messages[messages.length - 1];
        const ackCommand = decoded.command === CMD.MESSAGE_BATCH ? CMD.ACK_BATCH : CMD.ACK_SINGLE;
        const ackBody = JSON.stringify({
          passport: PASSPORT,
          ack: [
            {
              chatId: lastMsg.chatId,
              chatType: 100,
              msgIds: [lastMsg.msgId],
            },
          ],
        });
        ws.send(buildProto(ackCommand, ackBody));
        console.log(`   ↩  ACK 已发送 (msgId=${lastMsg.msgId})`);
      } catch (e) {
        console.error("   ↩  ACK 发送失败：", e.message);
      }
    }

    // ---------- 消息处理 ----------
    ws.on("message", (data) => {
      try {
        const buf = new Uint8Array(data);
        const decoded = WSMessage.decode(buf);
        const body = toString(decoded.body);

        switch (decoded.command) {
          // ── 认证成功 ──
          case CMD.AUTH_SUCCESS: {
            clearTimeout(authTimer);
            let resp = {};
            try {
              resp = JSON.parse(body);
            } catch {
              /**/
            }

            if (resp.code === 200 || resp.code === 0) {
              authenticated = true;
              const elapsed = Date.now() - startTime;
              console.log("");
              printSep("═");
              console.log(`✅ 认证成功！耗时 ${elapsed}ms`);
              console.log(`   服务端响应：${JSON.stringify(resp)}`);
              printSep("═");
              console.log("");
              console.log("👂 开始监听消息（按 Ctrl+C 退出）...");
              console.log("");
              startHeartbeat((parseInt(process.env.BEE_IM_HEARTBEAT_INTERVAL) || 300) * 1000);
            } else {
              clearTimeout(authTimer);
              ws.close();
              reject(new Error(`服务端拒绝认证：code=${resp.code}, message=${resp.message}`));
            }
            break;
          }

          // ── 认证失败 ──
          case CMD.AUTH_FAILED: {
            clearTimeout(authTimer);
            ws.close();
            reject(new Error(`Token 被服务端拒绝：${body}`));
            break;
          }

          // ── 心跳响应 ──
          case CMD.HEARTBEAT_RESPONSE: {
            // 覆盖上一行心跳提示，换行后清空
            process.stdout.write(`\n`);
            console.log(`💓 [${fmtTime()}] 心跳响应已收到`);
            break;
          }

          // ── 单条/批量消息 ──
          case CMD.MESSAGE_SINGLE:
          case CMD.MESSAGE_BATCH: {
            msgCount++;
            printSep();
            console.log(`📩 [${fmtTime()}] 收到消息 #${msgCount}  (command=${decoded.command})`);

            try {
              const messages = JSON.parse(body);
              if (Array.isArray(messages)) {
                messages.forEach((msg, idx) => {
                  const chatLabel = msg.chatType === 1 ? "私聊" : "群聊";
                  console.log(`   [${idx + 1}/${messages.length}]`);
                  console.log(`     chatType : ${chatLabel} (${msg.chatType})`);
                  console.log(`     chatId   : ${msg.chatId}`);
                  console.log(`     senderId : ${msg.senderId}`);
                  console.log(`     msgId    : ${msg.msgId}`);
                  console.log(`     msgType  : ${msg.msgType}`);
                  console.log(`     sendTime : ${fmtTime(msg.sendTime)} (${msg.sendTime})`);
                  console.log(`     content  :`);
                  console.log(
                    fmtContent(msg.content)
                      .split("\n")
                      .map((l) => "       " + l)
                      .join("\n"),
                  );
                });
              } else {
                console.log("   body (raw):", body);
              }
            } catch {
              console.log("   body (raw):", body);
            }

            // 发送 ACK
            sendAck(decoded, body);
            printSep();
            console.log("");
            break;
          }

          // ── 未知命令 ──
          default: {
            console.log(`⚠️  [${fmtTime()}] 未知命令 command=${decoded.command}`);
            if (body) console.log("   body:", body.slice(0, 200));
            break;
          }
        }
      } catch (e) {
        console.error(`\n❌ 解析消息失败：${e.message}`);
      }
    });

    // ---------- 错误 ----------
    ws.on("error", (err) => {
      clearTimeout(authTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (!authenticated) {
        reject(new Error(`WebSocket 错误：${err.message}`));
      } else {
        console.error(`\n❌ [${fmtTime()}] WebSocket 错误：${err.message}`);
      }
    });

    // ---------- 关闭 ----------
    ws.on("close", (code, reason) => {
      clearTimeout(authTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      const msg = `WebSocket 已断开：code=${code}, reason=${reason || "(无)"}`;
      if (!authenticated) {
        reject(new Error(msg));
      } else {
        console.log(`\n🔌 [${fmtTime()}] ${msg}`);
        console.log(`   本次共接收消息 ${msgCount} 条`);
        resolve();
      }
    });

    // ---------- Ctrl+C 优雅退出 ----------
    process.on("SIGINT", () => {
      console.log(`\n\n🛑 [${fmtTime()}] 收到退出信号，正在断开连接...`);
      ws.close();
    });
  });
}

// --------------------------------------------------------------------------
// 运行
// --------------------------------------------------------------------------

try {
  await run();
  process.exit(0);
} catch (err) {
  const elapsed = Date.now() - startTime;
  console.log("");
  console.error(`❌ 运行失败！耗时 ${elapsed}ms`);
  console.error("   原因：", err.message);
  console.error("");
  console.error("排查建议：");
  console.error("  1. 检查 passport/token 是否正确");
  console.error("  2. 检查 wsUrl 是否可达（防火墙/VPN）");
  console.error("  3. 检查 protocol.proto 与服务端协议是否匹配");
  process.exit(1);
}
