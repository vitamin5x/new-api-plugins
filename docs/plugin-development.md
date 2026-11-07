# Plugin Development Guide

A practical, end-to-end guide to writing a task plugin for this repository: how to
design the route surface from a vendor's HTTP documentation, which host rules
decide whether a route works at all, how to ship a logo, how to run and debug a
plugin locally, and how to publish it so an installing gateway accepts it.

This guide is the *practical* companion to the contract documents. Read those for
the authoritative shapes:

- [Task plugin API v1](plugin-api/README.md) — contract, lifecycle, security boundary
- [API reference](plugin-api/v1.md) — every hook, argument, and field
- [`v1.d.ts`](plugin-api/v1.d.ts) / [`v1.schema.json`](plugin-api/v1.schema.json) — signatures and machine-readable shapes
- [Marketplace index format](marketplace.md) — repository layout, integrity checks, release notes format

Everything here was learned building the `ark` plugin in `plugins/tasks/kj-sd/`; its
source is the worked example throughout. Two of the lessons cost real debugging time
and are called out where they belong: the **upstream plugin prefix is not your own
key** (§4, §8.1), and **a fix to a published version ships as a new version** (§7.9).

---

## 1. The division of labour

A plugin is a **single, self-contained, synchronous ECMAScript module**. It has no
`fetch`, no `require`, no imports, no filesystem, no environment, and no async
functions. That is not a limitation to work around — it is the point.

The host owns everything with a side effect:

| The host owns | The plugin owns |
| --- | --- |
| HTTP connections, retries, redirects | Building the upstream URL and request body |
| SSRF and channel-host validation | Constructing headers (from host-supplied credentials) |
| Task persistence, polling schedule | Decoding the client's request into an intent |
| Quota reservation, billing, refunds | Reporting **usage facts** (never prices) |
| Channel selection by model | Declaring which models it serves |
| Route registration and dispatch | Declaring routes, decoders, and renderers |

> A plugin can influence an authenticated upstream request, so uploading one is an
> **administrator-level trust decision**, equivalent to configuring a channel
> credential. Keep request construction explicit and auditable.

## 2. The two halves of a plugin

Every plugin has a **declarative** half and an **imperative** half.

**Declarative** — `export const meta`. This is what the host reads to register the
plugin before any request arrives:

```js
export const meta = {
  apiVersion: 1,
  key: "kj-sd",                  // must equal the directory name
  version: "1.0.1",              // must equal the directory name
  name: "Ark",
  author: { name: "opcopilot" }, // required
  models: [...],                 // the names this plugin serves — see §5.3
  fetchMode: "per_task",         // "per_task" or "batch"
  upstreams: ["new_api"],        // which upstream kinds are wired
  routes: [...],                 // the native surface — see §4
  protocols: [...],              // host-owned protocol bindings
  usageSchema: {...},            // pricing-table shape operators configure against
  usageExamples: [...],          // display examples for that shape
  usageProfiles: [...],          // per-model overrides of schema + examples
};
```

**Imperative** — the exported hooks. The host calls them in a fixed order:

```text
request  → buildSubmitRequest   → [host does HTTP]  → parseSubmitResponse  → task persisted
                                                              ↓
poll     → buildQueryRequest    → [host does HTTP]  → parseTaskResult
                                                              ↓
finally  → extractUsageOnComplete   (overlays the real bill on the reservation)
```

Plus two optional pairs:

- `listArtifacts(task)` + `buildContentRequest(ctx)` — expose downloadable outputs.
- `extractUsage(ctx)` — the submit-time **reservation hold**; `extractUsageOnComplete(task, result, body)` — the settled bill.

Only `meta`, `buildSubmitRequest`, `parseSubmitResponse`, and `parseTaskResult` are
mandatory. Everything else is additive.

## 3. The logo

A plugin's logo ships as a **sidecar file**, never inside the manifest. Put it once
per plugin key, beside the version directories — not inside a version directory:

```text
plugins/tasks/<key>/icon.svg     # preferred when both exist
plugins/tasks/<key>/icon.png
plugins/tasks/<key>/<version>/plugin.js
```

Rules that matter:

- **PNG or SVG only.** A PNG must carry the PNG signature. An SVG must be
  well-formed XML rooted at `svg`, with no `script` or `foreignObject` elements,
  no event-handler attributes, no DOCTYPE, no `javascript:` values, and no
  absolute `http(s)` references — inline the shapes, don't link them.
