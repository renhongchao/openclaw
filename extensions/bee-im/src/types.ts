/**
 * BeeIM Channel 类型定义
 */

/** BeeIM 配置 */
export interface BeeIMConfig {
  /** WebSocket 服务器地址 */
  wsUrl?: string;
  /** 用户账号 (passport) */
  passport: string;
  /** 认证 token */
  token: string;
  /** App 标识 */
  app?: string;
  /** 业务模块 */
  business?: string;
  /** 心跳间隔（秒） */
  heartbeatInterval?: number;
  /** 最大重连次数 */
  maxReconnectAttempts?: number;
  /** 重连延迟（毫秒） */
  reconnectDelay?: number;
  /** 消息队列大小 */
  messageQueueSize?: number;
  /** 是否自动 ACK */
  autoAck?: boolean;
}

/** 聊天类型 */
export type ChatType = 1 | 2; // 1=私聊, 2=群聊

/** 消息类型 */
export interface BeeIMRawMessage {
  chatId: string;
  chatType: ChatType;
  senderId: string;
  msgId: number;
  msgType: number;
  content: string;
  sendTime: number;
}

/** 解析后的消息内容 */
export interface ParsedMessageContent {
  text?: string;
  /** 图片消息字段 (msgType=2) */
  url?: string;
  height?: number;
  width?: number;
  [key: string]: unknown;
}

/** 解析后的消息 */
export interface ParsedMessage extends Omit<BeeIMRawMessage, "content"> {
  content: ParsedMessageContent | string;
}

/** 标准化的 IM 消息 */
export interface BeeIMMessage {
  /** Session 标识 (private:xxx 或 group:xxx) */
  sessionId: string;
  /** 聊天类型 */
  chatType: ChatType;
  /** 聊天 ID */
  chatId: string;
  /** 发送者 ID */
  senderId: string;
  /** 消息 ID */
  msgId: number;
  /** 消息类型 */
  msgType: number;
  /** 发送时间戳 */
  sendTime: number;
  /** 所有消息（批量消息时可能多条） */
  messages: ParsedMessage[];
  /** 最后一条消息 */
  lastMessage: ParsedMessage;
  /** 消息数量 */
  count: number;
  /** 原始 JSON 字符串 */
  raw: string;
  /** 接收时间 */
  receivedAt?: number;
}

/** ACK 信息 */
export interface AckInfo {
  chatId: string;
  chatType: ChatType;
  msgId: number;
}

/** 客户端状态 */
export interface ClientStatus {
  isConnected: boolean;
  isAuthenticated: boolean;
  reconnectAttempts: number;
  lastHeartbeat: number | null;
}

/** Channel 状态 */
export interface ChannelStatus {
  isRunning: boolean;
  clientStatus: ClientStatus | null;
  queueSize: number;
  registeredSessions: string[];
}

/** 断开连接信息 */
export interface DisconnectInfo {
  code: number;
  reason: string;
  wasClean?: boolean;
}

/** 重连信息 */
export interface ReconnectInfo {
  attempt: number;
  delay: number;
}

/** 解析错误信息 */
export interface ParseErrorInfo {
  error: Error;
  raw: string;
}

/** Protobuf 消息负载 */
export interface ProtoPayload {
  packId: string;
  app: string;
  business: string;
  command: number;
  version: number;
  timestamp: number;
  /** protobufjs bytes 字段要求 Uint8Array */
  body: Uint8Array;
}

/** 解码后的 Protobuf 消息 */
export interface DecodedProtoMessage {
  packId: string;
  app: string;
  business: string;
  command: number;
  version: number;
  timestamp: number;
  body: Uint8Array;
}

/** OpenClaw Channel 账户配置 */
export interface BeeIMAccountConfig {
  /** 账户名称 */
  name?: string;
  /** 是否启用 */
  enabled?: boolean;
  /** WebSocket 服务器地址 */
  wsUrl?: string;
  /** 用户账号 (passport) */
  passport?: string;
  /** 认证 token */
  token?: string;
  /** App 标识 */
  app?: string;
  /** 业务模块 */
  business?: string;
  /** 心跳间隔（秒） */
  heartbeatInterval?: number;
  /** DM 配置 */
  dm?: {
    /** 安全策略 */
    policy?: "open" | "allowlist";
    /** 允许的发送者列表 */
    allowFrom?: string[];
  };
  /** 群组配置 */
  groups?: Record<string, BeeIMGroupConfig>;
  /** 群组策略 */
  groupPolicy?: "open" | "allowlist";
}

/** 群组配置 */
export interface BeeIMGroupConfig {
  /** 群组名称 */
  name?: string;
  /** 是否启用 */
  enabled?: boolean;
  /** 允许的用户列表 */
  users?: string[];
}

/** OpenClaw 核心配置中的 BeeIM 部分 */
export interface BeeIMCoreConfig {
  channels?: {
    "bee-im"?: BeeIMAccountConfig | Record<string, BeeIMAccountConfig>;
  };
}

/** 解析后的账户 */
export interface ResolvedBeeIMAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  wsUrl: string;
  passport: string;
  token: string;
  app: string;
  business: string;
  config: BeeIMAccountConfig;
}

/** 运行时状态 */
export interface BeeIMRuntimeStatus {
  accountId: string;
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
  lastProbeAt?: number | null;
  wsUrl?: string | null;
}

/** 探测结果 */
export interface BeeIMProbeResult {
  ok: boolean;
  error?: string;
  elapsedMs: number;
  userId?: string;
}

/** 账户快照 */
export interface BeeIMAccountSnapshot {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  wsUrl: string | null;
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
  probe?: BeeIMProbeResult;
  lastProbeAt?: number | null;
}
