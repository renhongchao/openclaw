# Changelog

## [2026.4.14] - 2026-04-14

### Added

- Initial release of `@openclaw/xiaomifeng` channel plugin
- XiaoMiFeng IM channel integration via NIM SDK (`@yxim/nim-bot`)
- Simplified credential configuration: only `clientId` and `clientSecret` required
- Single-instance bot account configuration per gateway
- P2P (direct) and Team (group) message support with configurable access policies
- Custom message parsing for the XiaoMiFeng business-layer envelope format
- Media message support: image, file, audio, video (send and receive)
- Streaming message support for real-time AI responses
- HTTP API message delivery with automatic token refresh and retry
- Message deduplication to handle NIM SDK duplicate callbacks
- Group chat @-mention detection via `botPassport` configuration
- Group chat history context injection for @-mentioned conversations
- Configurable access control: open / allowlist / disabled policies for P2P and Team
- Private deployment support with customizable API endpoints and NOS configuration
- Share card message parsing with deep-link URL conversion
- File attachment support with file-check API URL resolution
- User nickname and team name resolution with TTL cache
- Anti-spam protection (enabled by default)
- ClawHub publishing support with date-based versioning