- **At most 512 KiB.** A larger file fails index generation outright.
- **One logo per key, shared by every version.** It is fetched from the index's
  own origin and stored by the gateway apart from the plugin source, then served
  from `GET /api/plugin/task/:key/icon` (optionally `?version=`).
- **Transparent background, legible in both themes.** The panel renders it on
  light and dark surfaces; supply artwork with a transparent or neutral
  background rather than a baked-in white or black plate. A square canvas at
  256–512 px is ample.

`meta.icon` still exists and still matters — it is the **fallback** when no
sidecar is present. Its priority order is:

```text
marketplace card logo → sidecar icon.svg / icon.png → meta.icon → text avatar
```

`meta.icon` takes either a LobeHub icon name (`Ark.Color`, `Doubao.Color`) or the
`text` / `text:<label>` scheme for a generated text avatar. Inline data URIs and
remote URLs are rejected. Ship a sidecar logo when the vendor has no LobeHub icon
and you want real brand artwork; keep `meta.icon` set as the fallback for any host
that renders the manifest without fetching the sidecar.

Adding a logo **does not touch `plugin.js`** — its `sha256`, and therefore every
already-declared version, stays valid. But the index records the logo's own
`sha256` too, so the same byte-exactness rule applies: regenerate the index and
commit the logo and `index.json` together. A binary image is never line-ending
converted on checkout, so no `.gitattributes` change is needed for it.

## 4. Routes: the native surface

`meta.routes` declares the vendor-shaped addresses the plugin adds to the gateway.
Each entry is:

```js
{ method, path, type, decode, render, taskIdParam, models, retainResult }
```

### Route types

| `type` | Needs `decode` | Needs `render` | Request body | What it is for |
| --- | --- | --- | --- | --- |
| `submit` | yes | yes | required (JSON, or multipart when the route is not model-scoped) | Starts a task |
| `query` | no | yes | **must be absent** | Reads one task back |
| `dynamic` | yes | yes | required | Anything else: pass-through calls, deletes |

- A **`submit`** route's decoder runs, then the host does the HTTP call, then the
  renderer shapes the response.
- A **`query`** route carries its task id in the path. `taskIdParam` names which
  path parameter holds it (default `task_id`). It must not receive a body.
- A **`dynamic`** route is the escape hatch: it may read `ctx.query` (which
  `submit` cannot), may use any HTTP method, and may answer inline instead of
  creating anything to poll.

`retainResult: false` tells the host not to keep a persisted snapshot — correct for
any route that answers once and leaves no task behind.

### Path prefix rules

Two rules decide what a plugin may declare and where the request actually goes.

1. **The host reserves a set of namespaces** that a plugin route may never occupy —
   `/api`, `/assets`, `/v1/tasks`, `/setup`, `/console`, and the auth pages. A vendor
   that publishes its API at `/api/v3/` therefore **cannot be mirrored byte-for-byte**.
   The Ark asset library is exactly this case: the vendor serves it at
   `POST /api/v3/?Action=...`, the host owns `/api`, so the plugin serves it one
   segment in — on its own key prefix — and rewrites the path on the way out.

2. **Where the request lands depends on the upstream kind.** A plugin addresses
   either the vendor directly or another New API gateway that has the same plugin
   installed:

   ```js
   // The video task API. The vendor publishes it at its host root; an upstream New
   // API gateway serves the same addresses under the key its own copy of this
   // plugin was published as. That is the UPSTREAM's key, not this plugin's:
   // our public prefix is /kj-sd, while the copy running on the upstream gateway
   // is published as /ark, so the forwarded call must carry /ark.
   const UPSTREAM_PLUGIN_PREFIX = "/ark";

   function apiRoot(ctx) {
     return ctx.baseUrl + (ctx.upstream && ctx.upstream.kind === "new_api" ? UPSTREAM_PLUGIN_PREFIX : "");
   }
   // The asset library lives at the host root on every upstream kind, because the
   // vendor never publishes it below a plugin prefix and a gateway prefix does not
   // carry it either.
   function assetRoot(ctx) {
     return ctx.baseUrl;
   }
   ```

   **The upstream prefix is not your own key.** Two different keys are in play, and
   they are easy to conflate because both look like a plugin key:

   | Prefix | Whose key it is | Used by |
   | --- | --- | --- |
   | `/kj-sd` | this plugin's `meta.key` | `meta.routes`, and what clients call |
   | `/ark` | the upstream copy's key | the forwarded URL, when `kind = "new_api"` |

   They coincide only when the upstream gateway installed the plugin under the same
   key you publish under. That is not something you can assume: an upstream gateway
   is configured independently and keeps whatever key it was installed with, even
   after you rename your own plugin. `kj-sd` was renamed from `ark` while the
   upstream copy stayed `ark`, which is exactly how the two diverged.

   Do not derive the upstream prefix from `meta.key`. Put it in a named constant.

   Write both roots explicitly. Getting this wrong is silent: the upstream answers
   its single-page-app fallback with **200 and an HTML body** rather than an error,
   so the host sees a successful response it cannot parse and reports
   **502 `server_error` / `Task request failed`**. §8 has the one-minute check that
   tells the two prefixes apart without spending a call.

