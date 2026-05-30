# Changelog

## [0.4.4] - 2026-05-30

### Added

- Added `channels.open-webui.sessionScope` to control group/channel session isolation.
- Default group/channel behavior now isolates sessions by sender so concurrent mentions from different users do not interrupt each other.
- Added `message` session isolation mode for fully independent runs per mention.

## [0.4.3] - 2026-05-30

### Added

- Added `README.zh-CN.md` Chinese documentation.
- Added OpenClaw agent event mirroring through `channels.open-webui.progressEvents`.
- Added compiled runtime entries under `dist/` for direct OpenClaw plugin installation.
- Added periodic Open WebUI channel rejoin support so channels created after plugin startup can be handled.

### Changed

- Reworked README documentation around OpenClaw versions, installation, configuration, usage, and troubleshooting.
- Updated package metadata and docs links for the `harrisonyhq/openclaw-openwebui-channel` fork.
- Added `harrisonyhq` to the MIT license notice while preserving the original source project notice.

### Fixed

- Fixed OpenClaw `2026.5.7` compatibility by falling back from `api.agent.events.registerAgentEventSubscription` to `api.registerAgentEventSubscription`.
- Fixed new Open WebUI channels not being joined after the initial Socket.IO connection.

## [0.4.2] - 2026-02-18

### Fixed

- Stop leaking implicit `parentId` from thread context in `handleAction` send. Open WebUI hides messages with a `parent_id` that does not exist in the target channel.
- Align package name with plugin id for standard installation.

## [0.4.1] - 2026-02-15

### Fixed

- Strip `open-webui:` prefix from channel target in `sendText` and `sendMedia`.
- Use `createReplyDispatcherWithTyping` API for reply dispatch.
- Throw when all media uploads fail with no text content to deliver.

### Changed

- Point `docsPath` to GitHub README.
- Remove metadata fields that are not needed by current OpenClaw channel plugin registration.

## [0.4.0] - 2026-02-12

### Added

- Dynamic `peer.kind` based on Open WebUI channel type: `standard` maps to `channel`, `group` maps to `group`, and `dm` maps to `direct`.
- DM support that bypasses `channelIds` filtering and `requireMention`, matching Discord-style channel behavior.
- `ChatType` mapping for `direct`, `channel`, and `group`.
- Thread session isolation using `{channelId}:{parentId}`.
- Thread parent context injection.
- Reaction support.
- Initial OpenClaw plugin integration for Open WebUI Channels through REST API and Socket.IO.

### Breaking Changes

- Session keys for standard channels changed because `peer.kind` is now dynamic instead of the fixed value `group`. Session history from earlier versions may not carry over.
