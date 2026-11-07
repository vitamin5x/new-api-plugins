# Traps that produce confusing failures

Every item here was learned by hitting it. Order matters: these are sorted by how
much time they cost, not by how often they occur.

## 1. The upstream plugin prefix is not your own key

**Symptom:** `502 server_error / Task request failed` on every create, while the
plugin looks internally correct and lint passes.

**Cause:** `apiRoot()` forwarded to the upstream under the plugin's own `meta.key`.
A New API gateway serves a plugin's routes under the key that plugin was *installed*
with, and that is a property of the upstream gateway, not of your source. When the
two differ, the upstream has no route at your key, falls through to its
single-page-app handler, and answers **`200` with `<!doctype html>`**. The host
cannot parse that body and reports the generic 502.

**Fix:** hold the upstream's key in its own named constant, never derived from
`meta.key`:

```js
// The video task API. The vendor publishes it at its host root; an upstream New
// API gateway serves the same addresses under the key its own copy of this plugin
// was published as. That is the UPSTREAM's key, not this plugin's.
const UPSTREAM_PLUGIN_PREFIX = "/ark";

function apiRoot(ctx) {
  return ctx.baseUrl + (ctx.upstream && ctx.upstream.kind === "new_api" ? UPSTREAM_PLUGIN_PREFIX : "");
}
```

**Verify without spending quota:** run `scripts/probe_prefix.py`. The discriminator
is the **content type**, never the status code — `200` does not mean success on an
unmatched path.

**Do not assume the keys match** just because you renamed your plugin. This exact
mistake happened when `ark` was renamed to `kj-sd`: the upstream copy stayed `ark`.

## 2. Editing a published version ships the fix to nobody

**Symptom:** you fixed a bug and pushed, and every gateway that already installed
the plugin still reports "up to date" with no update offered.

**Cause:** the marketplace compares **version strings only**. An install is
`up_to_date` when its `meta.version` equals the index's `latest`:

```ts
if (installedVersion === plugin.latest) return { status: 'up_to_date', installedVersion }
```

Editing `plugins/tasks/<key>/<version>/plugin.js` in place leaves that string
unchanged, so the gateway classifies the install as current. The `sha256` is an
install-time integrity check, not an update trigger. Worse, the edit rewrites the
hash the index records for bytes that were already published, so the version table
stops describing what early installers actually downloaded.

**Fix:** ship the change as the **next version directory**. Restore the published
one to its original bytes if it was already edited:

```bash
# recover the bytes it shipped with
git show <publish-commit>:plugins/tasks/<key>/<ver>/plugin.js > plugins/tasks/<key>/<ver>/plugin.js

# the fix goes in the next version
mkdir -p plugins/tasks/<key>/1.0.1
cp plugins/tasks/<key>/1.0.0/plugin.js plugins/tasks/<key>/1.0.1/plugin.js
#   set meta.version = "1.0.1", write CHANGELOG.md
```

Then regenerate the index so `latest` moves and the gateway sees `upgradable`.

## 3. A bodyless request is refused or panics

**Symptom:** `415 this route requires a JSON or multipart body`, or
`500 internal plugin route error` with `panic recovered in plugin route` in the logs.

**Cause:** two independent holes. The host rejects a bodyless `POST`/`DELETE` on
`submit` and `dynamic` routes before plugin code runs. Separately, the host's
request pipeline closes the outgoing body unconditionally, and a descriptor that
returns no body leaves it `nil`, which panics on close.

**Fix:** always send `body: {}` — even where the vendor documents a bodyless call.
Both holes close at once.

```js
return { url, method: "DELETE", headers, body: {} };
```

## 4. A placeholder model breaks every call on the route

**Symptom:** `503 Task request failed` + `no_available_channel`, or
`400 model "x" is not served by this plugin`.

**Cause:** the channel is selected **by model**. A decoder must return a non-empty
`model` that both appears in `meta.models` and resolves to an enabled channel. An
invented placeholder name satisfies the first two checks and fails the third, so
the request dies before reaching the upstream.

**Fix:** when a vendor endpoint carries no model of its own (asset library, delete),
borrow a real model the upstream actually serves, and let operators override it:

```js
const DEFAULT_ROUTE_MODEL = "<a model the upstream really serves>";

function routeModel(ctx) {
  const claimed = trimmed(queryFirst(ctx, "model"));
  if (claimed && Object.prototype.hasOwnProperty.call(VIDEO_MODELS, claimed)) return claimed;
  return DEFAULT_ROUTE_MODEL;
}
```

## 5. The native route takes the vendor's body, not a convenient one

**Symptom:** `400 content is required` (Ark) or an equivalent missing-field error,
even though a request through a host protocol with the same data works.

**Cause:** a plugin that mirrors a vendor's native surface accepts the **vendor's
body**. Testing it through `openai_video` and assuming the native route reshapes
input to match leads to sending `{"prompt": ...}` where the vendor requires
`{"content": [{"type": "text", ...}]}`.

**Fix:** build each native test from the vendor's own field table. These 400s cost
nothing — they are refused before any upstream call — so read the message instead of
assuming the route is broken.

## 6. A free `400` is the cheapest probe for vendor limits

**Symptom:** a paid create fails on a parameter boundary you guessed.

**Cause:** guessing a model's minimum duration, resolution tier, or enum values
instead of reading them.

**Fix:** vendor parameter validation runs **before** the job is created and before
quota is spent. Probe with a deliberately small value and read the message:

```text
duration=2 on doubao-seedance-2-0-mini (t2v) -> 400 InvalidParameter ... received: 2
duration=4 on the same model                  -> 200 {"id":"task_..."}
```

Record the accepted minimum in the plugin's capability table so the next caller
does not repeat the search. The cheapest real verification then becomes one call,
not a series of guesses.

## 7. `extractUsage` returning `null` answers 400 before forwarding

**Symptom:** `400 expr run error: invalid operation: <nil> * float64` on a route
that creates no task.

**Cause:** the host evaluates the model's price expression on every priced route. A
usage field the plugin omits reads as `null` inside that expression and the
evaluation fails before the request is forwarded.

This bites only where the gateway holds a **price expression**. With no expression
configured the route falls back to per-call pricing and `null` looks correct — so
test on a gateway that prices the model by expression, not only on a bare dev
instance.

**Fix:** report every field the profile declares, at zero, on unmetered routes:

```js
if (isPassThroughAction(ctx.action)) return passThroughUsageFacts(ctx);
```

Derive those keys from the same `usageSchema` the model declares so the list cannot
drift.

## 8. Reserved namespaces force a path rewrite

**Symptom:** `404` when mirroring a vendor path exactly.

**Cause:** the host owns `/api`, `/assets`, `/v1/tasks`, `/setup`, `/console`, and
the auth pages. A vendor publishing at `/api/v3/` cannot be mirrored byte-for-byte.

**Fix:** serve it one segment in, under the plugin's own key prefix, and rewrite the
path on the way out. Note that such a route lands at the **upstream root**, not the
upstream plugin prefix — different rule, same family of mistake.

## 9. Channel type 61 reports `kind = "vendor"`

**Symptom:** `Invalid URL` naming a path with the plugin prefix missing, and
everything fails only behind a reseller chain.

**Cause:** a Task Plugin channel (type 61) binds the same plugin key but reports
`kind = "vendor"`, so the plugin drops the prefix and addresses vendor root paths
with vendor auth. A New API channel (type 60) reports `kind = "new_api"`.

**Fix:** bind type 60 for a gateway upstream. When the upstream serves the same path
at both roots the mistake hides: submissions still succeed and only the routes the
upstream publishes under one root fail. Verify the channel type before debugging
path construction.

## 10. A task id the upstream never saw

**Symptom:** `404` quoting an *upstream* "task not found" for a task you did create.

**Cause:** a client sends the gateway's public task id. Every upstream call that
names a task by id must resolve it against `ctx.originTasks` and send
`task.upstreamTaskId` instead.

**Fix:** declare the path parameter in `originTaskIds`, keep one translation point
(`originUpstreamTaskId`), and refuse an id that cannot be resolved rather than
forwarding it.

## 11. CRLF breaks the hash, not the plugin

**Symptom:** install fails with a hash mismatch although the file looks fine.

**Cause:** the gateway hashes the **raw bytes**. A Windows checkout with CRLF line
endings disagrees with the index, which was generated from LF bytes.

**Fix:** keep `* text=auto eol=lf` in `.gitattributes`, and verify with
`scripts/check_index.py`, which reports CRLF explicitly instead of only showing a
hash mismatch.