/**
 * XiaoMiFeng Types - node-nim SDK version.
 */

import type { z } from "zod";
import type { XiaomifengConfigSchema, XiaomifengInstanceConfigSchema } from "./config-schema.js";

/**
 * XiaoMiFeng instance config type (single instance).
 */
export type XiaomifengInstanceConfig = z.infer<typeof XiaomifengInstanceConfigSchema>;

/**
 * XiaoMiFeng channel config type (flat, single account).
 */
export type XiaomifengConfig = z.infer<typeof XiaomifengConfigSchema>;

/**
 * XiaoMiFeng message type.
 */
export type XiaomifengMessageType =
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
 * XiaoMiFeng session type.
 */
export type XiaomifengSessionType = "p2p" | "team" | "superTeam";

/**
 * XiaoMiFeng message event (received from SDK callback).
 */
export interface XiaomifengMessageEvent {
  /** Message ID. */
  msgId: string;
  /** Client message ID. */
  clientMsgId: string;
  /** Session type. */
  sessionType: XiaomifengSessionType;
  /** Sender account ID. */
  from: string;
  /** Recipient account ID / team ID. */
  to: string;
  /** Message type. */
  type: XiaomifengMessageType;
  /** Text content. */
  text?: string;
  /** Message timestamp (ms). */
  time: number;
  /** Attachment info (image/file/audio/video). */
  attach?: XiaomifengAttachment;
  /** Extension fields. */
  ext?: Record<string, unknown>;
  /** Force-push account list (used to detect @ mentions in groups). */
  forcePushAccountIds?: string[];
  /** Sender nickname (from SDK message, may be empty). */
  fromNick?: string;
  /** Raw message object. */
  rawMsg?: unknown;
}

/**
 * XiaoMiFeng attachment info.
 */
export interface XiaomifengAttachment {
  /** Filename. */
  name?: string;
  /** File size. */
  size?: number;
  /** File URL. */
  url?: string;
  /** File extension. */
  ext?: string;
  /** File MD5. */
  md5?: string;
  /** Image width. */
  w?: number;
  /** Image height. */
  h?: number;
  /** Audio/video duration (seconds). */
  dur?: number;
  /** Geo title. */
  title?: string;
  /** Latitude. */
  lat?: number;
  /** Longitude. */
  lng?: number;
}

/**
 * XiaoMiFeng message context (business layer).
 */
export interface XiaomifengMessageContext {
  /** Unique ID. */
  id: string;
  /** Session ID. */
  sessionId: string;
  /** Session type. */
  sessionType: XiaomifengSessionType;
  /** Sender ID. */
  senderId: string;
  /** Sender display name. */
  senderName?: string;
  /** Message type. */
  type: XiaomifengMessageType;
  /** Text content. */
  text: string;
  /** Timestamp. */
  timestamp: number;
  /** Media attachments. */
  attachments?: XiaomifengMediaInfo[];
  /** True for direct messages. */
  isDm: boolean;
  /** Raw event. */
  rawEvent: XiaomifengMessageEvent;
}

/**
 * XiaoMiFeng media info.
 */
export interface XiaomifengMediaInfo {
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
 * XiaoMiFeng send result.
 */
export interface XiaomifengSendResult {
  success: boolean;
  msgId?: string;
  clientMsgId?: string;
  error?: string;
  errorCode?: number;
  baseMessage?: unknown;
}

/**
 * XiaoMiFeng probe result.
 */
export interface XiaomifengProbeResult {
  connected: boolean;
  account?: string;
  error?: string;
  loginState?: string;
}

/**
 * XiaoMiFeng P2P policy.
 */
export type XiaomifengP2pPolicy = "open" | "allowlist" | "disabled";

/**
 * Resolved XiaoMiFeng account configuration.
 */
export interface ResolvedXiaomifengAccount {
  id: string;
  accountId: string;
  appKey: string;
  account: string;
  token: string;
  enabled: boolean;
  configured: boolean;
  p2pPolicy: XiaomifengP2pPolicy;
  allowFrom: Array<string | number>;
  teamPolicy: XiaomifengTeamPolicy;
  teamIds: Array<string | number>;
  config: XiaomifengInstanceConfig;
}

/**
 * XiaoMiFeng client instance interface.
 */
export interface XiaomifengClientInstance {
  /** Initialized. */
  initialized: boolean;
  /** Logged in. */
  loggedIn: boolean;
  /** Current account. */
  account: string;
  /** Login. */
  login(): Promise<boolean>;
  /** Logout. */
  logout(): Promise<void>;
  /** Send text message. */
  sendText(
    to: string,
    text: string,
    sessionType?: XiaomifengSessionType,
  ): Promise<XiaomifengSendResult>;
  /** Reply with text (quote + @ sender in groups). */
  replyText(
    to: string,
    text: string,
    originalMsg: unknown,
    forcePushAccountIds: string[],
    sessionType?: XiaomifengSessionType,
  ): Promise<XiaomifengSendResult>;
  /** Send a streaming message. */
  sendStreamMessage(params: {
    to: string;
    sessionType?: XiaomifengSessionType;
    baseMessage?: unknown;
    streamChunkParams: {
      text: string;
      index?: number;
      finish?: number;
    };
  }): Promise<XiaomifengSendResult>;
  /** Send image message. */
  sendImage(
    to: string,
    filePath: string,
    sessionType?: XiaomifengSessionType,
  ): Promise<XiaomifengSendResult>;
  /** Send file message. */
  sendFile(
    to: string,
    filePath: string,
    sessionType?: XiaomifengSessionType,
  ): Promise<XiaomifengSendResult>;
  /** Send audio message. */
  sendAudio(
    to: string,
    filePath: string,
    duration: number,
    sessionType?: XiaomifengSessionType,
  ): Promise<XiaomifengSendResult>;
  /** Send video message. */
  sendVideo(
    to: string,
    filePath: string,
    duration: number,
    width: number,
    height: number,
    sessionType?: XiaomifengSessionType,
  ): Promise<XiaomifengSendResult>;
  /** Register message callback. */
  onMessage(callback: (msg: XiaomifengMessageEvent) => void): void;
  /** Remove message callback. */
  offMessage(callback: (msg: XiaomifengMessageEvent) => void): void;
  /** Register connection state callback. */
  onConnectionChange(callback: (state: string) => void): void;
  /** Update P2P auto-accept policy (called on config reload). */
  updateP2pPolicy(policy: XiaomifengP2pPolicy, allowFrom: Array<string | number>): void;
  /** Underlying NIM SDK instance (for internal reuse). */
  nativeNim: unknown;
  /** Destroy client. */
  destroy(): Promise<void>;
}

/**
 * XiaoMiFeng team policy (for team/superTeam messages)
 */
export type XiaomifengTeamPolicy = "open" | "allowlist" | "disabled";