## 5. The four host rules that decide whether a route works

These are the ones that produce confusing failures. Each is enforced in the host
**before or after** your plugin code runs, so a plugin can look internally correct
and still never work.

### 5.1 A body is mandatory on submit and dynamic routes

A bodyless `POST`/`DELETE` to a `submit` or `dynamic` route is rejected with
**415** and the message `this route requires a JSON or multipart body`, before any
plugin code executes. The vendor's documentation may show a bodyless call — Ark
documents `DELETE .../tasks/{id}` with no body — and it will still be refused.

**Fix:** send an empty JSON object.

```js
// Ark documents this call with no body, but an empty JSON object is sent for two
// independent reasons: the host refuses a bodyless request on the routes it
// serves, and the upstream gateway applies the same rule to the request this
// plugin forwards. `{}` satisfies both and carries no meaning of its own.
return { url: ..., method: "DELETE", headers: ..., body: {} };
```

### 5.2 A submit/dynamic decoder must return a non-empty `model`

The decoded intent's `model` must be a non-empty string, **and** it must appear in
`meta.models`. A missing or foreign name fails with **400**:
`decoded request is missing a model` / `model "x" is not served by this plugin`.

### 5.3 …and that model must resolve to a channel

This is the trap that costs the most time. Selecting a channel happens **by
model**. If no enabled channel in the caller's group lists the model, the request
dies at **503** (`no_available_channel`, surfaced to the client as
`Task request failed`) before it reaches the upstream.

**Never invent a private placeholder model name** to satisfy §5.2. A name the
upstream gateway does not serve selects no channel and breaks every call on that
route. When a vendor endpoint carries no model of its own — an asset library, a
delete — borrow a real model the upstream actually serves:

```js
const DEFAULT_ROUTE_MODEL = "doubao-seedance-2-0-mini-260615";

// Only names this plugin declares are accepted, so a stray ?model= cannot route
// the request to a model the channel was never configured for.
function routeModel(ctx) {
  const claimed = trimmed(queryFirst(ctx, "model"));
  if (claimed && Object.prototype.hasOwnProperty.call(VIDEO_MODELS, claimed)) return claimed;
  return DEFAULT_ROUTE_MODEL;
}
```

Reading `?model=` from the query string lets an operator meter an otherwise
model-less route against a different model without republishing the plugin.

> Alternative pattern: claim the client's own model instead of choosing one —
> `model: ctx.model`, as the `jimeng` plugin does. Use this when the vendor call
> does carry a model and you want the client's choice to decide the channel.

### 5.4 A bodyless request can panic the host

Separately from §5.1, the host's request pipeline closes the outgoing request body
unconditionally. When a descriptor returns no body, the underlying request ends up
with a `nil` body and the close panics — the client sees **500**
`internal plugin route error`, and the logs show
`panic recovered in plugin route`.

Providing `body: {}` (as in §5.1) keeps the body non-nil and closes both holes at
once. Treat "descriptor with no body" as a bug, not a style choice.

## 6. Designing the surface from a vendor's documentation

1. **Mirror the vendor's paths** as closely as the reserved namespaces allow, so
   downstream clients keep their existing code. Change only what §4 forces you to.
2. **Classify every endpoint** into task-creating, task-reading, and
   answers-once. Task-creating → `submit`; task-reading → `query`; everything else
   → `dynamic` with `retainResult: false`.
3. **Separate paths from models.** For each route decide where the model comes
   from: the request body, the client's model, or `routeModel()` (§5.3).
