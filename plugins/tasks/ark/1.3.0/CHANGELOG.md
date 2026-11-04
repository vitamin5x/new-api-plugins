---
changelogVersion: 1
plugin: "ark"
version: "1.3.0"
locale: "en"
---
# Changelog

## [1.3.0]

### Fixed

- Deleting a task from the gateway works again. The delete route forwarded the task id the caller used — the gateway's own public id — straight to the upstream, which has never seen that id and answered that no such task exists (`404`). The plugin now resolves the id to the private upstream id before the call leaves, the same way a draft-task reference already did, so the upstream receives an id it recognises and answers `204`.
