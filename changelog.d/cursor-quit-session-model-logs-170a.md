### Fixed

- Quit returns within the agent-service step when provider processes and ACP sessions are still open.
- A missing ACP session on `session/load` or `session/set_config_option` opens a new session, and that recovery is not logged as a provider failure.
- OpenRouter model aliases that start with `~` stay in the model list.
- Grok's hook-load warnings are logged once as notices.
