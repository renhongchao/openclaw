/**
 * BeeIM Channel 配置 Schema
 */

import { Type, type Static } from "@sinclair/typebox";

/** BeeIM DM 配置 Schema */
export const BeeIMDmConfigSchema = Type.Object({
  policy: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("allowlist")])),
  allowFrom: Type.Optional(Type.Array(Type.String())),
});

/** BeeIM 群组配置 Schema */
export const BeeIMGroupConfigSchema = Type.Object({
  name: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  users: Type.Optional(Type.Array(Type.String())),
});

/** BeeIM 账户配置 Schema */
export const BeeIMAccountConfigSchema = Type.Object({
  name: Type.Optional(Type.String({ description: "Account display name" })),
  enabled: Type.Optional(Type.Boolean({ description: "Whether this account is enabled" })),
  wsUrl: Type.Optional(Type.String({ description: "WebSocket server URL" })),
  passport: Type.Optional(Type.String({ description: "User passport (email)" })),
  token: Type.Optional(Type.String({ description: "Authentication token" })),
  app: Type.Optional(Type.String({ description: "App identifier" })),
  business: Type.Optional(Type.String({ description: "Business module" })),
  heartbeatInterval: Type.Optional(Type.Number({ description: "Heartbeat interval in seconds" })),
  dm: Type.Optional(BeeIMDmConfigSchema),
  groups: Type.Optional(Type.Record(Type.String(), BeeIMGroupConfigSchema)),
  groupPolicy: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("allowlist")])),
});

/** BeeIM Channel 配置 Schema */
export const BeeIMConfigSchema = Type.Object({
  "bee-im": Type.Optional(
    Type.Union([BeeIMAccountConfigSchema, Type.Record(Type.String(), BeeIMAccountConfigSchema)]),
  ),
});

export type BeeIMDmConfig = Static<typeof BeeIMDmConfigSchema>;
export type BeeIMGroupConfig = Static<typeof BeeIMGroupConfigSchema>;
export type BeeIMAccountConfigType = Static<typeof BeeIMAccountConfigSchema>;
export type BeeIMConfigType = Static<typeof BeeIMConfigSchema>;
