---
changelogVersion: 1
plugin: "ark"
version: "1.1.0"
locale: "en"
---
# Changelog

## [1.1.0]

### Fixed

- The asset library, the visual validation session, and task deletion no longer rely on a plugin-private model name. Every route now reports a real Seedance model, so the gateway can always find a channel for it. A name the upstream gateway does not serve selects no channel, and those calls died with `503` before reaching the upstream.
- Deleting a task no longer crashes the gateway. The forwarded `DELETE` now carries an empty JSON object, which keeps the request body non-nil through the host's request pipeline.

### Changed

- The asset-library and task-deletion routes report `doubao-seedance-2-0-mini-260615` when the caller names no model. Pass `?model=` on the query string to meter these routes against a different Seedance model; only models this plugin declares are accepted.
- The model list no longer contains `ark-asset-library`.

### Migration

- **Pricing:** Remove `ark-asset-library` from your model pricing and from every channel's model list. It is no longer declared or used.
- **Channel:** The channel that binds this plugin must list the Seedance models you serve. Asset-library and task-deletion calls resolve to `doubao-seedance-2-0-mini-260615` unless the caller passes `?model=`; make sure that model is enabled for the group the callers use, or pass `?model=` with a model that is.
- **Pricing:** Asset-library and task-deletion calls are still not metered: the plugin reports no usage for them, so they reserve nothing of their own.

## [1.0.0]

### Added

- Serve the Ark video task API from a New API gateway on the documented Ark addresses: create a task with `POST /ark/api/v3/contents/generations/tasks`, poll it with `GET /ark/api/v3/contents/generations/tasks/{task_id}`, and delete it with `DELETE /ark/api/v3/contents/generations/tasks/{task_id}`. A downstream client keeps its Ark request bodies and response envelopes unchanged.
- Delete a finished task with no request body; the plugin answers the upstream success as an empty `204`, matching the vendor.
- Use the asset library and the real-person visual validation session through `POST /ark/api/v3/?Action=...&Version=2024-01-01`. All twelve Ark actions are accepted: `CreateAsset`, `GetAsset`, `ListAssets`, `UpdateAsset`, `DeleteAsset`, `CreateAssetGroup`, `GetAssetGroup`, `ListAssetGroups`, `UpdateAssetGroup`, `DeleteAssetGroup`, `CreateVisualValidateSession`, and `GetVisualValidateResult`. Each one is forwarded to the upstream asset endpoint at `/api/v3/?Action=...`, where Ark publishes it, and the vendor's `ResponseMetadata`/`Result`/`error` envelope is returned untouched.
- Bill Seedance video generation by upstream tokens, reported per model capability: the output resolution tiers the model offers, whether a reference video was sent, and the produced length. Requests that leave the length to the model accept `duration: -1`, and the hold covers the longest clip the model can produce.
- Address an upstream New API gateway instead of Ark directly, through a type-60 New API channel that has this plugin installed. The plugin sends the video task calls to the upstream gateway's own `/ark` routes and the asset calls to its root, so a reseller chain works the same way as a direct Ark channel.
- Accept video generation on the host `openai_video` protocol and on `openai_responses` in stream, sync, and background modes, in addition to the Ark native routes.

### Migration

- **Pricing:** Configure a price for every model you offer, under System Settings → Group & Model Pricing. Seedance models are metered by the upstream token count the plugin reports, so price them as token-based usage rather than a flat per-call amount.
- **Channel:** Bind this plugin to a New API channel (channel type 60) whose Base URL is the upstream gateway, and set the channel's bound plugin to `ark`. The channel's model list must contain the Seedance models you serve.
