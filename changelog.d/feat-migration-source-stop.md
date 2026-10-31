### Added

- Docker instance backups can use `--keep-stopped` to keep the source stopped after copying or verification, including a failure. This mode refuses a nonzero exit from a stop it performs. Full cross-platform migration and encrypted credential transfer remain in design.

### Fixed

- Restrict the synthetic backup test to two source files and verify removal of its owned container
  after a client timeout. Document that ordinary backups contain unencrypted credential unlock data
  and cannot authorize credential migration.
