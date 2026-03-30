/**
 * BeeIM WebSocket 客户端
 * 负责连接服务器、接收消息、发送 ACK 和发送消息
 */

import { EventEmitter } from "events";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import protobuf from "protobufjs";
import { v4 as uuidv4 } from "uuid";
import WebSocket from "ws";
import type {
  BeeIMConfig,
  BeeIMMessage,
  BeeIMRawMessage,
  ParsedMessage,
  ParsedMessageContent,
  AckInfo,
  ClientStatus,
  DisconnectInfo,
  ReconnectInfo,
  ParseErrorInfo,
  ProtoPayload,
  DecodedProtoMessage,
  ChatType,
} from "./types.js";

// Protocol command codes
const COMMAND = {
  AUTH_REQUEST: 10010,
  AUTH_SUCCESS: 10,
  AUTH_FAILED: 30,
  HEARTBEAT_REQUEST: 10020,
  HEARTBEAT_RESPONSE: 20,
  MESSAGE_SINGLE: 60,
  MESSAGE_BATCH: 760,
  ACK_SINGLE: 10061,
  ACK_BATCH: 70761,
} as const;

// Default config values
const DEFAULT_WS_URL = "ws://10.195.240.187:13102/sub";
const DEFAULT_APP = "beeClaw";
const DEFAULT_BUSINESS = "common";
const DEFAULT_HEARTBEAT_INTERVAL = 300; // seconds
const DEFAULT_MAX_RECONNECT = 5; // 最多重连 5 次，避免无限重试
const DEFAULT_RECONNECT_BASE_DELAY = 5000; // 初始重连间隔 5s
const DEFAULT_RECONNECT_MAX_DELAY = 120000; // 最大重连间隔 2min（指数退避上限）
const AUTH_TIMEOUT_MS = 15000; // 认证超时 15s

// Module-level protocol cache
let protoRoot: protobuf.Root | null = null;
let WSMessage: protobuf.Type | null = null;

/**
 * 加载 Protobuf 协议
 */
async function loadProtocol(): Promise<void> {
  if (protoRoot && WSMessage) return;

  const currentDir = dirname(fileURLToPath(import.meta.url));
  // Try dist directory first (when running compiled), then parent (dev)
  let protoPath = join(currentDir, "..", "protocol.proto");
  try {
    protoRoot = await protobuf.load(protoPath);
  } catch {
    protoPath = join(currentDir, "protocol.proto");
    protoRoot = await protobuf.load(protoPath);
  }
  WSMessage = protoRoot.lookupType("goim.protocol.Proto");
}

/**
 * 字符串转字节数组 (UTF-8)
 * protobufjs bytes 字段要求 Uint8Array，不接受 number[]
 */
function stringToBytes(str: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(str);
}

/**
 * 字节数组/Buffer 转字符串 (UTF-8)
 * Node.js 的 ws 库返回 Buffer，protobufjs 返回 Uint8Array，需要兼容处理
 */
function bytesToString(arr: Uint8Array | Buffer | ArrayBuffer | number[] | unknown): string {
  if (!arr) return "";
  if (Buffer.isBuffer(arr)) {
    return arr.toString("utf-8");
  }
  if (arr instanceof Uint8Array) {
    return new TextDecoder("utf-8").decode(arr);
  }
  if (arr instanceof ArrayBuffer) {
    return new TextDecoder("utf-8").decode(new Uint8Array(arr));
  }
  if (Array.isArray(arr)) {
    // protobufjs 有时返回 number[]
    return new TextDecoder("utf-8").decode(new Uint8Array(arr as number[]));
  }
  // 最后兜底：尝试转 Buffer
  try {
    return Buffer.from(arr as Uint8Array).toString("utf-8");
  } catch {
    console.warn("[BeeIM] bytesToString: unknown type", typeof arr, arr?.constructor?.name);
    return String(arr);
  }
}

