import { type OpenClawConfig, type RuntimeEnv } from "openclaw/plugin-sdk";
import {
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  type HistoryEntry,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
import {
  isXiaomifengP2pAllowed,
  isXiaomifengTeamAllowed,
  resolveXiaomifengCredentials,
} from "./accounts.js";
import { getCachedXiaomifengClient } from "./client.js";
import {
  isCustomMessage,
  parseCustomMessage,
  extractCustomMessageText,
  downloadImageToLocal,
  downloadFileToLocal,
} from "./custom-message.js";
import {
  buildXiaomifengMediaPayload,
  inferMediaPlaceholder,
  sendImageXiaomifeng,
  sendFileXiaomifeng,
  sendAudioXiaomifeng,
  sendVideoXiaomifeng,
  inferMessageType,
} from "./media.js";
import { resolveUserNick, resolveTeamName, buildConversationLabel } from "./name-resolver.js";
import { getXiaomifengRuntime } from "./runtime.js";
import { sendStreamMessageXiaomifeng, sendMessageViaHttpApi } from "./send.js";
import type {
  XiaomifengP2pPolicy,
  XiaomifengTeamPolicy,
  XiaomifengMessageContext,
  XiaomifengMessageEvent,
  XiaomifengSessionType,
} from "./types.js";

interface XiaomifengDeliverPayload {
  mediaUrls?: string[];
  mediaUrl?: string;
  text?: string;
}

interface XiaomifengDispatchResult {
  queuedFinal?: boolean;
  counts?: {
    block?: number;
    final?: number;
  };
}

interface XiaomifengReplyRuntime {
  dispatchReplyWithBufferedBlockDispatcher(args: {
    ctx: unknown;
    cfg: OpenClawConfig;
    dispatcherOptions: {
      deliver: (payload: unknown, info?: { kind: string }) => Promise<void>;
      humanDelay: { mode: "off" };
      onIdle: () => void;
      onError: (err: unknown, info: { kind: string }) => void;
      onSkip: (_payload: unknown, info: { kind: string; reason: string }) => void;
    };
  }): Promise<unknown>;
}

/**
 * Extract text content from a XiaoMiFeng message.
 * For custom messages (type=100), delegates to parseCustomMessage which reads
 * rawMsg.attachment.raw → envelope.content → { text }.
 *
 * When a pre-parsed custom message result is available, pass it as
 * `preParsedCustom` to avoid calling parseCustomMessage() again.
 */
function extractMessageContent(
  message: XiaomifengMessageEvent,
  preParsedCustom?: ReturnType<typeof parseCustomMessage>,
): string {
  if (isCustomMessage(message.type as string | number) || (message.type as unknown) === 100) {
    const parsed = preParsedCustom ?? parseCustomMessage(message);
    if (parsed) {
      return extractCustomMessageText(parsed);
    }
    return "";
  }

  if (message.type === "text" && message.text) {
    return message.text;
  }

  if (message.type === "geo" && message.attach) {
    const geo = message.attach;
    return `[位置] ${geo.title ?? ""} (${geo.lat}, ${geo.lng})`;
  }

  if (["image", "file", "audio", "video"].includes(message.type)) {
    const placeholder = inferMediaPlaceholder(message.type);
    // Do not embed the remote CDN URL in the body text; the media pipeline
    // provides the downloaded local path via MediaPath/MediaUrl instead.
    return placeholder;
  }

  return message.text || "";
}

/**
 * Parse a XiaoMiFeng message event into a message context.
 */
export function parseXiaomifengMessageEvent(
  message: XiaomifengMessageEvent,
  preParsedCustom?: ReturnType<typeof parseCustomMessage>,
): XiaomifengMessageContext {
  const isDirectMessage = message.sessionType === "p2p";
  const sessionCore = isDirectMessage ? `p2p-${message.from}` : `team-${message.to}`;
  const sessionId = `xiaomifeng:${sessionCore}`;

  return {
    id: message.msgId || message.clientMsgId,
    sessionId,
    sessionType: message.sessionType,
    senderId: message.from,
    type: message.type,
    text: extractMessageContent(message, preParsedCustom),
    timestamp: message.time,
    isDm: isDirectMessage,
    rawEvent: message,
  };
}

export function resolveXiaomifengInboundTargets(params: {
  isTeam: boolean;
  messageTo: string;
  effectiveSenderId: string;
  httpChatId?: string;
}) {
  const replyTarget = params.isTeam ? params.messageTo : params.effectiveSenderId;

  return {
    replyTarget,
    xiaomifengTo: params.isTeam ? `team:${params.messageTo}` : `user:${params.effectiveSenderId}`,
    httpReplyChatId: params.httpChatId,
  };
}

/**
 * Handle an incoming XiaoMiFeng message.
 * Supports P2P (DM) and team (group) messages.
 * Includes support for custom message type (100) with Xiaomifeng format.
 * Downloads images locally before sending to Agent.
 */
export async function handleXiaomifengMessage(params: {
  cfg: OpenClawConfig;
  /** The derived accountId ("appKey:accid") for the receiving instance. */
  accountId: string;
  message: XiaomifengMessageEvent;
  runtime?: RuntimeEnv;
  /** Shared in-memory group history map (maintained per monitor connection). */
  groupHistories?: Map<string, HistoryEntry[]>;
}): Promise<void> {
  const { cfg, accountId, message, runtime, groupHistories } = params;
  const { resolveXiaomifengAccountById } = await import("./accounts.js");
  const account = resolveXiaomifengAccountById({ cfg, accountId });
  const instCfg = account.configured ? account.config : undefined;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const apiBase = instCfg?.advanced?.apiBase;
  const xiaomifengCreds = instCfg ? resolveXiaomifengCredentials(instCfg) : undefined;
  const botAccount = xiaomifengCreds?.account ?? "";

  const isP2P = message.sessionType === "p2p";
  const isTeam = message.sessionType === "team" || message.sessionType === "superTeam";

  if (!isP2P && !isTeam) {
    log(`[xiaomifeng] ignoring message — session: ${message.sessionType}`);
    return;
  }

  log(
    `[xiaomifeng] received message — sender: ${message.from}, type: ${message.type}, session: ${message.sessionType}, target: ${message.to}, msgId: ${message.msgId}, time: ${message.time}`,
  );

  // For team messages, only process when the bot is @-mentioned.
  //   a) Normal NIM messages: check forcePushAccountIds for bot accid.
  //   b) Custom messages (type=100): check atUsers passports against configured botPassport.
  // Non-mentioned messages are silently ingested into group history for context.
  const historyKey = isTeam ? `team-${message.to}` : "";
  const historyLimit = DEFAULT_GROUP_HISTORY_LIMIT;
  let botMentioned = false;

  // Parse custom message once up-front so every downstream consumer reuses
  // the same result (avoids duplicate console logging from parseCustomMessage).
  const isCustomMsg =
    isCustomMessage(message.type as string | number) || (message.type as unknown) === 100;
  const customMsgParsed = isCustomMsg ? parseCustomMessage(message) : null;

  // ── Self-message loop guard ──
  // When the bot replies via the HTTP API (from: "youdaoClaw"), the message is relayed
  // back through the NIM SDK as a custom message. The NIM-level `from` is a
  // relay accid (e.g. 101031 / 1652200012), so the monitor.ts self-check
  // (msg.from === creds.account) does not catch it. Detect the loop by
  // comparing the envelope senderId against the configured botPassport.
  if (isCustomMsg && customMsgParsed?.senderId) {
    const botPassport = instCfg?.botPassport?.toLowerCase();
    if (botPassport && customMsgParsed.senderId.toLowerCase() === botPassport) {
      log(
        `[xiaomifeng] self-message loop detected — envelope senderId matches botPassport: ${customMsgParsed.senderId}`,
      );
      return;
    }
  }

  if (isTeam) {
    if (!isCustomMsg) {
      const forcePushIds = message.forcePushAccountIds ?? [];
      botMentioned = forcePushIds.includes(botAccount);
    } else {
      const botPassport = instCfg?.botPassport?.toLowerCase();
      if (botPassport) {
        botMentioned = customMsgParsed?.atPassports?.includes(botPassport) ?? false;
      } else {
        // No botPassport configured — cannot detect @-mention for custom
        // messages. Default to rejected (same as non-mentioned) so that
        // bot-originated messages routed back through the SDK do not create
        // a self-reply loop. Operators should configure botPassport to
        // enable @-mention gating for custom messages.
        botMentioned = false;
        log(
          `[xiaomifeng] team custom message rejected — reason: no botPassport configured, cannot verify @-mention`,
        );
      }
    }

    if (!botMentioned) {
      // Silent ingest: store message for group context without triggering a reply.
      const ctx = parseXiaomifengMessageEvent(message, customMsgParsed);
      if (groupHistories) {
        recordPendingHistoryEntryIfEnabled({
          historyMap: groupHistories,
          historyKey,
          limit: historyLimit,
          entry: {
            sender: message.fromNick || ctx.senderId,
            body: ctx.text,
            timestamp: ctx.timestamp,
            messageId: ctx.id,
          },
        });
      }
      log(
        `[xiaomifeng] team message silently ingested — sender: ${ctx.senderId}, historyKey: ${historyKey}`,
      );
      return;
    }

    log(`[xiaomifeng] team message accepted — reason: bot @-mentioned`);
  }

  const ctx = parseXiaomifengMessageEvent(message, customMsgParsed);

  log(
    `[xiaomifeng] message content — text: ${JSON.stringify(ctx.text.slice(0, 200))}, isEmpty: ${!ctx.text}`,
  );
  if (isCustomMsg) {
    log(
      `[xiaomifeng] custom message detail — isText: ${customMsgParsed?.isText ?? false}, isImage: ${customMsgParsed?.isImage ?? false}, isFile: ${customMsgParsed?.isFile ?? false}, isShareCard: ${customMsgParsed?.isShareCard ?? false}, parsedText: ${JSON.stringify((customMsgParsed?.text ?? "").slice(0, 200))}`,
    );
  }

  // ── Access control ──
  if (isP2P) {
    const p2pPolicy = (instCfg?.p2p?.policy ?? "open") as XiaomifengP2pPolicy;
    const configAllowFrom = instCfg?.p2p?.allowFrom ?? [];

    const result = isXiaomifengP2pAllowed({
      p2pPolicy,
      allowFrom: configAllowFrom,
      senderId: ctx.senderId,
    });

    if (!result.allowed) {
      if (result.reason === "disabled") {
        log(`[xiaomifeng] p2p disabled — sender: ${ctx.senderId}`);
      } else {
        log(`[xiaomifeng] p2p blocked — sender: ${ctx.senderId}, policy: ${p2pPolicy}`);
      }
      return;
    }
  }

  if (isTeam) {
    const teamPolicy = (instCfg?.team?.policy ?? "open") as XiaomifengTeamPolicy;
    const teamIds = instCfg?.team?.allowFrom ?? [];

    if (
      !isXiaomifengTeamAllowed({
        teamPolicy,
        teamIds,
        groupId: message.to,
        senderId: ctx.senderId,
        sessionType: message.sessionType as "team" | "superTeam",
      })
    ) {
      log(
        `[xiaomifeng] team message blocked — group: ${message.to}, sender: ${ctx.senderId}, policy: ${teamPolicy}`,
      );
      return;
    }
  }

  try {
    const core = getXiaomifengRuntime();

    // customMsgParsed was already computed above (single parse for the whole handler).
    // The envelope carries the real business sender/chat IDs that must drive
    // session routing, reply targeting, and the HTTP API send.

    // effectiveSenderId: business-layer sender for P2P (envelope senderId),
    //   falls back to NIM-level message.from for non-custom messages.
    // effectiveChatId: reply target for HTTP API (envelope chatId).
    const effectiveSenderId =
      isCustomMsg && customMsgParsed?.senderId ? customMsgParsed.senderId : ctx.senderId;
    const useHttpApi = isCustomMsg && Boolean(customMsgParsed?.chatId);

    const inboundTargets = resolveXiaomifengInboundTargets({
      isTeam,
      messageTo: message.to,
      effectiveSenderId,
      httpChatId: useHttpApi && customMsgParsed?.chatId ? customMsgParsed.chatId : undefined,
    });
    const replyTarget = inboundTargets.replyTarget;
    const xiaomifengFrom = `xiaomifeng:${effectiveSenderId}`;
    const xiaomifengTo = inboundTargets.xiaomifengTo;
    const peerKind = isTeam ? "group" : "direct";
    const chatType = peerKind;
    // P2P session key is keyed on the business senderId so conversations with
    // the same user are always routed to the same agent session.
    const peerId = isTeam ? `team-${message.to}` : effectiveSenderId;
    const sessionType: XiaomifengSessionType = isTeam ? message.sessionType : "p2p";

    log(
      `[xiaomifeng] routing — isCustomMsg: ${isCustomMsg}, effectiveSenderId: ${effectiveSenderId}, peerId: ${peerId}, useHttpApi: ${useHttpApi}`,
    );

    //@ts-ignore
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "xiaomifeng",
      peer: {
        kind: peerKind,
        id: peerId,
      },
    });

    if (!route) {
      log(`[xiaomifeng] route unresolved — peer: ${peerId}`);
      return;
    }

    // Handle media if present
    const mediaList = [];

    // For custom messages with images, download and add to mediaList
    if (isCustomMsg) {
      if (customMsgParsed?.isImage && customMsgParsed.imageUrl) {
        log(
          `[xiaomifeng] custom message contains image — downloading: ${customMsgParsed.imageUrl}`,
        );
        const localPath = await downloadImageToLocal(customMsgParsed.imageUrl);
        if (localPath) {
          mediaList.push({ type: "image" as const, url: customMsgParsed.imageUrl, localPath });
          log(`[xiaomifeng] image downloaded — path: ${localPath}`);
        } else {
          log(`[xiaomifeng] image download failed — url: ${customMsgParsed.imageUrl}`);
        }
      } else if (customMsgParsed?.isFile && customMsgParsed.fileUrl) {
        log(
          `[xiaomifeng] custom message contains file — checking + downloading: ${customMsgParsed.fileUrl}`,
        );
        const localPath = await downloadFileToLocal(customMsgParsed.fileUrl, {
          name: customMsgParsed.fileName,
          apiBase,
          accid: xiaomifengCreds?.account,
          token: xiaomifengCreds?.token,
        });
        if (localPath) {
          mediaList.push({
            type: "file" as const,
            url: customMsgParsed.fileUrl,
            name: customMsgParsed.fileName,
            localPath,
          });
          log(`[xiaomifeng] file downloaded — path: ${localPath}`);
        } else {
          log(`[xiaomifeng] file download failed — url: ${customMsgParsed.fileUrl}`);
        }
      }
    } else if (["image", "file", "audio", "video"].includes(message.type)) {
      const attachUrl = message.attach?.url;
      if (attachUrl) {
        const mediaType = message.type as "image" | "file" | "audio" | "video";
        let localPath: string | null = null;
        if (mediaType === "image") {
          log(`[xiaomifeng] native image message — downloading: ${attachUrl}`);
          localPath = await downloadImageToLocal(attachUrl);
          if (localPath) {
            log(`[xiaomifeng] native image downloaded — path: ${localPath}`);
          } else {
            log(`[xiaomifeng] native image download failed — url: ${attachUrl}`);
          }
        }
        mediaList.push({
          type: mediaType,
          url: attachUrl,
          name: message.attach?.name,
          size: message.attach?.size,
          ...(localPath ? { localPath } : {}),
        });
      }
    }

    const mediaPayload = buildXiaomifengMediaPayload(mediaList);

    // ── Resolve display names ──
    const xiaomifengClient = getCachedXiaomifengClient(instCfg!);
    const nativeNim = xiaomifengClient?.nativeNim;

    const senderDisplayName = nativeNim
      ? await resolveUserNick(nativeNim, ctx.senderId, message.fromNick)
      : message.fromNick || effectiveSenderId;

    let conversationLabel: string;
    let groupSubject: string | undefined;
    let teamName: string | undefined;

    if (isTeam) {
      teamName = nativeNim
        ? await resolveTeamName(nativeNim, message.to, message.sessionType as "team" | "superTeam")
        : message.to;
      conversationLabel = buildConversationLabel("team", teamName);
      groupSubject = buildConversationLabel("team", teamName);
    } else {
      conversationLabel = buildConversationLabel("p2p", senderDisplayName);
    }

    // ── System event ──
    const inboundLabel = isTeam
      ? ` From ${senderDisplayName} in ${teamName ?? message.to}`
      : ` From ${senderDisplayName}`;

    //@ts-ignore
    core.system.enqueueSystemEvent(inboundLabel, {
      sessionKey: route.sessionKey,
      contextKey: `xiaomifeng:message:${ctx.sessionId}:${ctx.id}`,
    });

    // ── Group history injection ──
    // When the bot is @-mentioned in a group, prepend silently collected
    // messages so the agent has conversational context.
    const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
    let bodyWithHistory = ctx.text;
    const inboundHistory: Array<{ sender: string; body: string; timestamp?: number }> = [];

    if (isTeam && groupHistories && historyKey && historyLimit > 0) {
      const pending = groupHistories.get(historyKey) ?? [];
      for (const entry of pending) {
        inboundHistory.push({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        });
      }
      bodyWithHistory = buildPendingHistoryContextFromMap({
        historyMap: groupHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: ctx.text,
        formatEntry: (entry) =>
          formatInboundEnvelope({
            channel: "XiaoMiFeng",
            from: teamName ?? `group:${message.to}`,
            timestamp: entry.timestamp,
            body: entry.body,
            chatType: "group",
            senderLabel: entry.sender,
            envelope: envelopeOptions,
          }),
      });
    }

    //@ts-ignore
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: bodyWithHistory,
      RawBody: ctx.text,
      CommandBody: ctx.text,
      ...(inboundHistory.length > 0 ? { InboundHistory: inboundHistory } : {}),
      From: xiaomifengFrom,
      To: xiaomifengTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: chatType,
      ConversationLabel: conversationLabel,
      SenderName: senderDisplayName,
      SenderId: effectiveSenderId,
      Provider: "xiaomifeng" as const,
      Surface: "xiaomifeng" as const,
      MessageSid: ctx.id,
      Timestamp: ctx.timestamp,
      CommandAuthorized: true,
      OriginatingChannel: "xiaomifeng" as const,
      OriginatingTo: xiaomifengTo,
      ...(isTeam ? { GroupSubject: groupSubject ?? message.to, WasMentioned: true } : {}),
      ...mediaPayload,
    });

    let streamChunkIndex = 0;
    let baseMessage: unknown = null;

    const deliver = async (payload: unknown, info?: { kind: string }): Promise<void> => {
      const normalizedPayload = payload as XiaomifengDeliverPayload;
      const mediaUrls =
        normalizedPayload.mediaUrls ??
        (normalizedPayload.mediaUrl ? [normalizedPayload.mediaUrl] : []);
      const text = normalizedPayload.text ?? "";
      const kind = info?.kind ?? "unknown";

      log(
        `[xiaomifeng] deliver called — kind: ${kind}, hasText: ${Boolean(text)}, textLen: ${text.length}, mediaCount: ${mediaUrls.length}`,
      );

      const isTeamMessage = sessionType === "team" || sessionType === "superTeam";

      // Stream blocks via NIM SDK stream API; fall back to normal send on failure
      if (text && kind === "block") {
        try {
          if (!isTeamMessage && !useHttpApi) {
            const result = await sendStreamMessageXiaomifeng({
              cfg,
              to: replyTarget,
              text,
              sessionType,
              chunkIndex: streamChunkIndex++,
              isComplete: false,
              baseMessage,
              accountId,
            });

            if (result?.success && result.baseMessage) {
              baseMessage = result.baseMessage;
            }

            if (result?.success) {
              return;
            }
          }
        } catch (err) {
          log(
            `[xiaomifeng] stream send failed, falling back to normal send — error: ${String(err)}`,
          );
        }
      }

      if (!text && mediaUrls.length === 0) {
        log("[xiaomifeng] skipping empty reply payload");
        return;
      }

      try {
        if (mediaUrls.length > 0) {
          for (const mediaUrl of mediaUrls) {
            const mediaType = inferMessageType(mediaUrl);

            if (mediaType === "image") {
              await sendImageXiaomifeng({
                cfg,
                to: replyTarget,
                imagePath: mediaUrl,
                sessionType,
                accountId,
              });
            } else if (mediaType === "audio") {
              await sendAudioXiaomifeng({
                cfg,
                to: replyTarget,
                audioPath: mediaUrl,
                duration: 0,
                sessionType,
                accountId,
              });
            } else if (mediaType === "video") {
              await sendVideoXiaomifeng({
                cfg,
                to: replyTarget,
                videoPath: mediaUrl,
                duration: 0,
                width: 1920,
                height: 1080,
                sessionType,
                accountId,
              });
            } else {
              await sendFileXiaomifeng({
                cfg,
                to: replyTarget,
                filePath: mediaUrl,
                sessionType,
                accountId,
              });
            }
          }
        }

        if (text) {
          const isGroup = sessionType === "team" || sessionType === "superTeam";
          // Resolve the chatId for HTTP API: prefer the envelope chatId (custom
          // messages), fall back to replyTarget (senderId / team id).
          const httpChatId = inboundTargets.httpReplyChatId ?? replyTarget;

          // sendMessageViaHttpApi → sendXiaomifengMessage handles its own 1500-char
          // chunking internally, so pass the full text without pre-splitting.
          try {
            log(
              `[xiaomifeng] sending via HTTP API — chatId: ${httpChatId}, isGroup: ${isGroup}, inReplyTo: ${message.msgId}`,
            );
            const result = await sendMessageViaHttpApi({
              cfg,
              chatId: httpChatId,
              text,
              accountId,
              isGroup,
            });
            if (result.success) {
              log(
                `[xiaomifeng] HTTP API send ok — chatId: ${httpChatId}, msgId: ${result.msgId ?? ""}, inReplyTo: ${message.msgId}`,
              );
            } else {
              error(
                `[xiaomifeng] HTTP API send failed — chatId: ${httpChatId}, inReplyTo: ${message.msgId}, error: ${result.error}`,
              );
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const errStack = err instanceof Error ? `\n${err.stack}` : "";
            error(
              `[xiaomifeng] HTTP API send error — chatId: ${httpChatId}, inReplyTo: ${message.msgId}, error: ${errMsg}${errStack}`,
            );
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errStack = err instanceof Error ? `\n${err.stack}` : "";
        error(`[xiaomifeng] reply send failed — error: ${errMsg}${errStack}`);
        throw err;
      }
    };

    log(
      `[xiaomifeng] dispatching to agent — msgId: ${message.msgId}, session: ${route.sessionKey}, chat: ${chatType}, agent: ${route.agentId}`,
    );

    const replyRuntime = core.channel.reply as XiaomifengReplyRuntime;
    const dispatchResult = (await replyRuntime.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver,
        humanDelay: { mode: "off" },
        onIdle: () => {
          log(`[xiaomifeng] reply dispatcher idle`);
        },
        onError: (err: unknown, info: { kind: string }) => {
          log(`[xiaomifeng] reply dispatcher error — kind: ${info.kind}, error: ${String(err)}`);
        },
        onSkip: (_payload: unknown, info: { kind: string; reason: string }) => {
          log(
            `[xiaomifeng] reply skipped by normalizer — kind: ${info.kind}, reason: ${info.reason}`,
          );
        },
      },
    })) as XiaomifengDispatchResult;

    log(
      `[xiaomifeng] dispatch complete — msgId: ${message.msgId}, queuedFinal: ${dispatchResult?.queuedFinal ?? "?"}, counts: block=${dispatchResult?.counts?.block ?? 0} final=${dispatchResult?.counts?.final ?? 0}`,
    );

    // ── Clear group history after successful dispatch ──
    if (isTeam && groupHistories && historyKey && historyLimit > 0) {
      clearHistoryEntriesIfEnabled({
        historyMap: groupHistories,
        historyKey,
        limit: historyLimit,
      });
      log(`[xiaomifeng] group history cleared — historyKey: ${historyKey}`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error && err.stack ? `\n${err.stack}` : "";
    error(`[xiaomifeng] dispatch failed — msgId: ${message.msgId}, error: ${errMsg}${errStack}`);
  }
}
