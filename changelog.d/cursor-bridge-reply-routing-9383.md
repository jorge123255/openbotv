### Fixed

- A channel request that already names an MCP or agent-bridge reply, with from and to, now goes to a member. That member sends the reply with the MCP tool. Before, Coordinator stopped and asked what to send, or which channel member a name such as agent-Mcp was.
- Cursor sign-in from a computer with no browser now uses the same Cursor page BotAI uses for Grok Bot. OpenBot saves the sign-in for the Cursor CLI. Before, that sign-in waited on `cursor-agent login`, which stops when it cannot open a browser.