/** BeeIM 客户端事件类型 */
export interface BeeIMClientEvents {
  connected: () => void;
  disconnected: (info: DisconnectInfo) => void;
  reconnecting: (info: ReconnectInfo) => void;
  reconnect_failed: () => void;
  auth_failed: (reason: string | object) => void;
  heartbeat: () => void;
  message: (message: BeeIMMessage) => void;
  error: (error: Error) => void;
  parse_error: (info: ParseErrorInfo) => void;
  unknown_command: (info: { command: number; body: string }) => void;
}

/** 发送文本消息的参数 */
export interface SendTextMessageParams {
  /** 接收者 passport（私聊）或群组 ID（群聊） */
  to: string;
  /** 消息内容 */
  text: string;
  /** 消息类型，默认 1（文本） */
  msgType?: number;
}

/** 发送消息的响应 */
export interface SendMessageResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * BeeIM WebSocket 客户端
 */
export class BeeIMClient extends EventEmitter {
  private config: Required<
    Pick<
      BeeIMConfig,
      | "wsUrl"
      | "passport"
      | "token"
      | "app"
      | "business"
      | "heartbeatInterval"
      | "maxReconnectAttempts"
      | "reconnectDelay"
    >
  >;

  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatTimeoutTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private authTimeoutTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private isConnected = false;
  private isAuthenticated = false;
  private lastHeartbeat: number | null = null;
  private shouldReconnect = true;
  /** 认证失败不重连（token 无效重连也没用） */
  private authFailed = false;
  /** 当前连接的序号，用于防止旧连接的回调干扰新连接 */
  private connectionSeq = 0;
  /** 最近一次认证成功的时间戳，用于防抖：避免认证成功后立刻断开导致的极速重连循环 */
  private lastAuthSuccessAt = 0;
  /** 认证成功后的最短存活时间（ms），低于此时间断开视为服务端踢连，重连前额外等待 */
  private static readonly MIN_LIVE_MS = 3000;

  private authResolve: (() => void) | null = null;
  private authReject: ((error: Error) => void) | null = null;

  constructor(config: BeeIMConfig) {
    super();

    if (!config.passport || !config.token) {
      throw new Error("BeeIMClient requires passport and token");
    }

    this.config = {
      wsUrl: config.wsUrl || DEFAULT_WS_URL,
      passport: config.passport,
      token: config.token,
      app: config.app || DEFAULT_APP,
      business: config.business || DEFAULT_BUSINESS,
      heartbeatInterval: (config.heartbeatInterval || DEFAULT_HEARTBEAT_INTERVAL) * 1000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT,
      reconnectDelay: config.reconnectDelay || DEFAULT_RECONNECT_BASE_DELAY,
    };
  }

