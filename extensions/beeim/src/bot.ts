import { type OpenClawConfig, type RuntimeEnv } from "openclaw/plugin-sdk";
import { isBeeimP2pAllowed, isBeeimTeamAllowed } from "./accounts.js";
import { getCachedBeeimClient } from "./client.js";
import {
  isCustomMessage,
  parseCustomMessage,
  extractCustomMessageText,
  downloadImageToLocal,
} from "./custom-message.js";
import {
  buildBeeimMediaPayload,
  inferMediaPlaceholder,
  sendImageBeeim,
  sendFileBeeim,
  sendAudioBeeim,
  sendVideoBeeim,
  inferMessageType,
} from "./media.js";
import { resolveUserNick, resolveTeamName, buildConversationLabel } from "./name-resolver.js";
import { getBeeimRuntime } from "./runtime.js";
import {
  sendMessageBeeim,
  replyMessageBeeim,
  splitMessageIntoChunks,
  sendStreamMessageBeeim,
  sendMessageViaHttpApi,
} from "./send.js";
import type {
  BeeimP2pPolicy,
  BeeimTeamPolicy,
  BeeimMessageContext,
  BeeimMessageEvent,
  BeeimMessageType,
  BeeimSessionType,
} from "./types.js";

/**
 * Map message type number to typed enum.
 */
function mapMessageType(msgType: number): BeeimMessageType {
  switch (msgType) {
    case 0:
      return "text";
    case 1:
      return "image";
    case 2:
      return "audio";
    case 3:
      return "video";
    case 4:
      return "geo";
    case 5:
      return "notification";
    case 6:
      return "file";
    case 10:
      return "tip";
    case 100:
      return "custom";
    default:
      return "unknown";
  }
}

/**
 * Extract text content from a BeeIM message.
 * For custom messages (type=100), delegates to parseCustomMessage which reads
 * rawMsg.attachment.raw → envelope.content → { text }.
 */
function extractMessageContent(message: BeeimMessageEvent): string {
  if (isCustomMessage(message.type) || (message.type as any) === 100) {
    const parsed = parseCustomMessage(message);
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
    const url = message.attach?.url;
    return url ? `${placeholder} ${url}` : placeholder;
  }

  return message.text || "";
}

/**
 * Parse a BeeIM message event into a message context.
 */
export function parseBeeimMessageEvent(message: BeeimMessageEvent): BeeimMessageContext {
  const isDirectMessage = message.sessionType === "p2p";
  const sessionId = isDirectMessage ? `p2p-${message.from}` : `team-${message.to}`;

  return {
    id: message.clientMsgId,
    sessionId,
    sessionType: message.sessionType,
    senderId: message.from,
    type: message.type,
    text: extractMessageContent(message),
    timestamp: message.time,
    isDm: isDirectMessage,
    rawEvent: message,
  };
}

/**
 * Handle an incoming BeeIM message.
 * Supports P2P (DM) and team (group) messages.
 * Includes support for custom message type (100) with Xiaomifeng format.
 * Downloads images locally before sending to Agent.
 */
