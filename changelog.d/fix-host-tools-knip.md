### Fixed

- Remove unused host-tool exports that caused the CI unused-code check to fail. Host-tool behavior stays the same.
- Correct Hermes fixture and settings types for optional values that can be `undefined`. Runtime behavior stays the same.
- Correct the MCP SDK session-ID declaration without changing its version or runtime code.
- Add local MCP session coverage and safe browser-card test diagnostics. Keep all card-protection checks.
