import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import {
  resolveBeeimAccount,
  resolveBeeimCredentials,
  resolveAllBeeimAccounts,
  listBeeimAccountIds,
  resolveBeeimAccountById,
} from "./accounts.js";
import { beeimOutboundConfig } from "./outbound.js";
import { probeBeeim } from "./probe.js";
import { normalizeBeeimTarget, looksLikeBeeimId } from "./targets.js";
import type {
  ResolvedBeeimAccount,
  BeeimConfig,
  BeeimInstanceConfig,
  BeeimTeamPolicy,
} from "./types.js";

/**
 * Channel plugin metadata.
 */
const meta = {
  id: "beeim",
  label: "BeeIM",
  selectionLabel: "BeeIM (网易云信 IM)",
  docsPath: "/channels/beeim",
  docsLabel: "beeim",
  blurb: "BeeIM 网易云信 IM 即时通讯。",
  aliases: ["bee-im", "netease", "yunxin"] as string[],
  order: 80,
};

/**
 * BeeIM channel plugin implementation.
 */
export const beeimPlugin: ChannelPlugin<ResolvedBeeimAccount> = {
  id: "beeim",
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
      "- BeeIM targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:<accountId>` for P2P, `team:<teamId>` for team group.",
      "- For group conversations, always send to the group (do NOT send P2P to individual users unless explicitly asked).",
      "- BeeIM supports text, image, file, audio, and video messages.",
      "- To send an image: use the `mediaUrl` or `mediaPath` parameter with an image file path (png, jpg, gif, webp).",
      "- To send a file: use `mediaUrl` or `mediaPath` with any file path.",
      "- To send audio: use `mediaUrl` or `mediaPath` with an audio file (mp3, wav, aac, m4a).",
      "- To send video: use `mediaUrl` or `mediaPath` with a video file (mp4, mov, avi, webm).",
    ],
  },
  reload: { configPrefixes: ["channels.beeim"] },
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        instances: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              beeImToken: { type: "string" },
              appKey: { type: "string" },
              account: { type: "string" },
              token: { type: "string" },
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
                    items: { oneOf: [{ type: "string" }, { type: "number" }] },
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
                    items: { oneOf: [{ type: "string" }, { type: "number" }] },
                  },
                },
              },
              advanced: {
                type: "object",
                additionalProperties: false,
                properties: {
                  mediaMaxMb: { type: "number", minimum: 0 },
                  textChunkLimit: { type: "integer", minimum: 1 },
                  debug: { type: "boolean" },
                  weblbsUrl: { type: "string" },
                  link_web: { type: "string" },
                  nos_uploader: { type: "string" },
                  nos_downloader_v2: { type: "string" },
                  nosSsl: { type: "boolean" },
                  nos_accelerate: { type: "string" },
                  nos_accelerate_host: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    uiHints: {
      enabled: { label: "Enable" },
      appKey: { label: "App Key" },
      account: { label: "Account ID" },
      token: { label: "Token", sensitive: true },
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
    },
  },
  config: {
    listAccountIds: (cfg) => {
      const ids = listBeeimAccountIds(cfg);
      console.log(
        `[beeim] listAccountIds — raw beeim type: ${Array.isArray((cfg as any)?.channels?.beeim) ? "array" : typeof (cfg as any)?.channels?.beeim}, ids: [${ids.join(", ")}]`,
      );
      return ids;
    },
    resolveAccount: (cfg, accountId) =>
      accountId ? resolveBeeimAccountById({ cfg, accountId }) : resolveBeeimAccount({ cfg }),
    defaultAccountId: (cfg) => listBeeimAccountIds(cfg)[0] ?? "",
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const beeimCfg = cfg.channels?.beeim as BeeimConfig | undefined;
      const instances = (beeimCfg as { instances?: unknown[] } | undefined)?.instances;
      if (!Array.isArray(instances)) return cfg;
      const updated = instances.map((inst: any) => {
        const creds = resolveBeeimCredentials(inst);
        const key = creds ? `${creds.appKey}:${creds.account}` : null;
        if (key === accountId) return { ...inst, enabled };
        return inst;
      });
      return {
        ...cfg,
        channels: { ...cfg.channels, beeim: { ...beeimCfg, instances: updated } },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const beeimCfg = cfg.channels?.beeim as BeeimConfig | undefined;
      const instances = (beeimCfg as { instances?: unknown[] } | undefined)?.instances;
      const deleteChannel = () => {
        const next = { ...cfg } as OpenClawConfig;
        const nextChannels = { ...cfg.channels };
        delete (nextChannels as Record<string, unknown>).beeim;
        if (Object.keys(nextChannels).length > 0) next.channels = nextChannels;
        else delete next.channels;
        return next;
      };
      if (!Array.isArray(instances)) return deleteChannel();
      const filtered = instances.filter((inst: any) => {
        const creds = resolveBeeimCredentials(inst);
        const key = creds ? `${creds.appKey}:${creds.account}` : null;
        return key !== accountId;
      });
      if (filtered.length === 0) return deleteChannel();
      return {
        ...cfg,
        channels: { ...cfg.channels, beeim: { ...beeimCfg, instances: filtered } },
      };
    },
    isConfigured: (_account, cfg) => {
      const all = resolveAllBeeimAccounts({ cfg });
      return all.some((a) => a.configured);
    },
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = accountId
        ? resolveBeeimAccountById({ cfg, accountId })
        : resolveBeeimAccount({ cfg });
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
      allowFromPath: `channels.beeim[${account.accountId}].p2p.`,
      normalizeEntry: (raw: string) => raw.replace(/^(beeim|bee-im|user|account):/i, ""),
      approveHint:
        "Set p2p.policy to 'allowlist' and configure p2p.allowFrom to control who can message the bot.",
    }),
    collectWarnings: ({ cfg }) => {
      const all = resolveAllBeeimAccounts({ cfg });
      const warnings: string[] = [];

      for (const account of all) {
        const label = account.accountId || account.account;
        const inst = account.config as BeeimInstanceConfig | undefined;

        if (account.p2pPolicy === "open") {
          warnings.push(
            `- BeeIM [${label}] P2P: p2p.policy="open" allows any user to message. Set p2p.policy="allowlist" + p2p.allowFrom to restrict senders.`,
          );
        }

        if (account.teamPolicy === "open") {
          warnings.push(
            `- BeeIM [${label}] teams: team.policy="open" allows any group to trigger (mention-gated). Set team.policy="allowlist" + team.allowFrom to restrict by group ID.`,
          );
        }
      }

      return warnings;
    },
  },
  setup: {
    resolveAccountId: ({ cfg }) => listBeeimAccountIds(cfg)[0] ?? "",
    applyAccountConfig: ({ cfg }) => {
      const beeimCfg = cfg.channels?.beeim as BeeimConfig | undefined;
      const instances = (beeimCfg as { instances?: unknown[] } | undefined)?.instances;
      if (!Array.isArray(instances)) return cfg;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          beeim: {
            ...beeimCfg,
            instances: instances.map((inst: any, i: number) =>
              i === 0 ? { ...inst, enabled: true } : inst,
            ),
          },
        },
      };
    },
  },
  messaging: {
    normalizeTarget: (raw: string) => normalizeBeeimTarget(raw) ?? undefined,
    targetResolver: {
      looksLikeId: looksLikeBeeimId,
      hint: "<accountId|user:accountId|team:teamId|superTeam:teamId>",
    },
  },
  outbound: beeimOutboundConfig,
  status: {
    defaultRuntime: null as any, // Multi-instance: no single default runtime
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
        ? resolveBeeimAccountById({ cfg, accountId })
        : resolveBeeimAccount({ cfg });
      return await probeBeeim(inst.configured ? inst.config : (undefined as any));
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
      const { monitorBeeimProvider } = await import("./monitor.js");

      const account = resolveBeeimAccountById({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
      });

      ctx.setStatus({ accountId: ctx.accountId });
      ctx.log?.info(
        `[beeim] provider starting — account: ${account.account || "unknown"}, instanceId: ${ctx.accountId}`,
      );

      return monitorBeeimProvider({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};