4. **Handle answers-once endpoints inline.** A pass-through call creates no task,
   so the plugin returns a terminal result immediately:

   ```js
   // The raw upstream payload has no `id`, so the host-issued public id is reused
   // and the result is declared terminal.
   return { taskId: ctx.publicTaskId, taskData: body, immediate: { status: "SUCCESS", progress: "100%" } };
   ```

5. **Pass the vendor envelope through untouched.** A client should read exactly
   what the vendor returned. Only intercept when you must translate an error:

   ```js
   if (body.error) throw new Error((body.error.Code || "upstream_error") + ": " + (body.error.Message || "request failed"));
   ```

6. **Report usage facts, never prices.** Return real numbers, not `null`, for
   routes that create no task. The host evaluates the model's price expression
   on every route that has one, and a fact the plugin omits reads as `null`
   inside that expression, which fails with
   `invalid operation: <nil> * float64` and answers `400` before the call is
   forwarded. Report the model's own declared fields at zero instead: zero
   prices every tier at nothing, so the route still reserves no quota, and any
   expression compatible with the schema stays evaluable.

   ```js
   // Pass-through and delete requests create no task and are not metered. They
   // still report every field the profile declares, at the value that prices
   // the call at nothing.
   if (isPassThroughAction(ctx.action)) return passThroughUsageFacts(ctx);
   ```

   This bites only when the gateway actually holds a price expression for the
   model. With none configured the route falls back to per-call pricing and
   `null` looks correct, so test the route on a gateway that prices the model by
   expression, not only on a bare development instance.

7. **Reserve generously, settle exactly.** At submit time you may not know the
   final length; hold the model's maximum and overlay the real facts from the
   completion body.

### 6.1 Call your own route the way the vendor documents it, not the way you wish

A plugin that mirrors a vendor's native surface accepts **the vendor's body**, not a
convenient reshaped one. When the plugin is also reachable through a host protocol
(`openai_video`, say), it is tempting to test it through that protocol and assume
the native route takes the same input. It does not, and the mismatch is reported
before the plugin's own code — the decoder rejects it as a missing field:

```text
POST /kj-sd/api/v3/contents/generations/tasks
{"model": "...", "prompt": "a paper plane"}          -> 400 {"code":"invalid_request","message":"content is required"}
{"model": "...", "content":[{"type":"text","text":"a paper plane"}]}   -> 200
```

Ark's native body carries the prompt inside a `content` array; there is no `prompt`
member. A `400` of this kind costs nothing — it is refused before any upstream call —
so read the message and fix the body rather than assuming the route is broken.

### 6.2 Probe the vendor's parameter limits with a free `400`, not a paid `200`

Vendor parameter validation runs **before** the job is created and before quota is
spent. That makes a rejected request a free oracle for the vendor's real limits:

```text
duration=2 on doubao-seedance-2-0-mini (text-to-video)
  -> 400 InvalidParameter: "the parameter duration specified in the request is not
     valid for model doubao-seedance-2-0-mini in t2v; received: 2"
duration=4 on the same model
  -> 200 {"id":"task_..."}
```

Had the plugin's own declared limits disagreed with the vendor's, the paid attempt
would have been the one to fail. Probe first with the smallest legal value, and keep
the accepted minimum in the plugin's capability table so the next caller does not
repeat the search.

## 7. Local development loop

### 7.1 One-time setup

You need a new-api checkout as a **sibling directory** (`../new-api`) — the index
tool and the dev binary both depend on it.

```bash
# A scratch directory for the dev instance, logs, and probes.
# It MUST stay out of version control: see AGENTS.md.
mkdir -p .work/devrun && cd .work/devrun

cat > .env <<'EOF'
PORT=31234
SQLITE_PATH=./dev.db
SESSION_SECRET=<any-random-string>
CRYPTO_SECRET=<any-random-string>
TZ=Asia/Shanghai
DEBUG=true
EOF
```

`DEBUG=true` is what turns on the `task_plugin` lifecycle events you will debug
with (§7). Start the dev binary with this directory as its working directory.

> **Windows/proxy note.** If the shell exports `https_proxy`, local `curl` calls to
> `127.0.0.1` are hijacked and fail with `os error 10061`. Pass
> `--noproxy 127.0.0.1,localhost` to every local call.

### 7.2 Load the plugin into the dev instance

Upload it the same way an operator would — from the admin panel's task-plugin page,
or `POST /api/plugin/task` with `{"source":"...","remark":"..."}`. The server
compiles the module and **rejects invalid source before saving it**, which is the
fastest correctness signal you get.

