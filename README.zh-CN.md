# OpenClaw Open WebUI Channel 插件

[English README](README.md)

这是一个连接 OpenClaw 和 Open WebUI Channels 的插件。它可以让 OpenClaw 以 Open WebUI 机器人用户的身份加入频道，接收群聊里的 `@bot` 消息，自动回复、处理附件和反应，并可选地把 OpenClaw agent events 镜像回触发任务的 Open WebUI 频道。

## 项目来源

本项目基于源项目 [Skyzi000/openclaw-open-webui-channels](https://github.com/Skyzi000/openclaw-open-webui-channels) 改造而来。

本 fork 主要做了这些改造：

- 适配新版 OpenClaw 插件包结构和 `openclaw.plugin.json` 要求
- 增加编译后的 `dist/` 运行时入口，解决 TypeScript 插件安装时缺少编译产物的问题
- 修复 OpenClaw `2026.5.7` 与新版 SDK facade 的兼容问题
- 增加 OpenClaw agent events 到 Open WebUI channel 的镜像能力
- 修复插件启动后新建 Open WebUI channel 无法被监听的问题
- 整理安装、配置和使用文档

## 基于的 OpenClaw 版本

当前仓库的开发和类型检查基于 `package.json` 中声明的 OpenClaw SDK：

- 开发 SDK：`openclaw@^2026.5.22`
- 运行兼容目标：OpenClaw `2026.5.7` 及更新版本

OpenClaw `2026.5.7` 没有新版 `api.agent.events` facade，所以插件会自动回退到旧版扁平 API `api.registerAgentEventSubscription`。如果某个更旧的运行时完全没有 agent event subscription API，普通 Open WebUI 收发仍然可用，但 `progressEvents` 事件镜像功能会被禁用。

## 功能特性

- 通过 Socket.IO 接收 Open WebUI Channel 消息
- 通过 Open WebUI REST API 发送 OpenClaw 回复
- 支持独立 Open WebUI bot 用户
- 支持频道/群聊中通过 mention 触发
- 支持私聊、群聊、频道、thread 和 reply
- 支持文件上传和下载
- 支持消息 reactions
- 支持 OpenClaw 处理中显示 typing indicator
- 支持启动后定期重新加入 channel rooms，新建频道也能被后续监听
- 可选：把 OpenClaw agent events 以 JSON 形式镜像回 Open WebUI channel
- 包含编译好的 `dist/` 运行时产物，可直接用于 `openclaw plugins install .`

## 安装

克隆仓库：

```bash
git clone https://github.com/harrisonyhq/openclaw-openwebui-channel.git
cd openclaw-openwebui-channel
```

安装插件：

```bash
openclaw plugins install .
```

重启 OpenClaw Gateway：

```bash
openclaw gateway restart
```

## Open WebUI 准备

1. 确认 Open WebUI 已启用 Channels 功能。
2. 创建专用 bot 用户，例如 `openclaw-bot@example.com`。
3. 把 bot 用户加入需要响应的 Open WebUI channel。
4. 准备好 Open WebUI 地址、bot 邮箱、bot 密码，以及需要限制监听时使用的 channel ID。

如果 `channelIds` 是空数组，插件会处理 bot 用户可访问的所有频道。如果 `channelIds` 非空，插件只处理列表里的频道。

## OpenClaw 配置

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "channels": {
    "open-webui": {
      "enabled": true,
      "baseUrl": "http://your-open-webui:3000",
      "email": "openclaw-bot@example.com",
      "password": "your-password",
      "channelIds": [],
      "requireMention": true,
      "sessionScope": "user",
      "textChunkLimit": 4000,
      "progressEvents": {
        "enabled": false
      }
    }
  },
  "messages": {
    "groupChat": {
      "visibleReplies": "automatic"
    }
  }
}
```

配置后重启：

```bash
openclaw gateway restart
```

## 使用方式

在 Open WebUI channel 中 mention bot：

```text
@openclaw-bot 帮我检查这个服务的状态
```

当 `requireMention` 为 `true` 时，非私聊消息必须 mention bot 才会触发 OpenClaw。私聊会绕过 mention 要求。

## 会话隔离

默认情况下，群聊/频道消息会按发送者隔离到不同的 OpenClaw session：

```json
{
  "channels": {
    "open-webui": {
      "sessionScope": "user"
    }
  }
}
```

这样同一个 Open WebUI channel 里，用户 A 的问题还没回答完时，用户 B 再次 `@bot` 不会打断用户 A 的 run。回复仍然会发回原来的 Open WebUI channel。

可选模式：

- `user`：按 channel/thread + 发送者隔离 session。默认值，推荐用于多人频道。
- `message`：每一条 mention 都创建独立 session。如果同一个用户连续 @ 也必须互不打断，可以使用这个模式。
- `channel`：旧行为。同一个 channel/thread 中所有用户共享一个 OpenClaw session，可能互相打断。

## 镜像 Control UI Agent Events

如果希望 Open WebUI channel 中也看到 OpenClaw agent events，可以开启 `progressEvents.enabled`。

这个功能不会把每一步改写成“状态总结”，而是把 OpenClaw 插件 API 暴露出来的结构化 event payload 以 JSON 形式发送到同一个 Open WebUI channel。它尽量镜像 Control UI 进度视图背后的事件数据，但受限于 OpenClaw 插件 API 暴露的内容。

示例：

```json
{
  "channels": {
    "open-webui": {
      "enabled": true,
      "baseUrl": "http://your-open-webui:3000",
      "email": "openclaw-bot@example.com",
      "password": "your-password",
      "channelIds": [],
      "requireMention": true,
      "progressEvents": {
        "enabled": true,
        "includeStreams": [
          "lifecycle",
          "tool",
          "assistant",
          "error",
          "item",
          "plan",
          "approval",
          "command_output",
          "patch",
          "compaction"
        ],
        "codeFence": true
      }
    }
  }
}
```

默认不会镜像 `thinking` 事件，因为它可能包含内部推理信息。只有在你明确理解风险并确认运行时暴露的是安全内容时，才建议设置：

```json
{
  "progressEvents": {
    "enabled": true,
    "includeThinking": true
  }
}
```

## 配置项

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否启用 open-webui channel。 |
| `baseUrl` | string | 必填 | Open WebUI 地址。 |
| `email` | string | 必填 | bot 用户邮箱。 |
| `password` | string | 必填 | bot 用户密码。 |
| `userId` | string | 可选 | bot 用户 ID 覆盖值。 |
| `channelIds` | string[] | `[]` | 频道白名单。空数组表示 bot 可访问的所有频道。 |
| `requireMention` | boolean | `true` | 非私聊是否必须 mention bot 才触发。 |
| `sessionScope` | string | `user` | 群聊/频道消息的 session 隔离模式：`user`、`message` 或 `channel`。 |
| `name` | string | 可选 | OpenClaw 中显示的账户名称。 |
| `textChunkLimit` | number | `4000` | 每条 Open WebUI 消息的最大字符数。 |
| `progressEvents.enabled` | boolean | `false` | 是否镜像 OpenClaw agent events。 |
| `progressEvents.includeStreams` | string[] | public streams | 事件流白名单。 |
| `progressEvents.excludeStreams` | string[] | 可选 | 事件流黑名单。 |
| `progressEvents.includeThinking` | boolean | `false` | 是否镜像 `thinking` 事件。谨慎开启。 |
| `progressEvents.maxMessageChars` | number | 可选 | 单条事件 JSON 的最大字符数，超出会截断。 |
| `progressEvents.codeFence` | boolean | `true` | 是否用 Markdown `json` 代码块包裹事件 JSON。 |

## 开发

安装依赖：

```bash
npm install
```

检查和构建：

```bash
npm run typecheck
npm run build
```

OpenClaw 安装 TypeScript 插件时要求存在编译后的运行时产物，因此直接发布或直接安装这个仓库时需要保留 `dist/`。

## 常见问题

### 新建频道里 mention bot 没响应

确认 bot 用户已经加入新频道。如果 `channelIds` 非空，也要确认新频道 ID 已经加入配置。当前插件会定期重新发送 `join-channels`，但它不能监听 bot 没有权限访问的频道。

### 只有第一次安装时的频道能响应

旧版逻辑只在 Socket.IO 连接建立时执行一次 `join-channels`。当前 fork 已改成连接后定期重新 join，并在收到 `channel:created` 事件时重新 join。

### `progressEvents` 没有效果

检查 OpenClaw 版本和 Gateway 日志。OpenClaw `2026.5.7` 通过旧版 `api.registerAgentEventSubscription` 兼容；如果运行时完全没有 agent event subscription API，普通聊天仍然可用，但事件镜像不会生效。

### 安装时报 TypeScript entry 缺少编译产物

运行：

```bash
npm run build
openclaw plugins install .
```

## 许可证

MIT。见 [LICENSE](LICENSE)。

本 fork 保留源项目的 MIT license notice，并新增 fork 维护者的 MIT license notice。
