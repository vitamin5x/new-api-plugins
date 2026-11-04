---
changelogVersion: 1
plugin: "ark"
version: "1.2.0"
locale: "en"
---
# Changelog

## [1.2.0]

### Fixed

- The asset library, the visual validation session, and task deletion work again on a gateway that prices Seedance by a per-model expression. These calls reported no usage of their own, and a gateway that holds a token price expression for the model read the missing token count as an empty value, failed to evaluate the expression, and answered `400` before forwarding anything upstream. They now report zero tokens, which prices every tier at nothing and lets the calls reach the upstream.