For a scripted loop, the persisted row is what the host reads:

```sql
-- task_plugins: one row per (key, version); `active` marks the generation in use
SELECT key, version, api_version, enabled, active, source_hash FROM task_plugins;
```

Re-uploading a **new version** is always allowed; reusing the same `key`+`version`
with different source is rejected. Bump the version while iterating, or replace the
row.

### 7.3 Configure a channel

A plugin does nothing until a channel binds it:

```sql
-- bind the plugin on a New API channel (type 60), never a Task Plugin channel (61)
--   base_url  = the upstream (vendor host, or another New API gateway)
--   models    = every model the channel serves — must cover meta.models (§5.3)
--   setting   = {"task_plugin_key":"<meta.key>"}
SELECT id, name, type, base_url, models, setting FROM channels;
```

**The channel type decides the upstream kind, and only one type works.** A New
API channel (type 60) gives the plugin `ctx.upstream.kind = "new_api"`, which is
what a plugin that declares `upstreams: ["new_api"]` is written for: it addresses
the upstream on the prefixed native routes, and the channel key is sent as the
Bearer token. A Task Plugin channel (type 61) looks similar in the admin panel
and binds the same plugin key, but it reports `kind = "vendor"`, so the plugin
addresses vendor root paths and vendor auth instead. When the upstream serves the
same path at both roots, that mistake hides: submissions still succeed and only
the routes the upstream publishes under one root fail. The symptom is an upstream
`404`/`Invalid URL` naming a path with the plugin prefix missing. Verify the type
before debugging path construction.

Then price the models under System Settings → Group & Model Pricing. Expected
models are token- or unit-based per your `usageSchema`, not a flat per-call price.

> While validating a pipeline, keep the local price very low. A price intended for
> production converts to a quota that can overflow the local field and fail with
> `quota conversion overflow`.

### 7.4 Test from the vendor's own documentation

Derive every test case from the vendor doc — that is the contract you promise. For
each endpoint, take the documented field table, build the smallest legal request,
and check the status and envelope:

```text
create task                 → 200, returns an id
poll the task               → 200, status advances
delete a task that exists   → success; delete one that doesn't → the vendor's not-found error
answers-once endpoint       → vendor envelope, passed through untouched
empty body on a required-arg endpoint → the vendor's own missing-parameter error
```

An empty-body call returning the **vendor's** error envelope (recognisable by the
vendor's metadata block, e.g. `ResponseMetadata`) proves the route is wired and
forwarding — it is not a plugin failure. Confirm by calling the upstream directly
and comparing; if the raw upstream answers the same way, the remaining difference
is account configuration, not code.

### 7.5 Lint before you commit

```bash
new-api plugin lint plugin.js
new-api plugin test plugin.js --fixture golden.json
```

### 7.6 Regenerate the index (never edit it by hand)

```bash
cd tools/pluginindex
go run . generate ../..     # writes ../../index.json from the compiled meta
go run . check ../..        # fails if the index is stale
```

### 7.7 Write the changelog

