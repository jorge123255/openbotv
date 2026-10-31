### Changed

- Channel assignment rows show the current task status and open its request and recent channel activity. Viewing a task does not open the agent’s separate private chat or retry work.
- A confirmed missing provider session gives the channel task a safe, specific start-failure reason. Private paths and raw provider diagnostics stay out of the shared channel.
- Bound ACP session preparation by its configured start deadline. A silent new, load or resume request fails safely, cancels its own request and ignores late replies without replaying a task prompt.
