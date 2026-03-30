# @openclaw/bee-im

小蜜蜂 IM WebSocket 消息通道 - OpenClaw Channel 插件

## 功能特性

- ✅ WebSocket 连接管理（自动重连）
- ✅ 心跳保活机制
- ✅ 自动 ACK 确认
- ✅ Session 标识管理（chatType + chatId）
- ✅ 消息队列缓存
- ✅ 支持私聊/群聊分类处理
- ✅ **完整集成 OpenClaw Channel 系统**

## 安装

### 1. 启用插件

```bash
openclaw plugins enable bee-im
```

### 2. 配置认证信息

```bash
# 设置账号和 Token
openclaw config set channels.bee-im.passport "your-email@example.com"
openclaw config set channels.bee-im.token "your-token-here"

# 可选：设置 WebSocket 服务器地址（默认 ws://10.195.240.187:13102/sub）
openclaw config set channels.bee-im.wsUrl "ws://your-server:port/sub"
```

或者使用环境变量：

```bash
# Windows
set BEE_IM_PASSPORT=your-email@example.com
set BEE_IM_TOKEN=your-token-here

# Linux/Mac
export BEE_IM_PASSPORT=your-email@example.com
export BEE_IM_TOKEN=your-token-here
```

### 3. 重启 Gateway

```bash
openclaw gateway restart
```

### 4. 验证状态

```bash
openclaw channels status
```

## 配置选项

| 配置项              | 环境变量                    | 说明                 | 默认值                          |
| ------------------- | --------------------------- | -------------------- | ------------------------------- |
| `passport`          | `BEE_IM_PASSPORT`           | 用户账号（邮箱）     | -                               |
| `token`             | `BEE_IM_TOKEN`              | 认证 Token           | -                               |
| `wsUrl`             | `BEE_IM_WS_URL`             | WebSocket 服务器地址 | `ws://10.195.240.187:13102/sub` |
| `app`               | `BEE_IM_APP`                | App 标识             | `beeClaw`                       |
| `business`          | `BEE_IM_BUSINESS`           | 业务模块             | `common`                        |
| `heartbeatInterval` | `BEE_IM_HEARTBEAT_INTERVAL` | 心跳间隔（秒）       | `300`                           |

### 多账户配置

```bash
# 配置第一个账户
openclaw config set channels.bee-im.account1.passport "user1@example.com"
openclaw config set channels.bee-im.account1.token "token1"

# 配置第二个账户
openclaw config set channels.bee-im.account2.passport "user2@example.com"
openclaw config set channels.bee-im.account2.token "token2"
```

### 安全配置

```bash
# 设置 DM 策略为 allowlist（仅允许指定用户）
openclaw config set channels.bee-im.dm.policy allowlist
openclaw config set channels.bee-im.dm.allowFrom '["user1@example.com", "user2@example.com"]'

# 设置群组策略
openclaw config set channels.bee-im.groupPolicy allowlist
```

## Session 标识规则

根据消息的 `chatType` 和 `chatId` 组合生成 Session ID：

| chatType | 类型 | Session ID 格式    | 示例                                   |
| -------- | ---- | ------------------ | -------------------------------------- |
| 1        | 私聊 | `private:{chatId}` | `private:yd.2eb93e7e174d49aba@163.com` |
| 2        | 群聊 | `group:{chatId}`   | `group:123456789`                      |

## 消息发送

```bash
# 发送私聊消息
openclaw message send --to "bee-im:private:user@example.com" "Hello!"

# 发送群聊消息
openclaw message send --to "bee-im:group:123456" "Hello group!"
```

## 消息格式

接收到的消息对象结构：

```javascript
{
  sessionId: "private:yd.2eb93e7e174d49aba@163.com",  // Session 标识
  chatType: 1,                                          // 1=私聊, 2=群聊
  chatId: "yd.2eb93e7e174d49aba@163.com",              // 聊天 ID
  senderId: "yd.2eb93e7e174d49aba@163.com",            // 发送者 ID
  msgId: 1,                                             // 消息 ID
  msgType: 1,                                           // 消息类型
  sendTime: 1774350257404,                              // 发送时间戳
  messages: [...],                                      // 消息数组（批量时多条）
  lastMessage: {                                        // 最后一条消息
    senderId: "...",
    chatId: "...",
    chatType: 1,
    msgId: 1,
    msgType: 1,
    content: { text: "哈哈哈" },                        // 解析后的内容
    sendTime: 1774350257404
  },
  count: 1,                                             // 消息数量
  raw: "..."                                            // 原始 JSON 字符串
}
```

## 开发

### 构建

```bash
cd extensions/bee-im
npm install
npm run build
```

### 测试

```bash
npm test
```

## 项目结构

```
bee-im/
├── src/
│   ├── index.ts          # 插件入口
│   ├── channel.ts        # Channel 插件定义
│   ├── client.ts         # WebSocket 客户端
│   ├── monitor.ts        # 消息监听器
│   ├── runtime.ts        # 运行时状态管理
│   ├── accounts.ts       # 账户解析
│   ├── config-schema.ts  # 配置 Schema
│   └── types.ts          # 类型定义
├── protocol.proto        # Protobuf 协议定义
├── openclaw.plugin.json  # 插件配置
├── package.json          # 项目配置
├── tsconfig.json         # TypeScript 配置
└── README.md             # 使用说明
```

## 协议命令码

| 命令码 | 说明             |
| ------ | ---------------- |
| 10     | 登录成功         |
| 20     | 心跳响应         |
| 30     | 登录失败         |
| 60     | 接收消息（单条） |
| 760    | 接收消息（批量） |
| 10010  | 认证请求         |
| 10020  | 心跳请求         |
| 10061  | ACK 确认（单条） |
| 70761  | ACK 确认（批量） |

## License

MIT