export async function handleBeeimMessage(params: {
  cfg: OpenClawConfig;
  /** The derived accountId ("appKey:accid") for the receiving instance. */
  accountId: string;
  message: BeeimMessageEvent;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const { cfg, accountId, message, runtime } = params;
  const { resolveBeeimAccountById } = await import("./accounts.js");
  const account = resolveBeeimAccountById({ cfg, accountId });
  const nimCfg = account.configured ? account.config : undefined;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const botAccount = nimCfg?.account ? String(nimCfg.account) : "";

  const isP2P = message.sessionType === "p2p";
  const isTeam = message.sessionType === "team" || message.sessionType === "superTeam";

  if (!isP2P && !isTeam) {
    log(`[beeim] ignoring message — session: ${message.sessionType}`);
    return;
  }

  // For team messages, only process when forcePushAccountIds includes the bot
  if (isTeam) {
    const forcePushIds = message.forcePushAccountIds ?? [];
    if (!forcePushIds.includes(botAccount)) {
      log(`[beeim] ignoring team message — reason: bot not in force-push list`);
      return;
    }
    log(`[beeim] team message accepted — reason: bot in force-push list`);
  }

  const ctx = parseBeeimMessageEvent(message);

  // ── Access control ──
  if (isP2P) {
    const p2pPolicy = (nimCfg?.p2p?.policy ?? "open") as BeeimP2pPolicy;
    const configAllowFrom = nimCfg?.p2p?.allowFrom ?? [];

    const result = isBeeimP2pAllowed({
      p2pPolicy,
      allowFrom: configAllowFrom,
      senderId: ctx.senderId,
    });

    if (!result.allowed) {
      if (result.reason === "disabled") {
        log(`[beeim] p2p disabled — sender: ${ctx.senderId}`);
      } else {
        log(`[beeim] p2p blocked — sender: ${ctx.senderId}, policy: ${p2pPolicy}`);
      }
      return;
    }
  }

  if (isTeam) {
    const teamPolicy = (nimCfg?.team?.policy ?? "open") as BeeimTeamPolicy;
    const teamIds = nimCfg?.team?.allowFrom ?? [];

    if (
      !isBeeimTeamAllowed({
        teamPolicy,
        teamIds,
        groupId: message.to,
        senderId: ctx.senderId,
        sessionType: message.sessionType as "team" | "superTeam",
      })
    ) {
      log(
        `[beeim] team message blocked — group: ${message.to}, sender: ${ctx.senderId}, policy: ${teamPolicy}`,
      );
      return;
    }
  }

  try {
    const core = getBeeimRuntime();

    // For custom messages (type=100), parse the envelope once here.
    // The envelope carries the real business sender/chat ids that must drive
    // session routing, reply targeting, and the HTTP API send.
    const isCustomMsg = isCustomMessage(message.type) || (message.type as any) === 100;
    const customMsgParsed = isCustomMsg ? parseCustomMessage(message) : null;

    // effectiveSenderId: business-layer sender for P2P (envelope senderId),
    //   falls back to NIM-level message.from for non-custom messages.
    // effectiveChatId:   reply target for HTTP API (envelope chatId).
    const effectiveSenderId =
      isCustomMsg && customMsgParsed?.senderId ? customMsgParsed.senderId : ctx.senderId;
    const useHttpApi = isCustomMsg && Boolean(customMsgParsed?.chatId);

    const replyTarget = isTeam ? message.to : effectiveSenderId;
    const beeimFrom = `beeim:${effectiveSenderId}`;
    const beeimTo = isTeam ? `team:${message.to}` : `user:${effectiveSenderId}`;
    const chatType = "direct";
    const peerKind = isTeam ? "group" : "direct";
    // P2P session key is keyed on the business senderId so conversations with
    // the same user are always routed to the same agent session.
    const peerId = isTeam ? `team-${message.to}` : effectiveSenderId;
    const sessionType: BeeimSessionType = isTeam ? message.sessionType : "p2p";

    log(
      `[beeim] routing — isCustomMsg: ${isCustomMsg}, effectiveSenderId: ${effectiveSenderId}, peerId: ${peerId}, useHttpApi: ${useHttpApi}`,
    );

    //@ts-ignore
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "beeim",
      peer: {
        kind: peerKind,
        id: peerId,
      },
    });

    if (!route) {
      log(`[beeim] route unresolved — peer: ${peerId}`);
      return;
    }

    // Handle media if present
    const mediaMaxBytes = (nimCfg?.advanced?.mediaMaxMb ?? 30) * 1024 * 1024;
    const mediaList = [];

    // For custom messages with images, download and add to mediaList
    if (isCustomMsg) {
      if (customMsgParsed?.isImage && customMsgParsed.imageUrl) {
        log(`[beeim] custom message contains image — downloading: ${customMsgParsed.imageUrl}`);
        const localPath = await downloadImageToLocal(customMsgParsed.imageUrl);
        if (localPath) {
          mediaList.push({ type: "image" as const, url: localPath });
          log(`[beeim] image downloaded — path: ${localPath}`);
        } else {
          log(`[beeim] image download failed — url: ${customMsgParsed.imageUrl}`);
        }
      }
    } else if (["image", "file", "audio", "video"].includes(message.type)) {
      const attachUrl = message.attach?.url;
      if (attachUrl) {
        mediaList.push({
          type: message.type as "image" | "file" | "audio" | "video",
          url: attachUrl,
          name: message.attach?.name,
          size: message.attach?.size,
        });
      }
    }

    const mediaPayload = buildBeeimMediaPayload(mediaList);

    // ── Resolve display names ──
    const beeimClient = getCachedBeeimClient(nimCfg!);
    const nativeNim = beeimClient?.nativeNim;

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
    core.system.enqueueSystemEvent(`${inboundLabel}`, {
      sessionKey: route.sessionKey,
      contextKey: `beeim:message:${ctx.sessionId}:${ctx.id}`,
    });
    //@ts-ignore
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: ctx.text,
      RawBody: ctx.text,
      CommandBody: ctx.text,
      From: beeimFrom,
      To: beeimTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: chatType,
      ConversationLabel: conversationLabel,
      SenderName: senderDisplayName,
      SenderId: effectiveSenderId,
      Provider: "beeim" as const,
      Surface: "beeim" as const,
      MessageSid: ctx.id,
      Timestamp: ctx.timestamp,
      CommandAuthorized: true,
      OriginatingChannel: "beeim" as const,
      OriginatingTo: beeimTo,
      ...(isTeam ? { GroupSubject: groupSubject ?? message.to, WasMentioned: true } : {}),
      ...mediaPayload,
    });

    const chunkLimit = nimCfg?.advanced?.textChunkLimit ?? 4000;
    let streamChunkIndex = 0;
    let baseMessage: any = null;

    const deliver = async (payload: any, info?: { kind: string }): Promise<void> => {
      const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
      const text = payload.text ?? "";
      const kind = info?.kind ?? "unknown";

      const isTeamMessage = sessionType === "team" || sessionType === "superTeam";

      // Stream blocks via NIM SDK stream API; fall back to normal send on failure
      if (text && kind === "block") {
        try {
          if (!isTeamMessage && !useHttpApi) {
            const result = await sendStreamMessageBeeim({
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
          log(`[beeim] stream send failed, falling back to normal send — error: ${String(err)}`);
        }
      }

      if (!text && mediaUrls.length === 0) {
        log("[beeim] skipping empty reply payload");
        return;
      }

      try {
        if (mediaUrls.length > 0) {
          for (const mediaUrl of mediaUrls) {
            const mediaType = inferMessageType(mediaUrl);

            if (mediaType === "image") {
              await sendImageBeeim({
                cfg,
                to: replyTarget,
                imagePath: mediaUrl,
                sessionType,
                accountId,
              });
            } else if (mediaType === "audio") {
              await sendAudioBeeim({
                cfg,
                to: replyTarget,
                audioPath: mediaUrl,
                duration: 0,
                sessionType,
                accountId,
              });
            } else if (mediaType === "video") {
              await sendVideoBeeim({
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
              await sendFileBeeim({
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
          const isTeamReply =
            (sessionType === "team" || sessionType === "superTeam") &&
            message.rawMsg &&
            ctx.senderId;
          const chunks = splitMessageIntoChunks(text, chunkLimit);

          for (const chunk of chunks) {
            if (useHttpApi && customMsgParsed?.chatId) {
              // Custom messages reply via HTTP API using the envelope chatId.
              try {
                log(`[beeim] sending via HTTP API — chatId: ${customMsgParsed.chatId}`);
                const result = await sendMessageViaHttpApi({
                  cfg,
                  chatId: customMsgParsed.chatId,
                  text: chunk,
                  accountId,
                });
                if (!result.success) {
                  log(`[beeim] HTTP API send failed — error: ${result.error}`);
                }
              } catch (err) {
                log(`[beeim] HTTP API send error — error: ${String(err)}`);
              }
            } else if (isTeamReply) {
              await replyMessageBeeim({
                cfg,
                to: replyTarget,
                text: chunk,
                originalMsg: message.rawMsg,
                forcePushAccountIds: [ctx.senderId],
                sessionType,
                accountId,
              });
            } else {
              await sendMessageBeeim({
                cfg,
                to: replyTarget,
                text: chunk,
                sessionType,
                accountId,
              });
            }
          }
        }
      } catch (err) {
        log(`[beeim] reply send failed — error: ${String(err)}`);
        throw err;
      }
    };

    log(
      `[beeim] dispatching to agent — session: ${route.sessionKey}, chat: ${chatType}, agent: ${route.agentId}`,
    );

    //@ts-ignore
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver,
        humanDelay: { mode: "off" },
        onIdle: () => {
          log(`[beeim] reply dispatcher idle`);
        },
        onError: (err: unknown, info: { kind: string }) => {
          log(`[beeim] reply dispatcher error — kind: ${info.kind}, error: ${String(err)}`);
        },
        onSkip: (_payload: unknown, info: { kind: string; reason: string }) => {
          log(`[beeim] reply skipped by normalizer — kind: ${info.kind}, reason: ${info.reason}`);
        },
      },
    });

    log(`[beeim] dispatch complete`);
  } catch (err) {
    error(`[beeim] dispatch failed — error: ${String(err)}`);
    if (err instanceof Error && err.stack) {
      error(`[beeim] dispatch stack — error: ${err.stack}`);
    }
  }
}
