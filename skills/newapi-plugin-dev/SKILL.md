---
name: newapi-plugin-dev
description: Develop, verify and publish New API task plugins (JS plugins for the new-api gateway's plugin marketplace). Use when creating a new task plugin, adding a version to an existing one, diagnosing a plugin that returns 502/503/415/500 on a gateway, or publishing a plugin to a marketplace repository. Covers the intake questions to ask before writing code, the plugin.js route and hook design, changelog and index generation, and the low-cost verification path.
agent_created: true
---

# New API Task Plugin Development

Build a task plugin for the [new-api](https://github.com/QuantumNous/new-api)
gateway: a single self-contained synchronous JavaScript module that republishes a
vendor's async task API (video/music generation) under the gateway, so the gateway
can meter it.

A plugin is **one file**, `plugins/tasks/<key>/<version>/plugin.js`, plus a sibling
`CHANGELOG.md`. No imports, no `fetch`, no async. The host owns HTTP, persistence,
polling, quota and channel selection; the plugin owns URL construction, request
decoding, response parsing, and usage facts.

## Two hard rules, learned the expensive way

**1. The upstream plugin prefix is not your own key.** When a channel points at
another New API gateway, that gateway serves your plugin's routes under the key its
own copy was *installed* with — which is independent of your `meta.key`. Wrong
prefix ⇒ the upstream answers its SPA fallback with `200 text/html` ⇒ the gateway
reports a generic `502 server_error / Task request failed` with no path in the
message. Hold it in a named constant and verify with `scripts/probe_prefix.py`.

**2. Never edit a published version.** The marketplace compares **version strings
only**. An in-place edit leaves the version unchanged, so every gateway already on
it reports "up to date" and is never offered the fix. Ship the change as the next
version directory.

Both are in `references/pitfalls.md` with the other nine traps.

## Workflow

### Step 0 — Locate the repository

Never assume a path; resolve it. A plugin repository root has `index.json`,
`marketplace.json`, `plugins/tasks/`, and `tools/pluginindex/`.

```bash
ls -d */index.json 2>/dev/null            # candidate repositories
git -C <repo> remote -v                   # where it publishes
```

Confirm the index tool and a `new-api` checkout exist, because `pluginindex`
compiles plugin source through `pkg/jsplugin`:

```bash
ls <repo>/tools/pluginindex/main.go
ls ../new-api/pkg/jsplugin/registry.go    # sibling checkout, or ask where it is
```

If the repository is not a plugin repo yet, the minimal scaffold is
`index.json` (generated), `marketplace.json` (`{"name": "..."}`),
`plugins/tasks/`, and `tools/pluginindex/` copied from a working repo.

### Step 1 — Intake: ask before writing code

Read `references/intake.md` and collect answers in **rounds of two to four
questions**. Use a question card rather than a wall of text.

Round 1 (always): display name, `meta.key`, starting version, upstream base URL.
Round 2 (before designing routes): **the vendor's HTTP documentation** — endpoints,
request body shape, response shape, status vocabulary, task-id field, model names
with their resolution tiers and max duration.
Round 3 (before finishing `meta`): how the vendor meters, what the completion
payload reports, whether reference media changes the price.
Round 4 (whenever a reseller chain exists): is the channel pointing at the vendor
or another gateway, and **which key is that gateway's copy installed under**.
Round 5 (last): logo, bilingual description, whether a host protocol is needed.

Do not ask for prices (the gateway configures them) or credentials (the channel
stores them and the host injects them; the plugin never sees them).

Key constraints to state when a key is proposed: `^[a-z0-9][a-z0-9_-]*$`, ≤ 30
characters, lowercase. The key is the marketplace id, the version **directory
name**, and the **route prefix** simultaneously — changing it later moves every
client's URL.

### Step 2 — Resolve the upstream prefix (free, before any code)

If the channel points at a New API gateway, find that gateway's plugin key now:

```bash
python scripts/probe_prefix.py https://upstream.example --prefix ark --prefix <your-key>
```

A real route answers a JSON error envelope; a missing route answers `200 text/html`.
**The discriminator is the content type, never the status code.** The host root is
probed for contrast and excluded from the verdict, because a gateway serves its own
`/api` there regardless of plugin prefixes.

### Step 3 — Design the surface

Read the vendor doc and classify every endpoint:

| Vendor behaviour | Route `type` | Rules |
| --- | --- | --- |
| Starts a task | `submit` | needs `decode` + `render`; body required |
| Reads a task back | `query` | needs `render`; **body must be absent**; id in the path via `taskIdParam` |
| Answers once (asset library, delete) | `dynamic` | needs `decode` + `render`; body required; usually `retainResult: false` |

Then apply the host's two prefix rules:

- **Reserved namespaces** — the host owns `/api`, `/assets`, `/v1/tasks`, `/setup`,
  `/console`, and the auth pages. A vendor publishing at `/api/v3/` cannot be
  mirrored; serve it one segment in under your key and rewrite on the way out.
- **Route prefix** — the first path segment **must equal `meta.key`**, or the
  gateway refuses to register the route.

Start from `assets/plugin-template.js`. It is a working skeleton: capability table,
both root helpers, all mandatory and optional hooks, a real `meta` with
`usageSchema` + `usageProfiles`, and routes. It compiles as-is once placeholders are
filled — verified with `new-api plugin lint`.

### Step 4 — Write the plugin

Replace every `<PLACEHOLDER>`. The decisions that matter:

- **`native.createTask`** decodes the client's body into one normalized intent.
  Everything downstream consumes the intent, never the raw body. Read the prompt
  and media out of the **vendor's own body shape** — Ark uses a flat `content`
  array, DashScope nests under `input` — and do not reshape it.
- **Always send `body: {}`** on `submit`/`dynamic` descriptors, even where the
  vendor documents a bodyless call. A missing body is rejected with `415` before
  plugin code runs, and panics the host's request pipeline on close.
- **Every decoder returns a non-empty `model`** that appears in `meta.models`
  **and** resolves to an enabled channel. Never invent a placeholder name; borrow a
  real model for model-less routes and let `?model=` override it.
- **Translate task ids.** A client sends the gateway's public id; every upstream
  call that names a task resolves it via `ctx.originTasks` and sends
  `task.upstreamTaskId`. Declare the path parameter in `originTaskIds`.
- **Report usage facts, never prices.** Every field the `usageSchema` declares must
  be present on every priced route, **at zero** where nothing is metered: an omitted
  field reads as `null` inside the gateway's price expression and fails with
  `invalid operation: <nil> * float64` before forwarding.
- **Pass the vendor's envelope through untouched**, except to surface its error
  message so callers can read the reason.

### Step 5 — Write the CHANGELOG

Required beside every new version, in English, per the release-notes format:

```markdown
---
changelogVersion: 1
plugin: "<key>"
version: "<version>"
locale: "en"
---
# Changelog

## [<version>]

### Added

- What a user can do now, in one sentence, leading with the capability.
```

Fixed English categories only: `Added`, `Changed`, `Deprecated`, `Removed`,
`Fixed`, `Security`, `Migration`. No tables, no nested lists, one change per bullet.
Include `Migration` only for actions users must take, pricing changes first. Omit
test reports, generic upgrade instructions, and "no action is needed" statements.

**Only describe capabilities the plugin actually implements.** The template starts
with two routes; do not let the changelog promise an asset library, a delete route,
or a protocol binding that `meta.routes` does not declare. A changelog that
overstates the surface sends operators looking for endpoints that were never
registered — and unlike a code bug, nothing fails loudly to reveal it.

### Step 6 — Verify (cheapest signal first)

Run in this order; each step is free except the last.

```bash
# 1. the plugin compiles and its meta validates
cd <new-api> && go run . plugin lint <repo>/plugins/tasks/<key>/<version>/plugin.js

# 2. the forwarded URL is correct, without spending a call
go run . plugin test <plugin.js> --fixture fixture.json

# 3. changelog structure (the index checker does not validate this)
python scripts/check_changelog.py <repo>/plugins/tasks/<key>/<version>/CHANGELOG.md

# 4. regenerate, then check the index
cd <repo>/tools/pluginindex && go run . generate ../.. && go run . check ../..

# 5. hashes, CRLF, and sibling changelogs
python scripts/check_index.py <repo>
```

For step 2, assert the URL from **both** hooks, because they take different shapes:
`native.createTask` consumes the raw vendor body, `buildSubmitRequest` consumes the
**decoded intent**. Feeding a raw body to `buildSubmitRequest` produces an empty
prompt and a false failure. Run the same fixture against the previous version as a
control: if both versions pass, the fixture proves nothing.

> Write the fixture in a **temporary directory outside this repository**. This
> repository holds no plugin test fixtures by rule (see `AGENTS.md`), so keep the
> file wherever you run the tests and do not commit it here.

Only then spend one real call, if the task requires it. Probe parameter limits with
a deliberately invalid value first — vendor validation rejects before the job is
created, so a `400` is a free oracle for minimum duration and allowed tiers.

### Step 7 — Publish

```bash
cd <repo>
git add plugins/tasks/<key>/<version>/ index.json
git commit -m "<key> <version>: <what changed>"
git push
```

Verify the published artifact end to end — the gateway hashes the raw bytes, so an
agreement between index, file and line endings is mandatory:

```bash
# raw hosting caches for a few minutes; confirm through the API when in doubt
curl -sL <RAW_INDEX_URL> | grep -A2 '"<key>"'
curl -sL <RAW_PLUGIN_URL> | sha256sum
```

When raw CDN content looks stale, read the same path through the provider's contents
API (`https://api.github.com/repos/<owner>/<repo>/contents/<path>?ref=main`, base64
in the response) to bypass the cache. That is a verification path, not a workaround
for a real mismatch.

## Scripts

| Script | Purpose |
| --- | --- |
| `scripts/probe_prefix.py` | Find which plugin prefix an upstream gateway actually serves, free. Run before writing `apiRoot()`. |
| `scripts/check_changelog.py` | Validate changelog front matter, version/directory agreement, categories, and structure. |
| `scripts/check_index.py` | Validate index hashes, LF-only bytes, and sibling changelogs. Catches what `pluginindex check` does not. |

All three take a path and exit non-zero on problems; none need network access
except the probe.

## References

| File | Read it when |
| --- | --- |
| `references/intake.md` | Before asking the user for anything — the full question set and why each answer matters |
| `references/pitfalls.md` | When designing `apiRoot()`, debugging any 4xx/5xx, or deciding how to ship a change |
| `assets/plugin-template.js` | When starting a new plugin — a compiling skeleton with every hook |

The repository's own `docs/plugin-development.md` and `docs/plugin-api/v1.md` are
authoritative for hook signatures; read them for anything this skill does not cover.

## Debugging quick map

| Symptom | First thing to check |
| --- | --- |
| `502 Task request failed` and the upstream answered `200` | Wrong plugin prefix — `scripts/probe_prefix.py` (pitfalls #1) |
| `415 this route requires a JSON or multipart body` | Descriptor returned no body — send `body: {}` (pitfalls #3) |
| `500 internal plugin route error` + panic in logs | Same cause as above (pitfalls #3) |
| `503 Task request failed` + `no_available_channel` | Placeholder model, or the channel does not list it (pitfalls #4) |
| `400 model "x" is not served by this plugin` | Name missing from `meta.models` (pitfalls #4) |
| `400 expr run error: invalid operation: <nil> * float64` | `extractUsage` omitted a field or returned `null` (pitfalls #7) |
| `400 content is required` on the native route | Sent a reshaped body instead of the vendor's (pitfalls #5) |
| `404` quoting an upstream "task not found" for your task | Task id not translated via `originTasks` (pitfalls #10) |
| `404` when mirroring a vendor path exactly | Reserved namespace (pitfalls #8) |
| Install fails with a hash mismatch | CRLF in a Windows checkout (pitfalls #11) |
| Gateway shows "up to date" but the fix is missing | The version was edited in place (pitfalls #2) |
