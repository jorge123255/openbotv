### Fixed

- Record raw provider token counters in local diagnostic logs for Grok Bot's optional direct-inference path. Each record identifies the turn, tool round, and retry attempt. Missing values stay unknown. The default sandbox gateway still reports account quota and spend only. This adds no token savings or cost estimate.
