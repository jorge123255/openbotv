### Added

- Add an internal foundation for Hermes gateway password login and connection checks.

### Fixed

- Validate Hermes session cookies before secret registration. Protect quoted and raw tokens, and prevent rejected cookies or provider hints from changing unrelated log masking.
- Classify Hermes cookies from their full name so text in a gateway suffix cannot bypass token protection.
