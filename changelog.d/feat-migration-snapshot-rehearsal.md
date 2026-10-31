### Added

- A development-only migration rehearsal checks synthetic file inventories, database IDs and history, attachments, shared ownership and offline copy verification. It reports unavailable credentials and path relocation gaps; it does not move a real instance.

### Fixed

- Keep snapshot-lab cleanup roots private and freeze the public inspection paths so caller changes
  cannot redirect capture, restore or recursive disposal.
