---
changelogVersion: 1
plugin: "ark"
version: "1.0.0"
locale: "en"
---
# Changelog

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
- **Pricing:** The asset library, the visual validation session, and task deletion create no billable work but still resolve to the model `ark-asset-library`, which the plugin declares so the gateway can route them. Configure a price or ratio for `ark-asset-library` as well, and add it to the model list of the channel that binds this plugin. Without it, asset calls and task deletion are rejected with `503` before they reach the upstream.
- **Channel:** Bind this plugin to a New API channel (channel type 60) whose Base URL is the upstream gateway, and set the channel's bound plugin to `ark`. The channel's model list must contain the Seedance models you serve together with `ark-asset-library`.
