// <Vendor> <product> through an upstream New API gateway.
//
// Copy this file to plugins/tasks/<key>/<version>/plugin.js and replace every
// <PLACEHOLDER>. Read references/pitfalls.md before changing apiRoot().
//
// The plugin exists so a downstream client can keep the paths and request bodies
// it already sends while the gateway meters the calls. Requests arrive on
// /<key>/<vendor path> and leave for the upstream, whose address is built below.
//
// The public path is this plugin's own stable address. The upstream path is an
// implementation detail that may move without a client change, so the two are
// kept apart on purpose.

// ---------------------------------------------------------------------------
// Capability table
// ---------------------------------------------------------------------------
//
// What each model offers, not what it costs. Prices live in the gateway's
// pricing settings; the plugin reports usage facts only.
//
// One table drives meta.models, the per-model validation, and usageProfiles, so
// the pricing surface cannot drift from what the plugin accepts.

const VIDEO_MODELS = {
  "<model-name>": { resolutions: ["<480p>", "<720p>"], maxDuration: <15>, media: <true|false> },
};

// Resolutions any declared model may be asked for. Used when a request reaches
// the plugin under an endpoint id that matches no declared name.
const ALL_RESOLUTIONS = ["<480p>", "<720p>"];
const DEFAULT_VIDEO_PROFILE = { resolutions: ALL_RESOLUTIONS, maxDuration: <30>, media: <true|false> };

// The longest output a request may reserve quota for, whatever the model.
const MAX_RESERVED_SECONDS = <30>;

// ---------------------------------------------------------------------------
// Upstream addressing — the two rules, and the trap
// ---------------------------------------------------------------------------
//
// Rule 1: the vendor's own task API lives at its host root, or under a path the
// vendor publishes. It does not live under a plugin prefix.
//
// Rule 2: an upstream New API gateway serves a plugin's routes under the key
// that plugin was INSTALLED with. That is the upstream's key, which is NOT
// necessarily your meta.key: an upstream gateway keeps whatever key it was
// installed under, even after you renamed your own plugin.
//
// Getting rule 2 wrong is silent. The upstream answers its single-page-app
// fallback with 200 and an HTML body, and the host reports only:
//     502 server_error / Task request failed
// Verify the prefix with scripts/probe_prefix.py before trusting this constant.

// TODO: set to the upstream gateway's key for this plugin, or "" when the vendor
// is addressed directly at its host root.
const UPSTREAM_PLUGIN_PREFIX = "</upstream-key>";

// The vendor path below that prefix, e.g. "/api/v3/contents/generations/tasks".
const UPSTREAM_TASK_PATH = "</api/.../tasks>";

function apiRoot(ctx) {
  // kind === "new_api": the channel points at another New API gateway.
  // otherwise: the channel points at the vendor directly.
  return ctx.baseUrl + (ctx.upstream && ctx.upstream.kind === "new_api" ? UPSTREAM_PLUGIN_PREFIX : "");
}

// Routes that the vendor publishes at its host root on every upstream kind (an
// asset library, for example) are addressed at ctx.baseUrl with no prefix.
function assetRoot(ctx) {
  return ctx.baseUrl;
}

function taskRoot(ctx) {
  return apiRoot(ctx) + UPSTREAM_TASK_PATH;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function trimmed(value) {
  return String(value || "").trim();
}

function objectValue(value, name) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(name + " must be an object");
  return value;
}

// The model identity a request is billed and reported under. Channel mapping may
// send a declared name to another model name; the declared name still describes
// that model, so profiles resolve against both.
function modelCandidates(ctx) {
  const body = (ctx && ctx.body && ctx.body.kind === "json" && ctx.body.value) || {};
  const requestBody = (ctx && ctx.requestBody) || {};
  return [ctx && ctx.upstreamModel, ctx && ctx.model, body.model, requestBody.model].map(trimmed).filter(Boolean);
}

function videoProfile(ctx) {
  for (const model of modelCandidates(ctx)) {
    if (Object.prototype.hasOwnProperty.call(VIDEO_MODELS, model)) return VIDEO_MODELS[model];
  }
  return DEFAULT_VIDEO_PROFILE;
}

// Reject an output tier the model does not offer before any quota is reserved.
function requestResolution(ctx, body) {
  const asked = trimmed(body && (body.resolution || (body.parameters && body.parameters.resolution)));
  if (!asked) return videoProfile(ctx).resolutions[0];
  const upper = asked.toUpperCase();
  const allowed = videoProfile(ctx).resolutions;
  for (const value of allowed) if (trimmed(value).toUpperCase() === upper) return value;
  throw new Error("resolution " + asked + " is not available for this model; use " + allowed.join(", "));
}

