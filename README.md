# OpenClaw Open WebUI Channel Plugin

[中文文档](README.zh-CN.md)

This plugin connects OpenClaw to Open WebUI Channels. It lets an OpenClaw bot user join Open WebUI channels, receive mentions, send replies, handle files and reactions, and optionally mirror OpenClaw agent events back to the originating Open WebUI channel.

## Project Status

This project is a modified fork of [Skyzi000/openclaw-open-webui-channels](https://github.com/Skyzi000/openclaw-open-webui-channels). The fork updates the original community plugin for newer OpenClaw plugin packaging requirements and adds compatibility fixes and channel-event mirroring behavior.

## OpenClaw Version

This repository is developed and type-checked with the OpenClaw SDK package declared in `package.json`:

- Development SDK: `openclaw@^2026.5.22`
- Runtime compatibility target: OpenClaw `2026.5.7` and newer

OpenClaw `2026.5.7` does not expose the newer `api.agent.events` facade, so this plugin falls back to the older flat `api.registerAgentEventSubscription` API when available. If a runtime does not expose any agent event subscription API, normal channel messaging still works, but `progressEvents` is disabled.

## Features

- Open WebUI Channel inbound messages through Socket.IO
- OpenClaw outbound messages through Open WebUI REST APIs
- Dedicated Open WebUI bot account support
- Mention-gated group/channel activation
- Direct, group, channel, thread, and reply handling
- File upload and download support
- Message reactions
- Typing indicator while OpenClaw is processing
- Periodic channel rejoin so channels created after plugin startup can work
- Optional mirroring of OpenClaw agent events to the originating Open WebUI channel
- Compiled `dist/` runtime output for OpenClaw plugin installation

## Install

Clone the repository into your OpenClaw extensions directory or another local path:

```bash
git clone https://github.com/harrisonyhq/openclaw-openwebui-channel.git
cd openclaw-openwebui-channel
```

Install the plugin:

```bash
openclaw plugins install .
```

Restart OpenClaw Gateway:

```bash
openclaw gateway restart
```

## Open WebUI Setup

1. Enable Channels in Open WebUI.
2. Create a dedicated bot user, for example `openclaw-bot@example.com`.
3. Add the bot user to every channel where OpenClaw should respond.
4. Copy the Open WebUI base URL, bot email, bot password, and any channel IDs you want to restrict to.

If `channelIds` is empty, the plugin monitors every channel the bot user can access. If `channelIds` contains IDs, only those channels are processed.

## OpenClaw Configuration

Edit `~/.openclaw/openclaw.json`:

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

Restart after changing config:

```bash
openclaw gateway restart
```

## Usage

Mention the bot user in an Open WebUI channel:

```text
@openclaw-bot check this service status
```

When `requireMention` is `true`, non-DM channel messages are ignored unless they mention the bot. Direct messages bypass the mention requirement.

## Session Isolation

By default, group/channel messages are mapped to separate OpenClaw sessions per sender:

```json
{
  "channels": {
    "open-webui": {
      "sessionScope": "user"
    }
  }
}
```

This prevents a new mention from another user in the same Open WebUI channel from interrupting an ongoing answer. Replies still go back to the original Open WebUI channel.

Available modes:

- `user`: isolate sessions by channel/thread and sender. This is the default and recommended mode for shared channels.
- `message`: isolate every mention into its own session. Use this if even repeated mentions from the same user must never interrupt each other.
- `channel`: legacy behavior. All users in the same channel/thread share one OpenClaw session and can interrupt each other.

## Agent Event Mirroring

Set `progressEvents.enabled` to `true` if you want the plugin to mirror OpenClaw agent events back into the same Open WebUI channel.

This is not a human-written status summary. The plugin sends the structured event payload exposed by OpenClaw to plugins as JSON. It is intended to mirror the event data behind Control UI-style progress views as closely as the plugin API allows.

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

By default, `thinking` events are not mirrored because they may expose internal reasoning. Only enable `progressEvents.includeThinking` if you explicitly understand and accept that risk.

## Config Reference

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enables this channel plugin account. |
| `baseUrl` | string | required | Open WebUI base URL. |
| `email` | string | required | Dedicated bot account email. |
| `password` | string | required | Dedicated bot account password. |
| `userId` | string | optional | Optional bot user ID override. |
| `channelIds` | string[] | `[]` | Channel allow-list. Empty means all accessible channels. |
| `requireMention` | boolean | `true` | Require bot mention in non-DM chats. |
| `sessionScope` | string | `user` | Session isolation mode for group/channel messages: `user`, `message`, or `channel`. |
| `name` | string | optional | Display name for this account in OpenClaw. |
| `textChunkLimit` | number | `4000` | Maximum characters per Open WebUI message chunk. |
| `progressEvents.enabled` | boolean | `false` | Mirror OpenClaw agent events into Open WebUI. |
| `progressEvents.includeStreams` | string[] | public streams | Optional event stream allow-list. |
| `progressEvents.excludeStreams` | string[] | optional | Optional event stream deny-list. |
| `progressEvents.includeThinking` | boolean | `false` | Also mirror `thinking` events. Use with care. |
| `progressEvents.maxMessageChars` | number | optional | Truncate serialized event JSON before posting. |
| `progressEvents.codeFence` | boolean | `true` | Wrap mirrored JSON in a Markdown `json` code fence. |

## Development

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run typecheck
npm run build
```

OpenClaw requires compiled runtime output for TypeScript plugin entries. Keep `dist/` committed when publishing or installing this repository directly.

## Troubleshooting

- If new Open WebUI channels do not respond, make sure the bot user has joined them. The plugin rejoins channel rooms periodically, but it cannot receive messages from channels the bot cannot access.
- If only configured channels respond, check whether `channelIds` is non-empty.
- If `progressEvents` does not work on an older OpenClaw runtime, check Gateway logs. Normal channel messaging can still work even when the runtime does not expose agent event subscription APIs.
- If plugin installation complains about TypeScript entries, run `npm run build` and reinstall.

## License

MIT. See [LICENSE](LICENSE).

This fork preserves the original project's MIT license notice and adds the fork maintainer's MIT license notice.
