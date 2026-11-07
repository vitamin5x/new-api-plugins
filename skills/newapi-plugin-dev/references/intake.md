# Intake: what to collect before writing plugin code

Run this intake before designing routes. Everything here changes the plugin's
shape, and a wrong answer discovered after the code is written costs a rewrite of
the descriptor builder — the most security-sensitive part.

Ask in rounds of two to four questions. Never dump the whole list at once: an
administrator answering a wall of questions gives shallow answers to the ones that
matter. Start with round 1, then ask only what the answers made necessary.

## Round 1 — identity and address (always ask)

| Field | Why it decides something | Default if unanswered |
| --- | --- | --- |
| Plugin display name | Shown in the marketplace card, second line under the key. Users pick by this. | Derive from the vendor name |
| `meta.key` | Three things at once: the marketplace identifier, the version **directory name**, and the **route prefix** (`plugins/tasks/<key>/`, routes `/key/...`). | Ask; do not invent |
| Version to publish | Must equal the directory name. New plugin starts at `1.0.0`. | `1.0.0` |
| Upstream base URL | The host the channel's Base URL will point at. Decides whether `kind` is `new_api` or `vendor`. | Ask |

Key constraints, worth stating when the operator proposes a key: `^[a-z0-9][a-z0-9_-]*$`,
at most 30 characters, lowercase only. It is baked into every client's URL — a key
chosen carelessly is expensive to change later, because changing it moves every
route and requires a migration note in the changelog.

## Round 2 — the vendor contract (ask before designing routes)

The single most valuable input is the **vendor's own HTTP documentation**. Ask for
it as a link or a pasted excerpt, and ask for the specific parts:

- **Every endpoint** the plugin should expose: method, path, and what it does.
- **Request body shape**, exactly as documented, including whether parameters sit
  flat or nested (`input` + `parameters` for DashScope, `content` array for Ark).
- **Response shape** for create, for poll, and for errors — the error envelope
  differs per vendor and the plugin passes it through untouched.
- **Status vocabulary**: the vendor's own status strings and which ones are
  terminal (`SUCCESS`/`FAILURE` for Ark and DashScope, others vary).
- **Task id field name**: `id`, `task_id`, or both. The plugin must know which one
  names the task upstream.
- **Model names** the upstream actually serves, and per model: allowed output
  resolutions and the longest duration. Needed for both validation and the pricing
  table.

If no documentation exists, say so and offer to infer the surface from a live probe
of the upstream. A probe reveals what the upstream accepts but not what it
promises; write that difference down in the changelog.

## Round 3 — billing shape (ask before finishing `meta`)

- **How the vendor meters**: per second of output, per token, per call, per
  resolution tier, or a mix. This decides `usageSchema`.
- **What the completion payload reports**: the actual usage numbers. If the vendor
  reports the real quantity, the plugin can settle exactly; if not, it must keep the
  reservation (`extractUsageOnComplete` returns `{}`).
- **Whether reference media changes the price**: Ark tiers by whether a reference
  video was sent; Wan 3.0 bills input plus output duration. This is a
  `usageSchema` field, not a calculation inside the plugin.

The plugin reports **usage facts, never prices**. Never ask what a model costs;
that lives in the gateway's pricing settings.

## Round 4 — upstream topology (ask whenever a reseller chain exists)

This round exists because of the failure that is hardest to diagnose: forwarding to
the wrong plugin prefix.

- Is the channel pointing at the **vendor directly**, or at **another New API
  gateway**?
- If another gateway: **which plugin key is that gateway's copy published under?**
  Not what you plan to call yours — the key it was actually installed with. An
  upstream gateway keeps whatever key it was installed under, even after you rename
  your own plugin, so the two diverge.
- Which **channel type** binds it: 60 (New API) or 61 (Task Plugin)? Type 60 reports
  `kind = "new_api"` and is the only one that takes the prefixed native routes.

Record the answer as a constant in the plugin, and verify it with
`scripts/probe_prefix.py` before writing `apiRoot()`.

## Round 5 — packaging details (ask last, cheap to change)

- **Logo**: a sidecar `icon.svg` or `icon.png` beside the version directories. Ask
  for the file, or fall back to `meta.icon` using a LobeHub name
  (`Ark.Color`, `Bailian.Color`) or `text:<label>`.
- **Display description** in English and Chinese, one sentence, describing what a
  user can do — not the parameter inventory.
- **Whether a host protocol is needed** (`openai_video`, `openai_responses`). Only
  claim a protocol the plugin actually implements; a claimed protocol without its
  hooks fails validation.

## What not to ask

- **Prices.** The gateway configures those; the plugin only reports facts.
- **Credentials.** Never collect an upstream API key. The channel stores it, and
  the host injects it; the plugin never sees or logs it.
- **Which repository to publish to.** Detect that from the working directory
  instead of asking.