function requestSeconds(ctx, body) {
  const raw = body && (body.duration !== undefined ? body.duration : body.seconds);
  // -1 lets the model pick the length; only a plugin that declares
  // duration-auto@1 may send it, and it then reserves the longest clip.
  if (raw === -1 || trimmed(raw) === "-1") return -1;
  const seconds = Number.parseInt(trimmed(raw), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return -1;
  const longest = videoProfile(ctx).maxDuration;
  if (seconds > longest) throw new Error("duration must not exceed " + longest + " seconds");
  return seconds;
}

// The quota hold. A request that leaves the length to the model holds the longest
// clip the model can produce; the real number is settled on completion.
function reservedSeconds(seconds, profile) {
  return seconds === -1 ? profile.maxDuration : seconds;
}

function upstreamHeaders(ctx) {
  const headers = { "Content-Type": "application/json" };
  const key = trimmed(ctx && ctx.channelKey);
  if (key) headers.Authorization = "Bearer " + key;
  return headers;
}

// ---------------------------------------------------------------------------
// Reading the vendor's body
// ---------------------------------------------------------------------------
//
// These two are the only vendor-body-specific part of the plugin. Replace their
// internals with the shape the vendor actually documents, and leave the shape the
// client sends untouched everywhere else.

// The prompt, from wherever the vendor puts it.
//
// TODO: keep the branch that matches your vendor and delete the rest.
//   Ark       {"content": [{"type": "text", "text": "..."}]}
//   DashScope {"input": {"prompt": "..."}}
function extractPrompt(body) {
  // Flat `content` array (Ark): join every text item.
  if (Array.isArray(body.content)) {
    const texts = [];
    for (const item of body.content) {
      if (item && item.type === "text" && typeof item.text === "string") texts.push(item.text);
    }
    if (texts.length) return texts.filter(trimmed).join("\n");
  }
  // Nested under `input` (DashScope).
  const input = body.input;
  if (input && typeof input === "object" && !Array.isArray(input)) return trimmed(input.prompt);
  // Flat string field, used by several vendors.
  return trimmed(body.prompt);
}

// Whether the request carries reference media, which changes the action and
// usually the price tier.
//
// TODO: match your vendor's field names.
//   Ark       content items of type image_url / video_url
//   DashScope input.media = [{type, url}, ...]
function hasReferenceMedia(body) {
  if (Array.isArray(body.content)) {
    for (const item of body.content) {
      if (item && (item.type === "image_url" || item.type === "video_url")) return true;
    }
  }
  const input = body.input;
  if (input && typeof input === "object" && Array.isArray(input.media) && input.media.length) return true;
  if (Array.isArray(body.images) && body.images.length) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Native surface
// ---------------------------------------------------------------------------
//
// createTask decodes the client's body into one normalized intent. Everything
// downstream of it consumes the intent, never the raw body, so the drivers stay
// surface-independent.

export const native = {
  createTask: function (ctx) {
    if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
    const body = objectValue(ctx.body.value, "request body");

    const model = trimmed(body.model);
    if (!model) throw new Error("model is required");
    if (!Object.prototype.hasOwnProperty.call(VIDEO_MODELS, model))
      throw new Error("model " + model + " is not served by this plugin");

    // Read prompt and media out of the vendor's OWN body shape. Ark puts the
    // prompt in a flat `content` array; DashScope nests everything under `input`.
    // Never reshape it: a client sends what the vendor documents, and the native
    // route must accept exactly that.
    const prompt = extractPrompt(body);
    const hasMedia = hasReferenceMedia(body);
    // Fail loudly rather than forwarding an empty prompt. A silent empty string
    // produces a real, billable generation of nothing, which is far worse than a
    // 400 — and it is invisible until someone reads the bill.
    if (!trimmed(prompt) && !hasMedia) throw new Error("prompt or reference media is required");

    const requestBody = Object.assign({}, body, {
      model: model,
      prompt: prompt,
      seconds: requestSeconds(ctx, body),
    });

    return {
      kind: "submit",
      model: model,
      action: hasMedia ? "image_to_video" : "text_to_video",
      requestBody: requestBody,
    };
  },

  taskCreated: function (ctx, task) {
    const data = task.data && typeof task.data === "object" && !Array.isArray(task.data) ? task.data : {};
    return Object.assign({}, data, { id: task.task_id });
  },

  taskStatus: function (ctx, task) {
    if (task.data && typeof task.data === "object" && !Array.isArray(task.data))
      return Object.assign({}, task.data, { id: task.task_id });
    const statusMap = { <VENDOR_PENDING>: "queued", <VENDOR_RUNNING>: "running", <VENDOR_SUCCESS>: "succeeded", <VENDOR_FAILURE>: "failed" };
    const output = { id: task.task_id, status: statusMap[task.status] || "queued" };
    if (task.fail_reason) output.error = { message: task.fail_reason };
    return output;
  },

  error: function (ctx, error) {
    return { error: { code: error.code, message: error.message } };
  },
};

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

export function buildSubmitRequest(ctx) {
  const body = ctx.requestBody || {};
  return {
    url: taskRoot(ctx),
    method: "POST",
    headers: upstreamHeaders(ctx),
    // Sent through unchanged so the upstream sees exactly what the vendor
    // documents. A body is mandatory on this route: see pitfalls.md #3.
    body: body,
    action: trimmed(ctx.action) || "text_to_video",
    rewriteModel: body.model,
  };
}

export function parseSubmitResponse(ctx, resp) {
  const body = resp.body;
  // Pass the vendor's error envelope's message along, not the envelope itself, so
  // the caller can read the reason.
  if (body && typeof body === "object" && !Array.isArray(body) && body.error && typeof body.error === "object")
    throw new Error(
      (trimmed(body.error.code || body.error.Code) || "upstream_error") +
        ": " +
        (trimmed(body.error.message || body.error.Message) || "upstream request failed")
    );
  // TODO: the field that names the task upstream. Some vendors answer both `id`
  // and `task_id`; accept either rather than assuming one.
  const taskId = trimmed(body && (body.id || body.task_id));
  if (!taskId) throw new Error("task id is empty in the upstream response");
  return { taskId: taskId, taskData: body };
}

// The upstream id the host resolved for the task. A query reaches the plugin with
// ctx.taskId already translated, so use it as-is; the fallback keeps a host that
// only publishes the public id from addressing a task the upstream never saw.
function upstreamTaskId(ctx) {
  const resolved = trimmed(ctx && ctx.taskId);
  if (resolved) return resolved;
  const publicId = trimmed(ctx && ctx.publicTaskId);
  if (!publicId) throw new Error("task_id is required");
  return publicId;
}

export function buildQueryRequest(ctx) {
  return {
    url: taskRoot(ctx) + "/" + encodeURIComponent(upstreamTaskId(ctx)),
    method: "GET",
    headers: upstreamHeaders(ctx),
  };
}

export function parseTaskResult(ctx, body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { status: "UNKNOWN", reason: "invalid upstream task payload" };

  const status = trimmed(body.status).toLowerCase();
  if (status === "queued" || status === "pending" || status === "submitted")
    return { status: "QUEUED", progress: "10%" };
  if (status === "running" || status === "processing" || status === "in_progress")
    return { status: "IN_PROGRESS", progress: "50%" };

  if (status === "succeeded" || status === "success") {
    const content = objectValue(body.content, "content");
    const result = { status: "SUCCESS", progress: "100%", url: trimmed(content.video_url || content.url) };
    const usage = body.usage || {};
    const completionTokens = Number(usage.completion_tokens);
    const totalTokens = Number(usage.total_tokens);
    if (Number.isFinite(completionTokens) && completionTokens > 0) result.completionTokens = completionTokens;
    if (Number.isFinite(totalTokens) && totalTokens > 0) result.totalTokens = totalTokens;
    return result;
  }

  if (status === "failed" || status === "failure" || status === "expired" || status === "cancelled") {
    const reason = body.error && (body.error.message || body.error.Message) ? body.error.message || body.error.Message : status;
    return { status: "FAILURE", progress: "100%", reason: reason };
  }

  return { status: "UNKNOWN", reason: "unrecognized status: " + String(body.status || "") };
}

export function listArtifacts(task) {
  if (task.status !== "SUCCESS") return [];
  const data = task.data || {};
  const content = data.content || {};
  return trimmed(content.video_url || content.url) ? [{ key: "video", type: "video" }] : [];
}

export function buildContentRequest(ctx) {
  const data = ctx.data || {};
  const content = data.content || {};
  const url = trimmed(content.video_url || content.url);
  if (!url) throw new Error("artifact_not_found");
  // credentialless: the artifact is a signed vendor URL, so the channel's key must
  // not be attached to a request for it.
  return { url: url, method: ctx.clientRequest.method, credentialless: true };
}

// ---------------------------------------------------------------------------
// Usage facts
// ---------------------------------------------------------------------------
//
// Facts, never prices. Every field the usageSchema declares must be present, at
// zero where nothing is metered: an omitted field reads as null inside the
// gateway's price expression and fails with
//     invalid operation: <nil> * float64
// before the request is even forwarded. See pitfalls.md #7.

export function extractUsage(ctx) {
  const body = ctx.requestBody || {};
  const profile = videoProfile(ctx);
  const seconds = requestSeconds(ctx, body);
  // The hold covers the longest clip when the length is left to the model.
  return {
    seconds: reservedSeconds(seconds, profile),
    resolution: requestResolution(ctx, body),
  };
}

// The bill. Return {} to keep the reservation when the vendor does not report a
// trustworthy real quantity; return the settled facts when it does.
export function extractUsageOnComplete(task, taskResult, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  if (trimmed(body.status).toLowerCase() !== "succeeded" && trimmed(body.status).toLowerCase() !== "success") return {};

  const facts = {};
  const usage = body.usage || {};
  // TODO: the field that reports produced length. Only settle when it is a
  // finite non-negative number; otherwise leave the fact out and keep the hold.
  const outputSeconds = usage.<output_duration_field>;
  if (typeof outputSeconds === "number" && Number.isFinite(outputSeconds) && outputSeconds >= 0) {
    facts.seconds = outputSeconds;
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export const meta = {
  apiVersion: 1,
  key: "<key>", // must equal the version directory name
  name: "<Display Name>", // the marketplace card's second line
  // A LobeHub icon name, or "text:<label>". A sidecar icon.svg / icon.png beside
  // the version directories takes priority over this.
  icon: "<Vendor.Color>",
  description: {
    en: "<One sentence: what a user can do through this plugin.>",
    zh: "<一句话：用户通过这个插件能做什么。>",
  },
  version: "<1.0.0>", // must equal the version directory name
  author: { name: "<author>" },
  models: Object.keys(VIDEO_MODELS),
  fetchMode: "per_task",
  // Declare new_api only when the plugin implements the prefixed native routes for
  // an upstream gateway; it is what makes the plugin bindable to a type-60 channel.
  upstreams: ["new_api"],
  usageSchema: {
    // Billable seconds: output duration, or input plus output where the vendor
    // bills reference video separately.
    seconds: {
      type: "number",
      unit: "second",
      description: { en: "Video generation unit price", zh: "视频生成单价" },
    },
    resolution: {
      enum: ALL_RESOLUTIONS,
      enumLabels: {
        // One entry per enum value; both locales are required.
        "<480p>": { en: "<480p>", zh: "<480p>" },
        "<720p>": { en: "<720p>", zh: "<720p>" },
      },
      description: { en: "Output video resolution", zh: "输出视频分辨率" },
    },
  },
  usageExamples: [
    { label: "<480p> · 5s", facts: { seconds: 5, resolution: "<480p>" } },
    { label: "<720p> · 10s", facts: { seconds: 10, resolution: "<720p>" } },
  ],
  usageProfiles: [
    {
      models: Object.keys(VIDEO_MODELS),
      // Repeat the schema rather than referencing the outer object: a profile
      // carries its complete schema so a consumer never has to merge two.
      schema: {
        seconds: {
          type: "number",
          unit: "second",
          description: { en: "Video generation unit price", zh: "视频生成单价" },
        },
        resolution: {
          enum: ALL_RESOLUTIONS,
          enumLabels: {
            "<480p>": { en: "<480p>", zh: "<480p>" },
            "<720p>": { en: "<720p>", zh: "<720p>" },
          },
          description: { en: "Output video resolution", zh: "输出视频分辨率" },
        },
      },
      examples: [
        { label: "<480p> · 5s", facts: { seconds: 5, resolution: "<480p>" } },
        { label: "<720p> · 10s", facts: { seconds: 10, resolution: "<720p>" } },
      ],
    },
  ],
  routes: [
    // The first path segment MUST equal this plugin's key, or the gateway refuses
    // to register the route. query routes take no body; submit and dynamic routes
    // always send one.
    { method: "POST", path: "/<key>/<vendor create path>", type: "submit", decode: "createTask", render: "taskCreated" },
    { method: "GET", path: "/<key>/<vendor create path>/:task_id", type: "query", render: "taskStatus" },
  ],
};