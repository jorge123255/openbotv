### Added

- A development-only rehearsal relocates allowlisted synthetic paths with data-preservation checks and runs a restricted read-only projection process without network access. Full application startup and real migration remain blocked.

### Fixed

- Remove each owned projection-test container after a Docker client timeout and verify its absence
  before deleting synthetic data. Retain the fixture if cleanup cannot be confirmed.