Every new version **must** ship `CHANGELOG.md` beside its `plugin.js`, in English,
following the [release notes format](marketplace.md#release-notes). A new version
without its sibling changelog is incomplete.

### 7.8 Publish and verify

```bash
git add plugins/tasks/<key>/<version>/ index.json
git commit -m "<key> <version>: <what changed>"
git push
```

The gateway verifies a `sha256` of the downloaded file, so **the committed bytes
must be the hashed bytes**. The `.gitattributes` rule `* text=auto eol=lf` exists
for exactly this reason; without it a Windows checkout would disagree with the
hash. Verify the published artifact end to end:

```bash
# 1. the index is reachable and declares the version you expect
curl -sL <RAW_INDEX_URL> | <read latest + version sha256>

# 2. the published file hashes to what the index claims
curl -sL <RAW_PLUGIN_URL> | sha256sum

# 3. no CRLF crept in
curl -sL <RAW_PLUGIN_URL> | grep -c $'\r'
```

All three must agree. A mismatch is an install failure for every gateway, not a
warning.

### 7.9 Ship the fix as a new version, never as an edit

A published version directory is immutable (see
[marketplace.md](marketplace.md#repository-layout-convention)). Editing
`plugins/<kind>/<key>/<version>/plugin.js` in place looks like the cheap way to
fix a bug, and it silently breaks delivery for everyone who already installed
that version:

- **The gateway decides "up to date" by comparing version strings, not hashes.** A
  marketplace entry is `up_to_date` when the installed `meta.version` equals the
  index's `latest`. Editing the file leaves the version identical, so the gateway
  classifies the install as current and **never offers the update** — the fix
  reaches nobody who already has it, which is precisely the population that
  reported the bug.
- The edit also rewrites the `sha256` the index records for a version that was
  already published, so the version table no longer describes what those gateways
  actually downloaded.

Ship the change as the next version instead:

```bash
# the published version keeps the bytes it shipped with
git show <first-publish-commit>:plugins/tasks/kj-sd/1.0.0/plugin.js \
  > plugins/tasks/kj-sd/1.0.0/plugin.js

# the fix goes in the next version directory
mkdir -p plugins/tasks/kj-sd/1.0.1
cp plugins/tasks/kj-sd/1.0.0/plugin.js plugins/tasks/kj-sd/1.0.1/plugin.js
#   edit 1.0.1/plugin.js and set meta.version = "1.0.1"
#   write 1.0.1/CHANGELOG.md        (§7.7)

cd tools/pluginindex && go run . generate ../.. && go run . check ../..
```

`s/code fix/new version/` is the whole rule. `index.json` then lists both versions
with their own hashes, `latest` moves to the new one, and an installed gateway sees
`upgradable` and offers the update.

> If a published version was already edited in place, restore it to its original
> bytes first — `git show <publish-commit>:<path>` recovers them — and put the fix
> in the new version. Leaving both the edited old bytes and the new version in
> place makes the version table inconsistent with what early installers have.

## 8. Debugging playbook

Run with `DEBUG=true` and filter on the `task_plugin` subsystem. The host emits
key/value lifecycle events through registry, routing, endpoint ownership, channel
selection, submit durability, polling, and protocol observation.

The events that resolve most failures, in the order they fire:

| Event | What it tells you |
| --- | --- |
| `route ... resolved` | The route was matched. Wrong/no match means a path or method problem. |
| `route ... prepare_rejected` | The host refused before your code ran — read `reason=`. |
| `channel_selected model=...` | A channel was found. Absent → §5.3 (503). |
| `build_submit_complete method=... body_type=...` | Your descriptor was accepted. `body_type=""` on a route that returned no body → §5.4. |
| `refund_invoked` | The call failed downstream and quota was returned. |
| `panic recovered in plugin route` | §5.4. The request pipeline met a `nil` body. |

Symptom → cause, fastest first:

| Symptom | Most likely cause |
| --- | --- |
| `415 this route requires a JSON or multipart body` | §5.1 — send `body: {}` |
| `400 decoded request is missing a model` | §5.2 — decoder returned no model |
| `400 model "x" is not served by this plugin` | §5.2 — name missing from `meta.models` |
| `400 expr run error: invalid operation: <nil> * float64` | §6, item 6 — `extractUsage` returned `null` (or omitted a fact) on a model the gateway prices by expression. Report the profile's fields at zero instead. |
| `404` whose message quotes an *upstream* "task not found" for a task you created | §7.3 — resolve the id the caller sent to its `originTasks` upstream id; a public gateway id means nothing to the upstream. Also check the channel type is 60. |
| `Invalid URL (DELETE ...)` naming a path without the plugin prefix | §7.3 — a Task Plugin channel (type 61) reports `kind = "vendor"`, so the plugin dropped the prefix. Bind a New API channel (type 60). |
| `503 Task request failed` + `no_available_channel` | §5.3 — placeholder model, or the channel doesn't list it |
| `502 Task request failed` + `server_error`, upstream answered `200` | §4 — forwarded to the wrong plugin prefix; the upstream served its SPA fallback. Check the constant in `apiRoot()`. |
| `500 internal plugin route error` + panic in logs | §5.4 — descriptor returned no body |
| `404` on a mirror of a vendor path | §4 — reserved namespace; serve it one segment in |
| Everything 404s only behind a reseller chain | §4 — wrong root for that upstream kind |
| `quota conversion ... overflow` | Local price too high for validation |

### 8.1 A 502 that is really a wrong prefix

A misrouted plugin prefix does not announce itself. The upstream gateway has a
single-page-app fallback, so **any** unmatched path answers `200` with
`<!doctype html>` instead of a `404`. The host then fails to parse the body and
surfaces the generic `502 server_error / Task request failed` — the same error a
genuinely broken upstream produces, which sends you looking in the wrong place.

Separate the two in one `GET` per prefix, before touching the plugin, spending no
quota (reading a task that does not exist is free and is rejected before any
upstream create):

```bash
# A real API root answers with the vendor's JSON error (401/404 with a body).
# A wrong prefix answers 200 and an HTML page.
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' \
  -H 'Authorization: Bearer <upstream-key>' \
  <UPSTREAM_BASE>/ark/api/v3/contents/generations/tasks/nonexistent
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' \
  -H 'Authorization: Bearer <upstream-key>' \
  <UPSTREAM_BASE>/kj-sd/api/v3/contents/generations/tasks/nonexistent
```

```text
/ark/...   -> 401 application/json   # a real route, rejecting the token
/kj-sd/... -> 200 text/html          # SPA fallback: no such route
```

The discriminator is **the content type and the body shape, not the status code**.
`200` never means success on an unmatched path.

### 8.2 Prove the forwarded URL without a paid call

Before spending a real request on the vendor, replay the descriptor builders through
a fixture and assert the URL they produce. This runs offline and is deterministic.

Two hooks matter, and they take **different shapes** — the mistake to avoid is
feeding a raw vendor body to `buildSubmitRequest`. The chain is:

```text
raw Ark body  →  native.createTask  →  decoded intent  →  buildSubmitRequest  →  upstream URL
```

`buildSubmitRequest` consumes the *decoded intent* (`model` / `prompt` / `seconds` /
`metadata`), not the client's `content` array. Assert both steps:

```json
{
  "cases": [
    {
      "name": "the vendor body decodes into an intent",
      "hook": "native",
      "path": ["createTask"],
      "args": [{ "body": { "kind": "json", "value": {
        "model": "doubao-seedance-2-0-mini-260615",
        "content": [{ "type": "text", "text": "a paper plane" }],
        "duration": 4,
        "resolution": "480p" } } }],
      "expected": {
        "kind": "submit",
        "model": "doubao-seedance-2-0-mini-260615",
        "action": "text_to_video",
        "requestBody": {
          "model": "doubao-seedance-2-0-mini-260615",
          "prompt": "a paper plane",
          "seconds": 4,
          "metadata": {
            "model": "doubao-seedance-2-0-mini-260615",
            "content": [{ "type": "text", "text": "a paper plane" }],
            "duration": 4,
            "resolution": "480p"
          }
        }
      }
    },
    {
      "name": "the intent is forwarded to the upstream plugin prefix",
      "hook": "buildSubmitRequest",
      "args": [{
        "baseUrl": "https://upstream.example",
        "upstream": { "kind": "new_api" },
        "upstreamModel": "doubao-seedance-2-0-mini-260615",
        "action": "text_to_video",
        "requestBody": {
          "model": "doubao-seedance-2-0-mini-260615",
          "prompt": "a paper plane",
          "seconds": 4,
          "metadata": { "resolution": "480p" }
        },
        "originTasks": {}
      }],
      "expected": {
        "url": "https://upstream.example/ark/api/v3/contents/generations/tasks",
        "method": "POST",
        "action": "text_to_video",
        "rewriteModel": "doubao-seedance-2-0-mini-260615",
        "headers": {
          "Accept": "application/json",
          "Authorization": "Bearer undefined",
          "Content-Type": "application/json"
        },
        "body": {
          "content": [{ "text": "a paper plane", "type": "text" }],
          "duration": 4,
          "model": "doubao-seedance-2-0-mini-260615",
          "resolution": "480p"
        }
      }
    }
  ]
}
```

```bash
new-api plugin test plugin.js --fixture fixture.json
```

`expected` is matched as a **complete** object, not a subset — a partial object
fails with a "result mismatch" that dumps the whole actual value. Use that dump to
fill in the remaining fields rather than guessing them. `Authorization` reads
`Bearer undefined` because a fixture supplies no host credentials; that is the
placeholder rendering, not a leaked secret.

Run the same fixture against the previous version as a **control**: if the old
version produces the buggy URL and the new one produces the correct URL, the fix is
proven and the fixture is known to discriminate. A fixture that passes for both
versions tests nothing.

Two habits pay for themselves: **never print credentials, headers, bodies, or
private URLs** from plugin code (free-form output cannot be redacted by the host),
and **compare against the upstream directly** whenever a response looks wrong — it
separates a plugin fault from an account or upstream fault in one call.

## 9. Worked example: the Ark plugin

`plugins/tasks/kj-sd/1.0.1/plugin.js` — four routes covering three shapes:

| Route | Type | Why |
| --- | --- | --- |
| `POST /kj-sd/api/v3/contents/generations/tasks` | `submit` | Creates a task. The canonical case. |
| `GET /kj-sd/api/v3/contents/generations/tasks/:task_id` | `query` | Reads it back. No body allowed. |
| `POST /kj-sd/api/v3/` | `dynamic` | The asset library. Vendor path is `/api/v3/?Action=` (reserved), so it lives one segment in and forwards to the upstream root. `retainResult: false` — it answers once. |
| `DELETE /kj-sd/api/v3/contents/generations/tasks/:task_id` | `dynamic` | Answers once, no task to keep. Carries `body: {}` for §5.1/§5.4, and declares the path id as an origin task so the upstream receives the private id. |

Six ideas are worth copying:

- **One descriptor builder, one header helper.** `buildSubmitRequest` funnels all
  three shapes through one function so URL construction and headers stay in a
  single auditable place — the most security-sensitive code in the plugin.
- **Task ids are always translated.** A client only ever sees this gateway's
  public ids, so every path that carries one declares it in `originTaskIds` and
  sends `task.upstreamTaskId` instead. `originUpstreamTaskId` is the single
  translation point; both the draft-reference rewrite and the delete route go
  through it, and an id that cannot be resolved is refused rather than sent.
- **Explicit roots, and the upstream prefix as its own constant.**
  `apiRoot()` vs `assetRoot()` encodes the two prefix rules from §4 as named
  functions, and the upstream's key lives in `UPSTREAM_PLUGIN_PREFIX` rather than
  being read from `meta.key`. 1.0.0 derived it from its own key and every call
  behind a reseller chain failed with `502`; see §7.9 and §8.1.
- **A shared capability table.** One `VIDEO_MODELS` map drives `meta.models`, the
  per-model resolution validation, *and* the generated `usageProfiles`, so the
  pricing table cannot drift from what the plugin actually accepts.
- **Unmetered routes report zeros, not nothing.** `passThroughUsageFacts` derives
  its keys from the same `usageSchema` the model declares, so zero-priced
  pass-through routes stay evaluable under any expression (§6, item 6) without
  duplicating the field list.
- **The cheapest real test is the one you write down.** The smallest paid
  verification of this plugin is `doubao-seedance-2-0-mini-260615` at `480p`,
  `duration: 4` — the vendor's minimum for that model, not the `2` it is tempting
  to try (§6.2). Keep the exact body next to the plugin so the next verification
  is one command, not a search.

## 10. New-plugin checklist

- [ ] Directory name equals `meta.key` equals `meta.version`
- [ ] `meta.author.name` present; `models` lists only names the upstream serves
- [ ] Logo shipped as a sidecar `icon.svg` / `icon.png` beside the version
      directories (≤ 512 KiB, transparent background, PNG signature or safe SVG)
- [ ] Every route mirrored from the vendor doc, with only namespace-forced changes
- [ ] `query` routes have no body; `submit`/`dynamic` routes always send one
- [ ] Every decoder returns a non-empty, declared, channel-routable `model`
- [ ] Answers-once routes use `retainResult: false` and return an immediate terminal result
- [ ] `extractUsage` reports zero-valued facts (never `null`) where nothing is metered
- [ ] Vendor response envelopes passed through untouched
- [ ] Any route whose path carries a task id declares it in `originTaskIds` and
      translates it to `task.upstreamTaskId` before the upstream call
- [ ] HTTP calls routed through `apiRoot()`/`assetRoot()`-style helpers for both upstream kinds
- [ ] The upstream plugin prefix is a named constant holding the **upstream's** key,
      never derived from `meta.key` (§4)
- [ ] No credentials, headers, bodies, or private URLs printed from plugin code
- [ ] Loaded into a dev instance and exercised against the vendor doc, including one
      empty-body call per required-argument endpoint
- [ ] `new-api plugin test` fixture asserts the forwarded URL, and fails against the
      previous version when the change is a routing fix (§8.2)
- [ ] `CHANGELOG.md` written in English beside `plugin.js`
- [ ] `index.json` regenerated; `go run . check ../..` passes
- [ ] A change to an already-published version ships as a **new version directory**;
      the published one keeps its original bytes (§7.9)
- [ ] Published `plugin.js` and `icon.png` / `icon.svg` both hash to what the index
      claims (`plugin.js` also contains no CRLF)
