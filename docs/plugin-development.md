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

Everything here was learned building the `ark` plugin in `plugins/tasks/ark/`; its
source is the worked example throughout.

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
  key: "ark",                    // must equal the directory name
  version: "1.1.0",              // must equal the directory name
  name: "Ark",
  author: { name: "opcopilot" }, // required
  models: [...],                 // the names this plugin serves — see §4.3
  fetchMode: "per_task",         // "per_task" or "batch"
  upstreams: ["new_api"],        // which upstream kinds are wired
  routes: [...],                 // the native surface — see §3
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
   // The vendor serves the video API at its host root; a New API gateway that has
   // this plugin installed serves the same addresses under the plugin's own key
   // prefix, which is /ark.
   function apiRoot(ctx) {
     return ctx.baseUrl + (ctx.upstream && ctx.upstream.kind === "new_api" ? "/ark" : "");
   }
   // The asset library lives at the host root on every upstream kind, because the
   // vendor never publishes it below /ark and a gateway prefix does not carry it.
   function assetRoot(ctx) {
     return ctx.baseUrl;
   }
   ```

   Write both roots explicitly. Getting this wrong is invisible until a reseller
   chain is introduced, at which point every call 404s.

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

**Never invent a private placeholder model name** to satisfy §4.2. A name the
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

Separately from §4.1, the host's request pipeline closes the outgoing request body
unconditionally. When a descriptor returns no body, the underlying request ends up
with a `nil` body and the close panics — the client sees **500**
`internal plugin route error`, and the logs show
`panic recovered in plugin route`.

Providing `body: {}` (as in §4.1) keeps the body non-nil and closes both holes at
once. Treat "descriptor with no body" as a bug, not a style choice.

## 6. Designing the surface from a vendor's documentation

1. **Mirror the vendor's paths** as closely as the reserved namespaces allow, so
   downstream clients keep their existing code. Change only what §3 forces you to.
2. **Classify every endpoint** into task-creating, task-reading, and
   answers-once. Task-creating → `submit`; task-reading → `query`; everything else
   → `dynamic` with `retainResult: false`.
3. **Separate paths from models.** For each route decide where the model comes
   from: the request body, the client's model, or `routeModel()` (§4.3).
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
--   models    = every model the channel serves — must cover meta.models (§4.3)
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

## 8. Debugging playbook

Run with `DEBUG=true` and filter on the `task_plugin` subsystem. The host emits
key/value lifecycle events through registry, routing, endpoint ownership, channel
selection, submit durability, polling, and protocol observation.

The events that resolve most failures, in the order they fire:

| Event | What it tells you |
| --- | --- |
| `route ... resolved` | The route was matched. Wrong/no match means a path or method problem. |
| `route ... prepare_rejected` | The host refused before your code ran — read `reason=`. |
| `channel_selected model=...` | A channel was found. Absent → §4.3 (503). |
| `build_submit_complete method=... body_type=...` | Your descriptor was accepted. `body_type=""` on a route that returned no body → §4.4. |
| `refund_invoked` | The call failed downstream and quota was returned. |
| `panic recovered in plugin route` | §4.4. The request pipeline met a `nil` body. |

Symptom → cause, fastest first:

| Symptom | Most likely cause |
| --- | --- |
| `415 this route requires a JSON or multipart body` | §4.1 — send `body: {}` |
| `400 decoded request is missing a model` | §4.2 — decoder returned no model |
| `400 model "x" is not served by this plugin` | §4.2 — name missing from `meta.models` |
| `400 expr run error: invalid operation: <nil> * float64` | §6.6 — `extractUsage` returned `null` (or omitted a fact) on a model the gateway prices by expression. Report the profile's fields at zero instead. |
| `404` whose message quotes an *upstream* "task not found" for a task you created | §7.3 — resolve the id the caller sent to its `originTasks` upstream id; a public gateway id means nothing to the upstream. Also check the channel type is 60. |
| `Invalid URL (DELETE ...)` naming a path without the plugin prefix | §7.3 — a Task Plugin channel (type 61) reports `kind = "vendor"`, so the plugin dropped the prefix. Bind a New API channel (type 60). |
| `503 Task request failed` + `no_available_channel` | §4.3 — placeholder model, or the channel doesn't list it |
| `500 internal plugin route error` + panic in logs | §4.4 — descriptor returned no body |
| `404` on a mirror of a vendor path | §3 — reserved namespace; serve it one segment in |
| Everything 404s only behind a reseller chain | §3 — wrong root for that upstream kind |
| `quota conversion ... overflow` | Local price too high for validation |

Two habits pay for themselves: **never print credentials, headers, bodies, or
private URLs** from plugin code (free-form output cannot be redacted by the host),
and **compare against the upstream directly** whenever a response looks wrong — it
separates a plugin fault from an account or upstream fault in one call.

## 9. Worked example: the Ark plugin

`plugins/tasks/ark/1.3.0/plugin.js` — four routes covering three shapes:

| Route | Type | Why |
| --- | --- | --- |
| `POST /ark/api/v3/contents/generations/tasks` | `submit` | Creates a task. The canonical case. |
| `GET /ark/api/v3/contents/generations/tasks/:task_id` | `query` | Reads it back. No body allowed. |
| `POST /ark/api/v3/` | `dynamic` | The asset library. Vendor path is `/api/v3/?Action=` (reserved), so it lives one segment in and forwards to the upstream root. `retainResult: false` — it answers once. |
| `DELETE /ark/api/v3/contents/generations/tasks/:task_id` | `dynamic` | Answers once, no task to keep. Carries `body: {}` for §4.1/§4.4, and declares the path id as an origin task so the upstream receives the private id. |

Four ideas are worth copying:

- **One descriptor builder, one header helper.** `buildSubmitRequest` funnels all
  three shapes through one function so URL construction and headers stay in a
  single auditable place — the most security-sensitive code in the plugin.
- **Task ids are always translated.** A client only ever sees this gateway's
  public ids, so every path that carries one declares it in `originTaskIds` and
  sends `task.upstreamTaskId` instead. `originUpstreamTaskId` is the single
  translation point; both the draft-reference rewrite and the delete route go
  through it, and an id that cannot be resolved is refused rather than sent.
- **Explicit roots.** `apiRoot()` vs `assetRoot()` encodes the two prefix rules from
  §3 as named functions rather than inline string concatenation.
- **A shared capability table.** One `VIDEO_MODELS` map drives `meta.models`, the
  per-model resolution validation, *and* the generated `usageProfiles`, so the
  pricing table cannot drift from what the plugin actually accepts.
- **Unmetered routes report zeros, not nothing.** `passThroughUsageFacts` derives
  its keys from the same `usageSchema` the model declares, so zero-priced
  pass-through routes stay evaluable under any expression (§6.6) without
  duplicating the field list.

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
- [ ] No credentials, headers, bodies, or private URLs printed from plugin code
- [ ] Loaded into a dev instance and exercised against the vendor doc, including one
      empty-body call per required-argument endpoint
- [ ] `CHANGELOG.md` written in English beside `plugin.js`
- [ ] `index.json` regenerated; `go run . check ../..` passes
- [ ] Published `plugin.js` and `icon.png` / `icon.svg` both hash to what the index
      claims (`plugin.js` also contains no CRLF)
