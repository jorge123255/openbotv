### Fixed

- Quit stops the agent service while a provider still holds its OpenBot connection.
- A channel handoff with a missing recipient, task, expected result, or source message tells the agent what to add.
- Grok opens a new session when its agent no longer has the saved session, and the chat continues.
