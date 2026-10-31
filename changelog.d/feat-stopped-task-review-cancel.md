### Changed

- Stopped channel work now starts as a compact task count. Expand each task for its owner, last activity, plain reason and recovery actions. Raw event details stay behind a disclosure.
- Review uncertain work before Continue or Reassign. Earlier history must load first, and a changed task requires a new review.

### Added

- Cancel a stopped channel task and its unfinished subtasks after confirmation. Requests, activity and audit history stay available. Cancellation does not undo completed work or external actions.
- Guard reviewed task actions against stale state, duplicate requests and late results. Joined clients need a host that supports the new task actions; older clients keep their existing channel commands.