  /**
   * 连接到服务器
   */
  async connect(): Promise<void> {
    await loadProtocol();

    // 关闭并清理旧连接，防止旧 ws 的 onclose 触发额外重连
    this.closeCurrentWs();

    // 递增序号，使旧连接的所有回调失效
    const seq = ++this.connectionSeq;

    return new Promise((resolve, reject) => {
      try {
        console.log(
          `[BeeIM] Connecting to ${this.config.wsUrl}... (attempt ${this.reconnectAttempts + 1}/${this.config.maxReconnectAttempts})`,
        );

        const ws = new WebSocket(this.config.wsUrl);
        this.ws = ws;
        ws.binaryType = "arraybuffer";
        this.shouldReconnect = true;

        ws.onopen = () => {
          if (seq !== this.connectionSeq) return; // 旧连接，忽略
          console.log("[BeeIM] WebSocket connected, authenticating...");
          this.sendAuth();
        };

        ws.onmessage = (evt) => {
          if (seq !== this.connectionSeq) return; // 旧连接，忽略
          const data = evt.data;
          // Node.js ws 返回 Buffer，浏览器返回 ArrayBuffer，需要兼容处理
          if (Buffer.isBuffer(data)) {
            this.handleMessage(data);
          } else if (data instanceof ArrayBuffer) {
            this.handleMessage(Buffer.from(data));
          } else if (Array.isArray(data)) {
            this.handleMessage(Buffer.concat(data as Buffer[]));
          } else {
            console.warn("[BeeIM] Unexpected message data type:", typeof data);
          }
        };

        ws.onclose = (event) => {
          if (seq !== this.connectionSeq) return; // 旧连接的 close，忽略
          console.log(`[BeeIM] WebSocket closed: code=${event.code}, reason=${event.reason}`);
          this.isConnected = false;
          this.isAuthenticated = false;
          this.stopHeartbeat();
          this.cancelAuthTimeout();
          this.emit("disconnected", {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          });

          // 认证失败不重连，主动断开不重连
          if (this.shouldReconnect && !this.authFailed) {
            this.scheduleReconnect();
          }
        };

        ws.onerror = (error) => {
          if (seq !== this.connectionSeq) return; // 旧连接，忽略
          console.error("[BeeIM] WebSocket error:", error.message);
          this.emit("error", new Error(error.message));
        };

        // 保存认证回调
        this.authResolve = resolve;
        this.authReject = reject;

        // 认证超时（保存 handle 以便取消）
        this.cancelAuthTimeout();
        this.authTimeoutTimer = setTimeout(() => {
          if (seq !== this.connectionSeq) return; // 旧连接超时，忽略
          if (!this.isAuthenticated && this.authReject) {
            console.error(`[BeeIM] Authentication timeout after ${AUTH_TIMEOUT_MS}ms`);
            this.authReject(new Error("Authentication timeout"));
            this.cleanupAuthCallbacks();
          }
        }, AUTH_TIMEOUT_MS);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 关闭当前 WebSocket（不触发重连逻辑，仅内部使用）
   * 通过递增 connectionSeq 使旧 ws 的所有回调静默失效
   */
  private closeCurrentWs(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.cancelAuthTimeout();
  }

  /**
   * 取消认证超时计时器
   */
  private cancelAuthTimeout(): void {
    if (this.authTimeoutTimer) {
      clearTimeout(this.authTimeoutTimer);
      this.authTimeoutTimer = null;
    }
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.cancelAuthTimeout();
    // 递增序号，使所有在途回调失效
    this.connectionSeq++;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    this.isAuthenticated = false;
  }

  /**
   * 发送文本消息（公开 API）
   *
   * @param params - 消息参数
   * @returns 发送结果
   */
  async sendTextMessage(params: SendTextMessageParams): Promise<SendMessageResult> {
    if (!this.isAuthenticated) {
      return { ok: false, error: "Not authenticated" };
    }

    try {
      const clientMsgId = uuidv4();
      const now = Date.now();

      // 消息格式与服务端收到的消息格式保持一致
      const body = JSON.stringify({
        chatId: params.to,
        chatType: 1,
        clientMsgId,
        content: JSON.stringify({ text: params.text }),
        msgId: 0,
        msgType: params.msgType ?? 1,
        sendTime: now,
        senderId: this.config.passport,
      });

      const payload: ProtoPayload = {
        packId: uuidv4(),
        app: this.config.app,
        command: 10060,
        version: 1,
        business: this.config.business,
        timestamp: now,
        body: stringToBytes(body),
      };

      this.sendRaw(payload);
      console.log(`[BeeIM] Message sent to ${params.to}`);
      return { ok: true, messageId: clientMsgId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[BeeIM] Failed to send message:", message);
      return { ok: false, error: message };
    }
  }

  /**
   * 发送认证请求
   */
  private sendAuth(): void {
    const body = JSON.stringify({
      clientId: this.config.passport,
      token: this.config.token,
    });

    const payload: ProtoPayload = {
      packId: uuidv4(),
      app: this.config.app,
      command: COMMAND.AUTH_REQUEST,
      version: 1,
      business: this.config.business,
      timestamp: Date.now(),
      body: stringToBytes(body),
    };

    this.sendRaw(payload);
    console.log("[BeeIM] Authentication sent");
  }

  /**
   * 发送心跳，并启动超时计时器。
   * 若超时内未收到 HEARTBEAT_RESPONSE，则主动关闭连接触发重连。
   * 超时时间 = heartbeatInterval（与发送间隔相同），防止僵尸连接。
   */
  private sendHeartbeat(): void {
    const payload: ProtoPayload = {
      packId: uuidv4(),
      app: this.config.app,
      command: COMMAND.HEARTBEAT_REQUEST,
      version: 1,
      business: this.config.business,
      timestamp: Date.now(),
      body: new Uint8Array(0),
    };

    this.sendRaw(payload);
    this.lastHeartbeat = Date.now();
    console.log("[BeeIM] Heartbeat sent");

    // 启动心跳响应超时检测（防止僵尸连接）
    // 超时时间取 heartbeatInterval（最大 60s），给服务端充足时间回包
    this.cancelHeartbeatTimeout();
    const timeoutMs = Math.min(this.config.heartbeatInterval, 60000);
    this.heartbeatTimeoutTimer = setTimeout(() => {
      if (!this.isAuthenticated) return; // 已断开，无需处理
      console.warn(
        `[BeeIM] ⚠️ Heartbeat timeout (${timeoutMs}ms) — no response from server, forcing reconnect`,
      );
      // 强制关闭 ws 触发 onclose → scheduleReconnect
      try {
        this.ws?.close(4001, "heartbeat timeout");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
  }

  /**
   * 取消心跳响应超时计时器
   */
  private cancelHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  /**
   * 发送 ACK 确认
   */
  private sendAck(
    app: string,
    business: string,
    command: number,
    bodyText: string,
  ): AckInfo | null {
    const ackCommand = command === COMMAND.MESSAGE_BATCH ? COMMAND.ACK_BATCH : COMMAND.ACK_SINGLE;

    try {
      const parsed = JSON.parse(bodyText);
      const messages: BeeIMRawMessage[] = Array.isArray(parsed) ? parsed : [parsed];
      const lastMsg = messages[messages.length - 1];

      const ackBody = JSON.stringify({
        passport: this.config.passport,
        ack: [
          {
            chatId: lastMsg.chatId,
            chatType: 100, // ACK 的 chatType 固定为 100
            msgIds: [lastMsg.msgId],
          },
        ],
      });

      const payload: ProtoPayload = {
        packId: uuidv4(),
        app: app,
        command: ackCommand,
        version: 1,
        business: business,
        timestamp: Date.now(),
        body: stringToBytes(ackBody),
      };

      this.sendRaw(payload);
      console.log(`[BeeIM] ACK sent for msgId=${lastMsg.msgId}`);

      return {
        chatId: lastMsg.chatId,
        chatType: lastMsg.chatType,
        msgId: lastMsg.msgId,
      };
    } catch (error) {
      console.error("[BeeIM] Failed to send ACK:", error);
      return null;
    }
  }

  /**
   * 发送底层 Protobuf 消息到服务器
   */
  private sendRaw(payload: ProtoPayload): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }

    if (!WSMessage) {
      throw new Error("Protocol not loaded");
    }

    const errMsg = WSMessage.verify(payload);
    if (errMsg) {
      throw new Error(`Protocol verification failed: ${errMsg}`);
    }

    const message = WSMessage.create(payload);
    const buffer = WSMessage.encode(message).finish();
    this.ws.send(buffer);
  }

  /**
   * 处理接收到的消息
   */
  private handleMessage(data: Buffer): void {
    try {
      if (!WSMessage) {
        throw new Error("Protocol not loaded");
      }

      const decoded = WSMessage.decode(data) as unknown as DecodedProtoMessage;
      const bodyText = bytesToString(decoded.body);

      console.log(`[BeeIM] Received command ${decoded.command}`);

      switch (decoded.command) {
        case COMMAND.AUTH_SUCCESS: {
          try {
            const loginResp = JSON.parse(bodyText);
            if (loginResp.code === 200 || loginResp.code === 0) {
              console.log("[BeeIM] Authentication successful");
              this.isConnected = true;
              this.isAuthenticated = true;
              this.reconnectAttempts = 0; // 认证成功，重置重连计数
              this.authFailed = false;
              this.cancelAuthTimeout(); // 取消认证超时，防止超时回调重复触发
              this.lastAuthSuccessAt = Date.now();
              this.startHeartbeat();
              this.emit("connected");
              if (this.authResolve) {
                this.authResolve();
                this.cleanupAuthCallbacks();
              }
            } else {
              console.error(
                `[BeeIM] Authentication rejected by server: code=${loginResp.code}, msg=${loginResp.message}`,
              );
              // 服务端主动拒绝，不重连
              this.authFailed = true;
              this.emit("auth_failed", loginResp);
              if (this.authReject) {
                this.authReject(
                  new Error(
                    `Authentication failed: ${loginResp.message} (code: ${loginResp.code})`,
                  ),
                );
                this.cleanupAuthCallbacks();
              }
              this.disconnect();
            }
          } catch (e) {
            console.error("[BeeIM] Failed to parse login response:", e);
            this.emit("auth_failed", bodyText);
            if (this.authReject) {
              this.authReject(new Error(`Invalid login response: ${bodyText}`));
              this.cleanupAuthCallbacks();
            }
          }
          break;
        }

        case COMMAND.HEARTBEAT_RESPONSE:
          console.log("[BeeIM] Heartbeat acknowledged");
          // 收到响应，取消超时检测（僵尸连接检测）
          this.cancelHeartbeatTimeout();
          this.emit("heartbeat");
          break;

        case COMMAND.AUTH_FAILED:
          console.error("[BeeIM] Authentication failed (token rejected):", bodyText);
          // token 被服务端拒绝，标记为认证失败，不再重连
          this.authFailed = true;
          this.emit("auth_failed", bodyText);
          if (this.authReject) {
            this.authReject(new Error(`Authentication failed: ${bodyText}`));
            this.cleanupAuthCallbacks();
          }
          this.disconnect();
          break;

        case COMMAND.MESSAGE_SINGLE:
        case COMMAND.MESSAGE_BATCH: {
          console.log("[BeeIM] Message received");
          const ackInfo = this.sendAck(decoded.app, decoded.business, decoded.command, bodyText);
          this.parseAndEmitMessage(bodyText, ackInfo);
          break;
        }

        case COMMAND.ACK_SINGLE:
        case COMMAND.ACK_BATCH:
          // ACK 响应，服务端确认收到，静默忽略
          break;

        default:
          console.log(`[BeeIM] Unknown command: ${decoded.command}`);
          this.emit("unknown_command", { command: decoded.command, body: bodyText });
      }
    } catch (error) {
      console.error("[BeeIM] Failed to handle message:", error);
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * 解析消息体并触发事件
   */
  private parseAndEmitMessage(bodyText: string, ackInfo: AckInfo | null): void {
    try {
      const parsed = JSON.parse(bodyText);

      // 服务端可能返回单个对象或数组，统一转为数组
      const messages: BeeIMRawMessage[] = Array.isArray(parsed) ? parsed : [parsed];

      if (messages.length === 0) {
        console.warn("[BeeIM] Empty message array");
        return;
      }

      console.log(
        `[BeeIM] parseAndEmitMessage: count=${messages.length}, msgId=${messages[messages.length - 1]?.msgId}`,
      );

      const lastMsg = messages[messages.length - 1];
      const sessionId = this.generateSessionId(lastMsg.chatType, lastMsg.chatId);

      const parsedMessages: ParsedMessage[] = messages.map((msg) => ({
        ...msg,
        content: this.parseContent(msg.content),
      }));

      const imMessage: BeeIMMessage = {
        sessionId,
        chatType: lastMsg.chatType,
        chatId: lastMsg.chatId,
        senderId: lastMsg.senderId,
        msgId: lastMsg.msgId,
        msgType: lastMsg.msgType,
        sendTime: lastMsg.sendTime,
        messages: parsedMessages,
        lastMessage: parsedMessages[parsedMessages.length - 1],
        count: messages.length,
        raw: bodyText,
      };

      console.log(`[BeeIM] Emitting message: sessionId=${sessionId}, msgId=${lastMsg.msgId}`);
      this.emit("message", imMessage);
    } catch (error) {
      console.error("[BeeIM] Failed to parse message:", error);
      this.emit("parse_error", {
        error: error instanceof Error ? error : new Error(String(error)),
        raw: bodyText,
      });
    }
  }

  /**
   * 生成 Session ID
   */
  private generateSessionId(chatType: ChatType, chatId: string): string {
    const typeMap: Record<ChatType, string> = {
      1: "private",
      2: "group",
    };
    const typePrefix = typeMap[chatType] || "unknown";
    return `${typePrefix}:${chatId}`;
  }

  /**
   * 解析消息内容
   */
  private parseContent(content: string): ParsedMessageContent | string {
    if (typeof content === "string") {
      try {
        return JSON.parse(content) as ParsedMessageContent;
      } catch {
        return content;
      }
    }
    return content;
  }

  /**
   * 启动心跳定时器
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    console.log(`[BeeIM] Starting heartbeat interval: ${this.config.heartbeatInterval}ms`);
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.heartbeatInterval);
  }

  /**
   * 停止心跳定时器，同时取消待处理的超时检测
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.cancelHeartbeatTimeout();
  }

  /**
   * 清除重连定时器
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * 安排重连 —— 指数退避策略
   *
   * 间隔: baseDelay * 2^(attempt-1)，上限 maxDelay
   * 示例（baseDelay=5s, max=5次）:
   *   第1次: 5s, 第2次: 10s, 第3次: 20s, 第4次: 40s, 第5次: 80s → 放弃
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error(
        `[BeeIM] Max reconnect attempts (${this.config.maxReconnectAttempts}) reached, giving up`,
      );
      this.emit("reconnect_failed");
      return;
    }

    this.reconnectAttempts++;

    // 指数退避：baseDelay * 2^(attempt-1)，上限 DEFAULT_RECONNECT_MAX_DELAY
    const exponentialDelay = this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    let delay = Math.min(exponentialDelay, DEFAULT_RECONNECT_MAX_DELAY);

    // 防抖：如果认证成功后极短时间内断开（服务端踢连），
    // 强制等待至少 MIN_LIVE_MS，避免极速循环刷日志
    if (this.lastAuthSuccessAt > 0) {
      const lived = Date.now() - this.lastAuthSuccessAt;
      if (lived < BeeIMClient.MIN_LIVE_MS) {
        const extra = BeeIMClient.MIN_LIVE_MS - lived;
        delay = Math.max(delay, extra);
        console.warn(
          `[BeeIM] Connection lived only ${lived}ms after auth (server kicked?), adding ${extra}ms debounce`,
        );
      }
    }

    console.log(
      `[BeeIM] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`,
    );
    this.emit("reconnecting", { attempt: this.reconnectAttempts, delay });

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        console.error(`[BeeIM] Reconnect attempt ${this.reconnectAttempts} failed:`, error);
        // connect() 内部失败时 onclose 不一定触发，手动继续调度
        if (this.shouldReconnect && !this.authFailed) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  /**
   * 清理认证回调
   */
  private cleanupAuthCallbacks(): void {
    this.authResolve = null;
    this.authReject = null;
  }

  /**
   * 获取客户端状态
   */
  getStatus(): ClientStatus {
    return {
      isConnected: this.isConnected,
      isAuthenticated: this.isAuthenticated,
      reconnectAttempts: this.reconnectAttempts,
      lastHeartbeat: this.lastHeartbeat,
    };
  }

  /**
   * 是否已认证
   */
  get authenticated(): boolean {
    return this.isAuthenticated;
  }
}
