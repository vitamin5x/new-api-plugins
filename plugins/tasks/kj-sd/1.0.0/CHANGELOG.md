---
changelogVersion: 1
plugin: "kj-sd"
version: "1.0.0"
locale: "en"
---
# Changelog

## [1.0.0]

### Added

- Seedance video generation on the Ark task API, served from a New API gateway: create a task with `POST /kj-sd/api/v3/contents/generations/tasks`, poll it with `GET /kj-sd/api/v3/contents/generations/tasks/{task_id}`, and delete it with `DELETE /kj-sd/api/v3/contents/generations/tasks/{task_id}`. A downstream client keeps its Ark request bodies and response envelopes unchanged.
- Delete a finished task with no request body; the plugin answers the upstream success as an empty `204`, matching the vendor.
- The asset library and the real-person visual validation session through `POST /kj-sd/api/v3/?Action=...&Version=2024-01-01`. All twelve Ark actions are accepted: `CreateAsset`, `GetAsset`, `ListAssets`, `UpdateAsset`, `DeleteAsset`, `CreateAssetGroup`, `GetAssetGroup`, `ListAssetGroups`, `UpdateAssetGroup`, `DeleteAssetGroup`, `CreateVisualValidateSession`, and `GetVisualValidateResult`. Each one is forwarded to the upstream asset endpoint at `/api/v3/?Action=...`, where Ark publishes it, and the vendor's `ResponseMetadata`/`Result`/`error` envelope is returned untouched.
- Bill Seedance video generation by upstream tokens, reported per model capability: the output resolution tiers the model offers, whether a reference video was sent, and the produced length. Requests that leave the length to the model accept `duration: -1`, and the hold covers the longest clip the model can produce.
- Address an upstream New API gateway instead of Ark directly, through a type-60 New API channel that has this plugin installed. The plugin sends the video task calls to the upstream gateway's own `/kj-sd` routes and the asset calls to its root, so a reseller chain works the same way as a direct Ark channel.
- Accept video generation on the host `openai_video` protocol and on `openai_responses` in stream, sync, and background modes, in addition to the Ark native routes.

### Changed

- The plugin is published under the key `kj-sd` and is listed as `kuajing Ark`, so it is easy to tell apart from other Ark plugins. Its addresses move with the key: clients call `/kj-sd/api/v3/...` instead of `/ark/api/v3/...`.
- The asset library, the visual validation session, and task deletion report `doubao-seedance-2-0-mini-260615` when the caller names no model. Pass `?model=` on the query string to meter these routes against a different Seedance model; only models this plugin declares are accepted.

### Fixed

- Deleting a task from the gateway works again. The delete route forwarded the task id the caller used — the gateway's own public id — straight to the upstream, which has never seen that id and answered that no such task exists (`404`). The plugin now resolves the id to the private upstream id before the call leaves, so the upstream receives an id it recognises and answers `204`.
- The asset library, the visual validation session, and task deletion work on a gateway that prices Seedance by a per-model expression. These calls now report zero tokens, which prices every tier at nothing and lets the calls reach the upstream.

### Migration

- **Channel:** Update the channel that binds this plugin. Its bound plugin is now `kj-sd`, and its Base URL still points at the upstream New API gateway. Client calls move from `/ark/api/v3/...` to `/kj-sd/api/v3/...`.
- **Pricing:** Configure a price for every model you offer, under System Settings → Group & Model Pricing. Seedance models are metered by the upstream token count the plugin reports, so price them as token-based usage rather than a flat per-call amount. Make sure the Seedance models you serve are in the channel's model list.
