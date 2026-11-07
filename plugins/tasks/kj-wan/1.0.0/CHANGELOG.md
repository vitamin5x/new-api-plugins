---
changelogVersion: 1
plugin: "kj-wan"
version: "1.0.0"
locale: "en"
---
# Changelog

## [1.0.0]

### Added

- Wan 3.0 video generation for `wan3.0-video` and `wan3.0-video-prime`. Clients create and poll tasks on `/kj-wan/api/v1/services/aigc/video-generation/tasks`, and the plugin forwards each call to the upstream New API gateway's task API. Requests keep the vendor's `input` and `parameters` body shape, so prompt-only and reference-media calls work unchanged.
- Prompt-only and reference-media requests are distinguished for metering. A call that carries `input.media` is reported with `media: media`, and one that does not with `media: none`, so each can be priced separately.
- Billable duration follows the vendor's rule for Wan 3.0: output duration alone when the request has no reference video, and input plus output duration when it does. Resolution is reported as `480P`, `720P` or `1080P`, and a request that omits `parameters.resolution` is reported at the vendor's default of `1080P`.
- `parameters.duration: -1`, which asks the model to choose the length, reserves the longest output the model can produce (30 seconds) until the completion payload reports the real duration.

### Migration

- **Channel:** Update the channel that binds this plugin. Its bound plugin is now `kj-wan`, and its Base URL still points at the upstream New API gateway. Client calls move from `/kuajing/...` to `/kj-wan/api/v1/services/aigc/video-generation/tasks`.
