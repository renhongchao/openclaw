/**
 * BeeIM Types - node-nim SDK 版本
 */

import type { z } from "zod";
import type { BeeimConfigSchema, BeeimInstanceConfigSchema } from "./config-schema.js";

/**
 * BeeIM 实例配置类型（单实例）
 */
export type BeeimInstanceConfig = z.infer<typeof BeeimInstanceConfigSchema>;

/**
 * BeeIM 配置类型（实例数组）
 */
export type BeeimConfig = z.infer<typeof BeeimConfigSchema>;

/**
 * BeeIM 消息类型
 */
export type BeeimMessageType =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "file"
  | "geo"
  | "notification"
  | "custom"
  | "tip"
  | "robot"
  | "unknown";

/**
 * BeeIM 会话类型
 */
export type BeeimSessionType = "p2p" | "team" | "superTeam";

/**
 * BeeIM 消息事件（从 SDK 回调接收）
 */
export interface BeeimMessageEvent {
  /** 消息 ID */
  msgId: string;
  /** 消息客户端 ID */
  clientMsgId: string;
  /** 会话类型 */
  sessionType: BeeimSessionType;
  /** 发送者账号 */
  from: string;
  /** 接收者账号/群ID */
  to: string;
  /** 消息类型 */
  type: BeeimMessageType;
  /** 文本内容 */
  text?: string;
  /** 消息时间戳 (毫秒) */
  time: number;
  /** 附件信息 (图片/文件/音视频等) */
  attach?: BeeimAttachment;
  /** 扩展字段 */
  ext?: Record<string, unknown>;
  /** 强制推送目标账号列表 (群消息中用于判断是否 @了当前账号) */
  forcePushAccountIds?: string[];
  /** 发送者昵称（从 SDK 消息对象中提取，可能为空） */
  fromNick?: string;
  /** 原始消息对象 */
  rawMsg?: unknown;
}

/**
 * BeeIM 附件信息
 */
export interface BeeimAttachment {
  /** 文件名 */
  name?: string;
  /** 文件大小 */
  size?: number;
  /** 文件 URL */
  url?: string;
  /** 文件扩展名 */
  ext?: string;
  /** 文件 MD5 */
  md5?: string;
  /** 图片宽度 */
  w?: number;
  /** 图片高度 */
  h?: number;
  /** 音视频时长 (秒) */
  dur?: number;
  /** 地理位置标题 */
  title?: string;
  /** 纬度 */
  lat?: number;
  /** 经度 */
  lng?: number;
}

/**
 * BeeIM 消息上下文（业务层使用）
 */
export interface BeeimMessageContext {
  /** 唯一标识 */
  id: string;
  /** 会话 ID */
  sessionId: string;
  /** 会话类型 */
  sessionType: BeeimSessionType;
  /** 发送者 ID */
  senderId: string;
  /** 发送者名称 */
  senderName?: string;
  /** 消息类型 */
  type: BeeimMessageType;
  /** 文本内容 */
  text: string;
  /** 时间戳 */
  timestamp: number;
  /** 媒体附件 */
  attachments?: BeeimMediaInfo[];
  /** 是否为私聊 */
  isDm: boolean;
  /** 原始事件 */
  rawEvent: BeeimMessageEvent;
}

/**
 * BeeIM 媒体信息
 */
export interface BeeimMediaInfo {
  type: "image" | "file" | "audio" | "video";
  url: string;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  localPath?: string;
}

/**
 * BeeIM 发送结果
 */
export interface BeeimSendResult {
  success: boolean;
  msgId?: string;
  clientMsgId?: string;
  error?: string;
  errorCode?: number;
  baseMessage?: any;
}

/**
 * BeeIM 探测结果
 */
export interface BeeimProbeResult {
  connected: boolean;
  account?: string;
  error?: string;
  loginState?: string;
}

/**
 * BeeIM P2P 策略
 */
export type BeeimP2pPolicy = "open" | "allowlist" | "disabled";

/**
 * 解析后的 BeeIM 账户配置
 */
export interface ResolvedBeeimAccount {
  id: string;
  accountId: string;
  appKey: string;
  account: string;
  token: string;
  enabled: boolean;
  configured: boolean;
  p2pPolicy: BeeimP2pPolicy;
  allowFrom: Array<string | number>;
  teamPolicy: BeeimTeamPolicy;
  teamIds: Array<string | number>;
  config: BeeimInstanceConfig;
}

/**
 * BeeIM 客户端实例接口
 */
export interface BeeimClientInstance {
  /** 是否已初始化 */
  initialized: boolean;
  /** 是否已登录 */
  loggedIn: boolean;
  /** 当前账号 */
  account: string;
  /** 登录 */
  login(): Promise<boolean>;
  /** 登出 */
  logout(): Promise<void>;
  /** 发送文本消息 */
  sendText(to: string, text: string, sessionType?: BeeimSessionType): Promise<BeeimSendResult>;
  /** 回复文本消息（群组中引用原消息并 @发送者） */
  replyText(
    to: string,
    text: string,
    originalMsg: unknown,
    forcePushAccountIds: string[],
    sessionType?: BeeimSessionType,
  ): Promise<BeeimSendResult>;
  /** 发送流式消息 */
  sendStreamMessage(params: {
    to: string;
    sessionType?: BeeimSessionType;
    baseMessage?: any;
    streamChunkParams: {
      text: string;
      index?: number;
      finish?: number;
    };
  }): Promise<BeeimSendResult>;
  /** 发送图片消息 */
  sendImage(to: string, filePath: string, sessionType?: BeeimSessionType): Promise<BeeimSendResult>;
  /** 发送文件消息 */
  sendFile(to: string, filePath: string, sessionType?: BeeimSessionType): Promise<BeeimSendResult>;
  /** 发送音频消息 */
  sendAudio(
    to: string,
    filePath: string,
    duration: number,
    sessionType?: BeeimSessionType,
  ): Promise<BeeimSendResult>;
  /** 发送视频消息 */
  sendVideo(
    to: string,
    filePath: string,
    duration: number,
    width: number,
    height: number,
    sessionType?: BeeimSessionType,
  ): Promise<BeeimSendResult>;
  /** 注册消息回调 */
  onMessage(callback: (msg: BeeimMessageEvent) => void): void;
  /** 移除消息回调 */
  offMessage(callback: (msg: BeeimMessageEvent) => void): void;
  /** 注册连接状态回调 */
  onConnectionChange(callback: (state: string) => void): void;
  /** 更新 P2P 好友申请自动同意策略（config reload 时调用） */
  updateP2pPolicy(policy: BeeimP2pPolicy, allowFrom: Array<string | number>): void;
  /** 底层 NIM SDK 实例（用于内部复用） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nativeNim: any;
  /** 销毁客户端 */
  destroy(): Promise<void>;
}

/**
 * BeeIM team policy (for team/superTeam messages)
 */
export type BeeimTeamPolicy = "open" | "allowlist" | "disabled";
