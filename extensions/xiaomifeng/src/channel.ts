import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import {
  resolveXiaomifengAccount,
  resolveAllXiaomifengAccounts,
  listXiaomifengAccountIds,
  resolveXiaomifengAccountById,
} from "./accounts.js";
import { xiaomifengOutboundConfig } from "./outbound.js";
import { probeXiaomifeng } from "./probe.js";
import { normalizeXiaomifengTarget, looksLikeXiaomifengId } from "./targets.js";
import type { ResolvedXiaomifengAccount, XiaomifengConfig } from "./types.js";

/**
 * Channel plugin metadata.
 */
const meta = {
  id: "xiaomifeng",
  label: "XiaoMiFeng",
  selectionLabel: "XiaoMiFeng (小蜜蜂 IM)",
  docsPath: "/channels/xiaomifeng",
  docsLabel: "xiaomifeng",
  blurb: "XiaoMiFeng 小蜜蜂 IM 即时通讯。",
  aliases: ["xiao-mi-feng", "netease", "yunxin"] as string[],
  order: 80,
};

/**
 * XiaoMiFeng channel plugin implementation.
 */
export const xiaomifengPlugin: ChannelPlugin<ResolvedXiaomifengAccount> = {
  id: "xiaomifeng",
  meta: {
    ...meta,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    polls: false,
    threads: false,
    media: true,
    reactions: false,
    edit: false,
    reply: false,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- XiaoMiFeng targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:<accountId>` for P2P, `team:<teamId>` for team group.",
      "- For group conversations, always send to the group (do NOT send P2P to individual users unless explicitly asked).",
      "- XiaoMiFeng supports text, image, file, audio, and video messages.",
      "- To send an image: use the `mediaUrl` or `mediaPath` parameter with an image file path (png, jpg, gif, webp).",
      "- To send a file: use `mediaUrl` or `mediaPath` with any file path.",
      "- To send audio: use `mediaUrl` or `mediaPath` with an audio file (mp3, wav, aac, m4a).",
      "- To send video: use `mediaUrl` or `mediaPath` with a video file (mp4, mov, avi, webm).",
    ],
  },
  reload: { configPrefixes: ["channels.xiaomifeng"] },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true },
        clientId: { type: "string" },
        clientSecret: { type: "string" },
        botPassport: { type: "string" },
        antispamEnabled: { type: "boolean", default: true },
        p2p: {
          type: "object",
          additionalProperties: false,
          properties: {
            policy: {
              type: "string",
              enum: ["open", "allowlist", "disabled"],
            },
            allowFrom: {
              type: "array",
              items: { anyOf: [{ type: "string" }, { type: "number" }] },
            },
          },
        },
        team: {
          type: "object",
          additionalProperties: false,
          properties: {
            policy: {
              type: "string",
              enum: ["open", "allowlist", "disabled"],
            },
            allowFrom: {
              type: "array",
              items: { anyOf: [{ type: "string" }, { type: "number" }] },
            },
          },
        },
        advanced: {
          type: "object",
          additionalProperties: false,
          properties: {
            mediaMaxMb: { type: "number", minimum: 0, default: 30 },
            textChunkLimit: { type: "integer", minimum: 1, default: 4000 },
            debug: { type: "boolean", default: false },
            legacyLogin: { type: "boolean", default: false },
            weblbsUrl: { type: "string" },
            link_web: { type: "string" },
            nos_uploader: { type: "string" },
            nos_downloader_v2: { type: "string" },
            nosSsl: { type: "boolean" },
            nos_accelerate: { type: "string" },
            nos_accelerate_host: { type: "string" },
            apiBase: { type: "string" },
          },
        },
      },
    },
    uiHints: {
      enabled: { label: "Enable" },
      clientId: {
        label: "Client ID",
        help: "Bot account ID from XiaoMiFeng admin console.",
      },
      clientSecret: {
        label: "Client Secret",
        sensitive: true,
        help: "Authentication token from XiaoMiFeng admin console.",
      },
      botPassport: {
        label: "Bot Passport",
        help: "Business identity for group @-mention detection. Optional.",
      },
      antispamEnabled: {
        label: "Anti-Spam",
        help: "Enable anti-spam protection.",
      },
      p2p: { label: "P2P" },
      "p2p.policy": { label: "Message Policy" },
      "p2p.allowFrom": { label: "Account Allowlist" },
      team: { label: "Team" },
      "team.policy": { label: "Message Policy" },
      "team.allowFrom": { label: "Team Allowlist" },
      advanced: { label: "Advanced", advanced: true },
      "advanced.mediaMaxMb": { label: "Max Media Size (MB)" },
      "advanced.textChunkLimit": { label: "Text Chunk Limit" },
      "advanced.debug": { label: "Debug Mode", advanced: true },
      "advanced.legacyLogin": {
        label: "Legacy Login",
        help: "Enable legacy login mode for older deployments.",
        advanced: true,
      },
      "advanced.weblbsUrl": {
        label: "LBS URL (Private Deploy)",
        advanced: true,
      },
      "advanced.link_web": {
        label: "Link Server URL (Private Deploy)",
        advanced: true,
      },
      "advanced.nos_uploader": {
        label: "NOS Upload URL (Private Deploy)",
        advanced: true,
      },
      "advanced.nos_downloader_v2": {
        label: "NOS Download URL Format (Private Deploy)",
        advanced: true,
      },
      "advanced.nosSsl": {
        label: "NOS Download HTTPS (Private Deploy)",
        advanced: true,
      },
      "advanced.nos_accelerate": {
        label: "CDN Accelerate URL (Private Deploy)",
        advanced: true,
      },
      "advanced.nos_accelerate_host": {
        label: "CDN Accelerate Host (Private Deploy)",
        advanced: true,
      },
      "advanced.apiBase": {
        label: "API Base URL",
        help: "Override the default API endpoint. Production: https://api.mifengs.com",
        advanced: true,
      },
    },
  },
  config: {
    listAccountIds: (cfg) => {
      const ids = listXiaomifengAccountIds(cfg);
      return ids;
    },
    resolveAccount: (cfg, accountId) =>
      accountId
        ? resolveXiaomifengAccountById({ cfg, accountId })
        : resolveXiaomifengAccount({ cfg }),
    defaultAccountId: (cfg) => listXiaomifengAccountIds(cfg)[0] ?? "",
    setAccountEnabled: ({ cfg, accountId: _accountId, enabled }) => {
      const xiaomifengCfg = cfg.channels?.xiaomifeng as XiaomifengConfig | undefined;
      if (!xiaomifengCfg) {
        return cfg;
      }
      return {
        ...cfg,
        channels: { ...cfg.channels, xiaomifeng: { ...xiaomifengCfg, enabled } },
      };
    },
    deleteAccount: ({ cfg }) => {
      const next = { ...cfg } as OpenClawConfig;
      const nextChannels = { ...cfg.channels };
      delete (nextChannels as Record<string, unknown>).xiaomifeng;
      if (Object.keys(nextChannels).length > 0) {
        next.channels = nextChannels;
      } else {
        delete next.channels;
      }
      return next;
    },
    isConfigured: (_account, cfg) => {
      const all = resolveAllXiaomifengAccounts({ cfg });
      return all.some((a) => a.configured);
    },
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = accountId
        ? resolveXiaomifengAccountById({ cfg, accountId })
        : resolveXiaomifengAccount({ cfg });
      return account.allowFrom ?? [];
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.p2pPolicy ?? "open",
      allowFrom: account.allowFrom ?? [],
      allowFromPath: `channels.xiaomifeng[${account.accountId}].p2p.`,
      normalizeEntry: (raw: string) => raw.replace(/^(xiaomifeng|xiao-mi-feng|user|account):/i, ""),
      approveHint:
        "Set p2p.policy to 'allowlist' and configure p2p.allowFrom to control who can message the bot.",
    }),
    collectWarnings: ({ cfg }) => {
      const all = resolveAllXiaomifengAccounts({ cfg });
      const warnings: string[] = [];

      for (const account of all) {
        const label = account.accountId || account.account;

        if (account.p2pPolicy === "open") {
          warnings.push(
            `- XiaoMiFeng [${label}] P2P: p2p.policy="open" allows any user to message. Set p2p.policy="allowlist" + p2p.allowFrom to restrict senders.`,
          );
        }

        if (account.teamPolicy === "open") {
          warnings.push(
            `- XiaoMiFeng [${label}] teams: team.policy="open" allows any group to trigger (mention-gated). Set team.policy="allowlist" + team.allowFrom to restrict by group ID.`,
          );
        }
      }

      return warnings;
    },
  },
  setup: {
    resolveAccountId: ({ cfg }) => listXiaomifengAccountIds(cfg)[0] ?? "",
    applyAccountConfig: ({ cfg }) => {
      const xiaomifengCfg = cfg.channels?.xiaomifeng as XiaomifengConfig | undefined;
      if (!xiaomifengCfg) {
        return cfg;
      }
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          xiaomifeng: { ...xiaomifengCfg, enabled: true },
        },
      };
    },
  },
  messaging: {
    normalizeTarget: (raw: string) => normalizeXiaomifengTarget(raw) ?? undefined,
    targetResolver: {
      looksLikeId: looksLikeXiaomifengId,
      hint: "<accountId|user:accountId|team:teamId|superTeam:teamId>",
    },
  },
  outbound: xiaomifengOutboundConfig,
  status: {
    defaultRuntime: undefined, // Multi-instance: no single default runtime
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, cfg }) => {
      const accountId = account.accountId;
      const inst = accountId
        ? resolveXiaomifengAccountById({ cfg, accountId })
        : resolveXiaomifengAccount({ cfg });
      if (!inst.configured) {
        return {
          connected: false,
          account: inst.account || undefined,
          loginState: "not_connected",
        };
      }
      return await probeXiaomifeng(inst.config);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const running = runtime?.running ?? false;
      const probeConnected = (probe as { connected?: boolean } | undefined)?.connected;
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        running,
        connected: probeConnected ?? running,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { monitorXiaomifengProvider } = await import("./monitor.js");

      const account = resolveXiaomifengAccountById({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
      });

      ctx.setStatus({ accountId: ctx.accountId });
      ctx.log?.info(
        `[xiaomifeng] provider starting — account: ${account.account || "unknown"}, instanceId: ${ctx.accountId}`,
      );

      return monitorXiaomifengProvider({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};
