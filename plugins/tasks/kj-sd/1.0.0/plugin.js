// Ark (Volcengine Volcano Ark) video generation, addressed through an upstream
// New API gateway that serves the same Ark wire format.
//
// The plugin exists so a downstream client can keep the paths, request bodies
// and response envelopes printed in the Ark API documentation unchanged while
// the gateway meters the calls. Requests arrive on /kj-sd/api/v3/... and leave
// for the upstream gateway's own copy of the same addresses: a New API gateway
// that has this plugin installed serves them under that plugin's key, which is
// /ark, and Ark itself serves the video task API at its host root.
//
// The asset library is the exception. Ark publishes it at the host root
// (/api/v3/?Action=...), never below a plugin prefix, so it is addressed at the
// upstream root on every upstream kind.
//
// A task id a client sends is this gateway's own public id. Every upstream call
// that names a task by id resolves it against the origin tasks the host
// synthesises, so the private upstream id travels instead of the public one.
//
// Every route here is metered against a name from the Seedance table below,
// including the asset-library and delete routes, whose documented shapes carry
// no model at all. See DEFAULT_ROUTE_MODEL for why no placeholder name may be
// used instead.
//
// Capability tables below describe what each Seedance model offers, not what it
// costs: output resolutions, the longest output duration, whether reference
// video input is accepted (Seedance 2.x prices video-to-video tokens apart) and
// whether audio output is priced apart.

const VIDEO_MODELS = {
  "doubao-seedance-2-0-260128": { resolutions: ["480p", "720p", "1080p", "4k"], maxDuration: 15, videoInput: true },
  "doubao-seedance-2-0-fast-260128": { resolutions: ["480p", "720p"], maxDuration: 15, videoInput: true },
  "doubao-seedance-2-0-mini-260615": { resolutions: ["480p", "720p"], maxDuration: 15, videoInput: true },
  "doubao-seedance-2-5-260628": { resolutions: ["480p", "720p", "1080p"], maxDuration: 30, videoInput: true },
};
// Every Ark tier; an endpoint ID reached through channel mapping without a
// declared profile keeps them all and the longest Seedance duration.
const SEEDANCE_RESOLUTIONS = ["480p", "720p", "1080p", "4k"];
const DEFAULT_VIDEO_PROFILE = { resolutions: SEEDANCE_RESOLUTIONS, maxDuration: 30, videoInput: true };

// Asset library actions that create no task: they answer once and leave no row
// to poll. They are served on the same dynamic route as the task endpoints and
// pass through to the upstream asset API.
const ASSET_ACTIONS = [
  "CreateAsset",
  "GetAsset",
  "ListAssets",
  "UpdateAsset",
  "DeleteAsset",
  "CreateAssetGroup",
  "GetAssetGroup",
  "ListAssetGroups",
  "UpdateAssetGroup",
  "DeleteAssetGroup",
  "CreateVisualValidateSession",
  "GetVisualValidateResult",
];
const ASSET_VERSION = "2024-01-01";

// Ark's asset library and task-deletion calls carry no model: the documented
// shapes are POST /api/v3/?Action=... and DELETE .../tasks/{task_id}. This
// gateway still needs one, because a model is what picks the channel, so the
// plugin supplies the name below whenever the caller did not name a model
// itself.
//
// It must be a model the upstream gateway really serves. A name the upstream
// does not know selects no channel and the request dies at the gateway with
// "no available channel" before it ever reaches the upstream, so inventing a
// private placeholder name here breaks every asset and delete call.
const DEFAULT_ROUTE_MODEL = "doubao-seedance-2-0-mini-260615";

// The model a model-less route (asset library, task deletion) reports. A caller
// may still pick any declared model with ?model= on the query string, which lets
// an operator meter these routes against a different model than the default.
// Only names this plugin declares are accepted, so a stray value cannot route
// the request to a model the channel was never configured for.
function routeModel(ctx) {
  const claimed = trimmed(queryFirst(ctx, "model"));
  if (claimed && Object.prototype.hasOwnProperty.call(VIDEO_MODELS, claimed)) return claimed;
  return DEFAULT_ROUTE_MODEL;
}

function trimmed(value) {
  return String(value || "").trim();
}

// The video task API. Ark publishes it at its host root; a New API gateway that
// has this plugin installed serves the same addresses under the upstream
// plugin's own native prefix, which is its key. This is the upstream's key, not
// this plugin's: our own public prefix is /kj-sd, and the copy of this plugin
// running on the upstream gateway is published as /ark, so the forwarded call
// must carry /ark.
const UPSTREAM_PLUGIN_PREFIX = "/ark";

function apiRoot(ctx) {
  return ctx.baseUrl + (ctx.upstream && ctx.upstream.kind === "new_api" ? UPSTREAM_PLUGIN_PREFIX : "");
}

// The asset library and the liveness session live at the upstream host root on
// every upstream kind: Ark publishes them at /api/v3/?Action=... and never
// below the upstream plugin prefix, so a gateway's plugin prefix does not carry
// them either.
function assetRoot(ctx) {
  return ctx.baseUrl;
}

function objectValue(value, name) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(name + " must be an object");
  return value;
}

function queryFirst(ctx, name) {
  const values = (ctx.query || {})[name];
  return Array.isArray(values) && values.length ? trimmed(values[0]) : "";
}

// The model identity a request is billed and reported under. Channel mapping
// may send a declared name to an Ark endpoint ID; the declared name still
// describes that endpoint, so profiles resolve against both.
function modelCandidates(ctx) {
  const body = (ctx && ctx.body && ctx.body.kind === "json" && ctx.body.value) || {};
  return [ctx && ctx.upstreamModel, ctx && ctx.model, body.model].map(trimmed).filter(Boolean);
}

function videoProfile(ctx) {
  for (const model of modelCandidates(ctx)) {
    if (Object.prototype.hasOwnProperty.call(VIDEO_MODELS, model)) return VIDEO_MODELS[model];
  }
  return DEFAULT_VIDEO_PROFILE;
}

function normalizeResolution(value) {
  const raw = trimmed(value).toLowerCase();
  if (SEEDANCE_RESOLUTIONS.includes(raw)) return raw;
  const parts = raw.replace("*", "x").split("x");
  if (parts.length !== 2) return "";
  const max = Math.max(Number(parts[0]), Number(parts[1]));
  if (!Number.isFinite(max) || max <= 0) return "";
  if (max >= 3840) return "4k";
  if (max >= 1920) return "1080p";
  if (max >= 1280) return "720p";
  return "480p";
}

function hasVideo(content) {
  return Array.isArray(content) && content.some((item) => item && (item.type === "video_url" || Object.prototype.hasOwnProperty.call(item, "video_url")));
}

// Resolution tier the reservation is estimated at: the requested tier, or the
// tier of a WxH size, rejecting tiers the model does not offer. A request that
// leaves the resolution to Ark reserves the model's highest tier up to 1080p;
// completion overlays the delivered resolution.
function videoResolution(ctx) {
  const req = ctx.requestBody || {};
  const metadata = req.metadata || {};
  const profile = videoProfile(ctx);
  const raw = trimmed(metadata.resolution || req.size).toLowerCase();
  const recognized = SEEDANCE_RESOLUTIONS.includes(raw) || raw.replace("*", "x").split("x").length === 2;
  if (!recognized) return profile.resolutions.includes("1080p") ? "1080p" : profile.resolutions[profile.resolutions.length - 1];
  const resolution = normalizeResolution(raw);
  if (!profile.resolutions.includes(resolution))
    throw new Error(trimmed(ctx.upstreamModel || ctx.model) + " resolution must be one of " + profile.resolutions.join(", "));
  return resolution;
}

// Max-pixel 16:9 dimensions per tier, so the submit-time estimate overestimates
// rather than underestimates when ratio is absent or adaptive. Official Ark
// formula: tokens = seconds x width x height x 24 / 1024.
function resolutionMaxPixels(resolution) {
  if (resolution === "480p") return [854, 480];
  if (resolution === "1080p") return [1920, 1080];
  if (resolution === "4k") return [3840, 2160];
  return [1280, 720];
}

function estimateTokens(seconds, resolution) {
  const dims = resolutionMaxPixels(resolution);
  return (seconds * dims[0] * dims[1] * 24) / 1024;
}

function draftTaskIds(content) {
  const ids = [];
  if (!Array.isArray(content)) return ids;
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.type !== "draft_task") continue;
    const draft = item.draft_task;
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) continue;
    const id = trimmed(draft.id);
    if (id) ids.push(id);
  }
  return ids;
}

// The private upstream id behind a gateway task the plugin was told about.
// Every id a client sends — a draft reference, the task a DELETE names — is
// this gateway's own public id, which the upstream has never seen, so it only
// works after this translation.
function originUpstreamTaskId(publicId, originTasks) {
  if (!Array.isArray(originTasks)) return "";
  const wanted = trimmed(publicId);
  if (!wanted) return "";
  for (const task of originTasks) {
    if (task && trimmed(task.taskId) === wanted) return trimmed(task.upstreamTaskId);
  }
  return "";
}

// A draft reference names a gateway task; the upstream call needs the private
// upstream id, which only the host can resolve from the pinned origin tasks.
// A task that cannot be resolved is refused, because forwarding the public id
// would reach the upstream as an unknown task.
function rewriteDraftTaskContent(content, originTasks) {
  if (!Array.isArray(content)) return content;
  return content.map(function (item) {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "draft_task") return item;
    const draft = item.draft_task;
    if (!draft || typeof draft !== "object" || Array.isArray(draft) || !trimmed(draft.id)) return item;
    const upstream = originUpstreamTaskId(draft.id, originTasks);
    if (!upstream) throw new Error("origin task is unavailable");
    return Object.assign({}, item, { draft_task: Object.assign({}, draft, { id: upstream }) });
  });
}

// Usage facts for one Seedance capability profile, so the pricing table lists
// only the resolutions and input kinds the model actually offers.
function seedanceUsageSchema(profile) {
  const resolutionLabels = {};
  for (const resolution of profile.resolutions) resolutionLabels[resolution] = { en: resolution, zh: resolution };
  const schema = {
    tokens: {
      type: "number",
      unit: "token",
      description: { en: "Upstream billing token unit price", zh: "上游计费 Token 单价" },
    },
    resolution: {
      enum: profile.resolutions,
      enumLabels: resolutionLabels,
      description: { en: "Output video resolution", zh: "输出视频分辨率" },
    },
  };
  if (profile.videoInput) {
    schema.video_input = {
      enum: ["none", "video"],
      enumLabels: { none: { en: "No reference video", zh: "无参考视频" }, video: { en: "With reference video", zh: "有参考视频" } },
      description: { en: "Reference video input", zh: "参考视频输入" },
    };
  }
  return schema;
}

// Display examples for a token-priced profile: five-second clips at each tier,
// plus the reference-video variant the profile prices.
function seedanceUsageExamples(profile) {
  const specs = profile.resolutions.map((resolution) => ({ label: resolution + " · 5s", resolution: resolution, seconds: 5 }));
  if (profile.videoInput) specs.push({ label: "720p · 5s (+4s 输入视频)", resolution: "720p", seconds: 9, video_input: "video" });
  return specs.map((spec) => {
    const facts = { tokens: Math.round(estimateTokens(spec.seconds, spec.resolution)), resolution: spec.resolution };
    if (profile.videoInput) facts.video_input = spec.video_input || "none";
    return { label: spec.label, facts: facts };
  });
}

// One usage profile per distinct pricing shape, so models whose schema and
// examples coincide share a profile.
function capabilityUsageProfiles(models, usageSchema, usageExamples) {
  const profiles = [];
  for (const model of Object.keys(models)) {
    const schema = usageSchema(models[model]);
    const examples = usageExamples(models[model]);
    const shape = JSON.stringify([schema, examples]);
    let profile = profiles.find((entry) => entry.shape === shape);
    if (!profile) {
      profile = { shape: shape, models: [], schema: schema, examples: examples };
      profiles.push(profile);
    }
    profile.models.push(model);
  }
  return profiles.map((profile) => ({ models: profile.models, schema: profile.schema, examples: profile.examples }));
}

export const meta = {
  apiVersion: 1,
  key: "kj-sd",
  name: "kuajing Ark",
  icon: "Ark.Color",
  description: {
    en: "Volcengine Ark Seedance video generation and asset library through an upstream New API gateway",
    zh: "经上游 New API 网关接入的火山方舟 Seedance 视频生成与素材库",
  },
  version: "1.0.0",
  author: { name: "opcopilot" },
  // Only the real Seedance models. The asset-library and task-deletion routes
  // reuse one of them instead of declaring a placeholder of their own, because
  // an upstream gateway only routes a model it actually serves.
  models: Object.keys(VIDEO_MODELS),
  fetchMode: "per_task",
  // Only the gateway form is wired: the plugin addresses another gateway that
  // has this plugin installed, plus the upstream root the asset library lives
  // on. Ark itself serves the video task API at its host root.
  upstreams: ["new_api"],
  requiredCapabilities: ["duration-auto@1"],
  usageSchema: seedanceUsageSchema(DEFAULT_VIDEO_PROFILE),
  usageExamples: seedanceUsageExamples(DEFAULT_VIDEO_PROFILE),
  usageProfiles: capabilityUsageProfiles(VIDEO_MODELS, seedanceUsageSchema, seedanceUsageExamples),
  routes: [
    // Ark's own paths. The gateway registers each one as declared, because the
    // first segment matches this plugin's key.
    { method: "POST", path: "/kj-sd/api/v3/contents/generations/tasks", type: "submit", decode: "createTask", render: "taskCreated" },
    { method: "GET", path: "/kj-sd/api/v3/contents/generations/tasks/:task_id", type: "query", render: "taskStatus" },
    // The asset library keeps Ark's shape but cannot keep its root address: the
    // host reserves /api, so a plugin route may never be published there. It is
    // served one segment in, on this plugin's own prefix, and forwarded to the
    // upstream host root, where Ark does publish it. Every asset action answers
    // once and leaves nothing to re-query, so its snapshot is never persisted.
    { method: "POST", path: "/kj-sd/api/v3/", type: "dynamic", decode: "decodeAssetAction", render: "renderAssetAction", retainResult: false },
    // Deleting a finished task creates no task either; it is forwarded to
    // this plugin's own path on the upstream gateway, which answers 204 with
    // no body.
    { method: "DELETE", path: "/kj-sd/api/v3/contents/generations/tasks/:task_id", type: "dynamic", decode: "decodeTaskDelete", render: "renderTaskDelete", retainResult: false },
  ],
  protocols: [
    { name: "openai_responses", supports: ["stream", "sync", "background"] },
    { name: "openai_video", models: Object.keys(VIDEO_MODELS) },
  ],
};

function isAssetAction(action) {
  return ASSET_ACTIONS.includes(action);
}

// Actions that answer inline and create no task: the whole asset library plus
// task deletion.
function isPassThroughAction(action) {
  return isAssetAction(action) || action === "delete_task";
}

// Headers for an upstream call on a New API channel. The host has already put
// the gateway token in ctx.apiKey; Ark's own AK/SK signing never applies here.
function upstreamHeaders(ctx) {
  return { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + ctx.apiKey };
}

// Task creation in Ark's documented shape. The decoded intent carries an
// internal prompt/metadata split that the driver reassembles, so the native
// route, /v1/videos and /v1/responses all share one submission path.
export const native = {
  createTask: function (ctx) {
    if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
    const body = ctx.body.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("request body must be an object");
    const model = trimmed(body.model);
    if (!model) throw new Error("model is required");
    if (body.content !== undefined && !Array.isArray(body.content)) throw new Error("content must be an array");
    const content = Array.isArray(body.content) ? body.content : [];
    const texts = [];
    let hasReference = false;
    for (const item of content) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      if (item.type === "text" && typeof item.text === "string") texts.push(item.text);
      else hasReference = true;
    }
    if (!texts.length && !hasReference) throw new Error("content is required");
    const requestBody = {
      model: model,
      prompt: texts
        .filter(function (text) {
          return trimmed(text);
        })
        .join("\n"),
      metadata: body,
    };
    const seconds = Number(body.duration);
    if (Number.isFinite(seconds) && seconds > 0) requestBody.seconds = seconds;
    const intent = { kind: "submit", model: model, action: hasReference ? "image_to_video" : "text_to_video", requestBody: requestBody };
    const originTaskIds = draftTaskIds(content);
    if (originTaskIds.length) intent.originTaskIds = originTaskIds;
    return intent;
  },
  taskCreated: function (ctx, task) {
    const data = task.data && typeof task.data === "object" && !Array.isArray(task.data) ? task.data : {};
    return Object.assign({}, data, { id: task.task_id });
  },
  taskStatus: function (ctx, task) {
    if (task.data && typeof task.data === "object" && !Array.isArray(task.data)) return Object.assign({}, task.data, { id: task.task_id });
    const statusMap = { NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued", IN_PROGRESS: "running", SUCCESS: "succeeded", FAILURE: "failed" };
    const output = { id: task.task_id, status: statusMap[task.status] || "queued" };
    if (task.fail_reason) output.error = { message: task.fail_reason };
    return output;
  },
  // Asset actions answer inline: the plugin returns a terminal SUCCESS whose
  // task data is the upstream envelope, and the route declares no retained
  // result because there is no task behind it to re-query.
  //
  // Ark's own request carries no model, but this gateway routes on one, so a
  // real declared Seedance model is reported. It reserves no quota:
  // extractUsage reports zero usage for an asset action, so nothing is
  // metered.
  decodeAssetAction: function (ctx) {
    const action = queryFirst(ctx, "Action");
    if (!isAssetAction(action)) throw new Error("unsupported Ark Action: " + (action || "(missing)"));
    if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
    const body = ctx.body.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("request body must be an object");
    const version = queryFirst(ctx, "Version") || ASSET_VERSION;
    return {
      kind: "submit",
      model: routeModel(ctx),
      action: action,
      requestBody: { action: action, version: version, body: body },
    };
  },
  // Ark wraps every asset response in a Result envelope and reports failures in
  // a top-level error object. Both pass through untouched, so a client reads
  // exactly what the vendor returned.
  renderAssetAction: function (ctx, task) {
    return task.data && typeof task.data === "object" && !Array.isArray(task.data) ? task.data : {};
  },
  // Deleting a task answers 204 with no body, so the pass-through shape carries
  // the empty result through the same route type. The request carries no model
  // of its own, so a real declared one is reported for the same reason as the
  // asset actions above.
  //
  // The task id in the path is this gateway's own public id. Declaring it as an
  // origin task makes the host resolve and pin the task the id names, which is
  // what hands the plugin the private upstream id the upstream call needs.
  // Without it the public id is forwarded verbatim and the upstream answers
  // that no such task exists.
  decodeTaskDelete: function (ctx) {
    const params = ctx.params || {};
    const taskId = trimmed(params.task_id);
    if (!taskId) throw new Error("task_id is required");
    return { kind: "submit", model: routeModel(ctx), action: "delete_task", requestBody: { taskId: taskId }, originTaskIds: [taskId] };
  },
  renderTaskDelete: function (ctx, task) {
    const data = task.data && typeof task.data === "object" && !Array.isArray(task.data) ? task.data : {};
    return data;
  },
  error: function (ctx, error) {
    return { error: { code: error.code, message: error.message } };
  },
};

// Asset actions, task deletion and video submissions all funnel through one
// descriptor builder so path construction and headers stay in a single place.
export function buildSubmitRequest(ctx) {
  const action = trimmed(ctx.action);
  if (isAssetAction(action)) {
    const req = ctx.requestBody || {};
    const version = trimmed(req.version) || ASSET_VERSION;
    return {
      // Ark publishes the asset library at the host root on every upstream
      // kind, so this prefix is not the video task prefix.
      url: assetRoot(ctx) + "/api/v3/?Action=" + encodeURIComponent(action) + "&Version=" + encodeURIComponent(version),
      method: "POST",
      headers: upstreamHeaders(ctx),
      body: req.body === undefined ? {} : req.body,
    };
  }
  if (action === "delete_task") {
    const req = ctx.requestBody || {};
    const publicId = trimmed(req.taskId);
    // The client names a gateway task; the upstream only knows the private id
    // the host resolved for it. A gateway that never recorded one is deleting a
    // task it does not own, which is refused rather than forwarded as an
    // upstream call that can only fail.
    const upstreamId = originUpstreamTaskId(publicId, ctx.originTasks);
    if (!upstreamId) throw new Error("origin task is unavailable");
    return {
      // Deletion is a video task operation and follows the task prefix.
      url: apiRoot(ctx) + "/api/v3/contents/generations/tasks/" + encodeURIComponent(upstreamId),
      method: "DELETE",
      headers: upstreamHeaders(ctx),
      // Ark documents this call with no body, but an empty JSON object is sent
      // for two independent reasons. The host requires a non-empty body shape
      // on the task endpoints it serves (a bodyless DELETE is refused with 415
      // before the plugin runs), and the upstream gateway applies the same rule
      // to the request the plugin forwards. `{}` satisfies both and carries no
      // meaning of its own.
      body: {},
    };
  }
  const req = ctx.requestBody;
  const metadata = req.metadata || {};
  // Reject output tiers the model does not offer before any quota is reserved.
  videoResolution(ctx);
  const body = Object.assign({ model: req.model || "", content: [] }, metadata);
  const imageContent = [];
  const images = Array.isArray(req.images) ? req.images : [];
  for (const url of images) imageContent.push({ type: "image_url", image_url: { url: url } });
  const metadataContent = Array.isArray(body.content) ? body.content : [];
  body.content = imageContent.concat(metadataContent).filter((item) => item && item.type !== "text");
  const hasReference = body.content.length > 0;
  if (trimmed(req.prompt) || !hasReference) body.content.push({ type: "text", text: req.prompt || "" });
  if (Array.isArray(body.content)) body.content = rewriteDraftTaskContent(body.content, ctx.originTasks);
  // -1 lets the model pick the length; extractUsage reserves the longest one.
  const seconds = Number.parseInt(req.seconds || "", 10);
  if (seconds > 0 || seconds === -1) body.duration = seconds;
  body.model = ctx.upstreamModel || body.model;
  return {
    url: apiRoot(ctx) + "/api/v3/contents/generations/tasks",
    method: "POST",
    headers: upstreamHeaders(ctx),
    body: body,
    action: hasReference ? "image_to_video" : "text_to_video",
    rewriteModel: body.model,
  };
}

export function parseSubmitResponse(ctx, resp) {
  const body = resp.body;
  // Asset actions and deletion answer inline. A raw asset payload has no `id`,
  // so the host-issued public id is reused and the result is terminal.
  if (isPassThroughAction(trimmed(ctx.action))) {
    if (body && typeof body === "object" && !Array.isArray(body) && body.error && typeof body.error === "object")
      throw new Error((trimmed(body.error.Code || body.error.code) || "upstream_error") + ": " + (trimmed(body.error.Message || body.error.message) || "upstream request failed"));
    const taskId = trimmed(ctx.publicTaskId);
    if (!taskId) throw new Error("missing gateway task id");
    return { taskId: taskId, taskData: body === undefined ? {} : body, immediate: { status: "SUCCESS", progress: "100%" } };
  }
  if (!body || !body.id) throw new Error("task_id is empty");
  return { taskId: body.id, taskData: body };
}

// Usage for a pass-through call: every field the resolved model's profile
// declares, at the value that prices the call at nothing. The host evaluates
// the model's price expression even for these routes, and a fact the plugin
// omits reads as null inside it, which fails the expression before the call is
// forwarded. Reporting the profile's own fields at zero keeps any expression
// that is compatible with the schema evaluable, and prices every tier at zero,
// so the route still reserves and settles no quota.
function passThroughUsageFacts(ctx) {
  const profile = videoProfile(ctx);
  const facts = {};
  for (const key of Object.keys(seedanceUsageSchema(profile))) {
    if (key === "tokens") facts.tokens = 0;
    else if (key === "resolution") facts.resolution = profile.resolutions[0];
    else if (key === "video_input") facts.video_input = "none";
  }
  return facts;
}

export function extractUsage(ctx) {
  // Pass-through and delete requests create no task and are not metered. They
  // report zero usage instead of none: the host evaluates the model's price
  // expression for every route that has one, and a missing fact reads as null,
  // which fails the expression with "invalid operation: <nil> * float64"
  // before the call is forwarded. Zero tokens price every tier at nothing, so
  // the route still reserves no quota.
  if (isPassThroughAction(trimmed(ctx && ctx.action))) return passThroughUsageFacts(ctx);
  const req = ctx.requestBody || {};
  const metadata = req.metadata || {};
  const profile = videoProfile(ctx);
  // A missing duration or -1 (the model picks the length) reserves the longest
  // duration the model can produce; completion overlays the real bill.
  let seconds = Number(req.seconds || req.duration || metadata.duration || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    const frames = Number(metadata.frames);
    seconds = Number.isFinite(frames) && frames > 0 ? Math.floor(frames / 24) : profile.maxDuration;
  }
  if (seconds <= 0) seconds = 5;
  seconds = Math.min(seconds, 3600);
  const resolution = videoResolution(ctx);
  const facts = { tokens: estimateTokens(seconds, resolution), resolution: resolution };
  // video_input is always reported, so expressions saved against the wider
  // schema keep matching their no-video tier.
  facts.video_input = hasVideo(metadata.content) ? "video" : "none";
  return facts;
}

export function buildQueryRequest(ctx) {
  return {
    url: apiRoot(ctx) + "/api/v3/contents/generations/tasks/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: upstreamHeaders(ctx),
  };
}

export function parseTaskResult(ctx, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: "UNKNOWN", reason: "invalid upstream task payload" };
  if (body.status === "pending" || body.status === "queued") return { status: "QUEUED", progress: "10%" };
  if (body.status === "processing" || body.status === "running") return { status: "IN_PROGRESS", progress: "50%" };
  if (body.status === "succeeded") {
    const result = { status: "SUCCESS", progress: "100%", url: body.content && body.content.video_url ? body.content.video_url : "" };
    const usage = body.usage || {};
    const completionTokens = Number(usage.completion_tokens || 0);
    const totalTokens = Number(usage.total_tokens || 0);
    if (Number.isFinite(completionTokens) && completionTokens > 0) result.completionTokens = completionTokens;
    if (Number.isFinite(totalTokens) && totalTokens > 0) result.totalTokens = totalTokens;
    return result;
  }
  if (body.status === "failed" || body.status === "expired" || body.status === "cancelled") {
    const reason = body.error && body.error.message ? body.error.message : body.status;
    return { status: "FAILURE", progress: "100%", reason: reason };
  }
  return { status: "UNKNOWN", reason: "unrecognized status: " + String(body.status || "") };
}

export function listArtifacts(task) {
  if (task.status !== "SUCCESS") return [];
  const data = task.data || {};
  const content = data.content || {};
  const artifacts = [];
  if (trimmed(content.video_url)) artifacts.push({ key: "video", type: "video" });
  if (trimmed(content.last_frame_url)) artifacts.push({ key: "last_frame", type: "image", mimeType: "image/png" });
  return artifacts;
}

export function buildContentRequest(ctx) {
  const data = ctx.data || {};
  const content = data.content || {};
  const urls = { video: content.video_url, last_frame: content.last_frame_url };
  const url = trimmed(urls[ctx.artifactKey]);
  if (!url) throw new Error("artifact_not_found");
  return { url: url, method: ctx.clientRequest.method, credentialless: true };
}

export function extractUsageOnComplete(task, taskResult, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  if (body.status !== "succeeded") return {};
  const facts = {};
  const usage = body.usage || {};
  let tokens = Number(usage.completion_tokens);
  if (!Number.isFinite(tokens) || tokens <= 0) tokens = Number(usage.total_tokens);
  if (Number.isFinite(tokens) && tokens > 0) facts.tokens = tokens;
  const content = body.content || {};
  const resolution = trimmed(content.resolution || body.resolution).toLowerCase();
  if (videoProfile(task).resolutions.includes(resolution)) facts.resolution = resolution;
  return facts;
}

function responsesInput(req) {
  const texts = [];
  const images = [];
  const input = req.input;
  if (typeof input === "string") texts.push(input);
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        texts.push(item);
        continue;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const content = item.content === undefined ? [item] : Array.isArray(item.content) ? item.content : [item.content];
      for (const part of content) {
        if (typeof part === "string") {
          texts.push(part);
          continue;
        }
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;
        if (["input_text", "text"].includes(part.type) && typeof part.text === "string") texts.push(part.text);
        if (["input_image", "image_url"].includes(part.type)) {
          let image = part.image_url;
          if (image && typeof image === "object") image = image.url;
          if (trimmed(image)) images.push(trimmed(image));
        }
      }
    }
  }
  return {
    prompt: texts
      .filter(function (text) {
        return trimmed(text);
      })
      .join("\n"),
    images: images,
  };
}

function responsesVideoText(ctx) {
  const artifact = ctx && ctx.artifacts && ctx.artifacts.video;
  const url = trimmed(artifact && artifact.url);
  if (!url) throw new Error("video artifact is unavailable");
  const escaped = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return '<video controls src="' + escaped + '"></video>';
}

export const protocols = {
  openai_responses: {
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const req = ctx.body.value;
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("request body must be an object");
      const model = trimmed(req.model);
      if (!model) throw new Error("model is required");
      if (req.input !== undefined && typeof req.input !== "string" && !Array.isArray(req.input)) throw new Error("input must be a string or array");
      if (req.images !== undefined && !Array.isArray(req.images)) throw new Error("images must be an array");
      if (req.metadata !== undefined && (!req.metadata || typeof req.metadata !== "object" || Array.isArray(req.metadata)))
        throw new Error("metadata must be an object");
      const input = responsesInput(req);
      const prompt = input.prompt || trimmed(req.prompt);
      const images = [];
      for (const image of [req.image, req.input_reference].concat(req.images || [], input.images)) {
        if (trimmed(image) && !images.includes(trimmed(image))) images.push(trimmed(image));
      }
      if (!prompt && images.length === 0) throw new Error("input is required");
      const metadata = Object.assign({}, req.metadata || {});
      if (Object.prototype.hasOwnProperty.call(req, "resolution")) metadata.resolution = req.resolution;
      else if (req.size && !metadata.resolution) metadata.resolution = normalizeResolution(req.size);
      const requestBody = { model: model, prompt: prompt, metadata: metadata };
      if (images.length) requestBody.images = images;
      if (Object.prototype.hasOwnProperty.call(req, "seconds")) requestBody.seconds = req.seconds;
      else if (Object.prototype.hasOwnProperty.call(req, "duration")) requestBody.seconds = req.duration;
      if (Object.prototype.hasOwnProperty.call(req, "size")) requestBody.size = req.size;
      const intent = { kind: "submit", model: model, action: images.length ? "image_to_video" : "text_to_video", requestBody: requestBody };
      const originTaskIds = draftTaskIds(metadata.content);
      if (originTaskIds.length) intent.originTaskIds = originTaskIds;
      return intent;
    },
    renderEvents: function (ctx, task, previousState) {
      const status = String(task.status || "UNKNOWN").toUpperCase();
      const value = Number(String(task.progress || "").replace("%", ""));
      const progress = Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
      const state = { status: status, progress: progress };
      if (status === "SUCCESS") {
        const text = responsesVideoText(ctx);
        const events = previousState && previousState.status === status ? [] : [{ type: "output", data: text }];
        return { events: events, state: state, done: true };
      }
      if (status === "FAILURE")
        return { events: [{ type: "error", code: "task_failed", message: task.fail_reason || "task failed" }], state: state, done: true };
      if (previousState && previousState.status === status && previousState.progress === progress) return { events: [], state: state, done: false };
      const event = { type: "progress", message: status.toLowerCase() };
      if (progress !== null) event.progress = progress;
      return { events: [event], state: state, done: false };
    },
    renderFinal: function (ctx, task) {
      return {
        output: [
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: responsesVideoText(ctx), annotations: [], logprobs: [] }],
          },
        ],
        metadata: { vendor: "ark" },
      };
    },
  },
  openai_video: {
    decodeRequest: function (ctx) {
      if (!ctx.body || (ctx.body.kind !== "json" && ctx.body.kind !== "multipart")) throw new Error("JSON or multipart body required");
      if (ctx.body.kind === "json") {
        if (!ctx.body.value || Array.isArray(ctx.body.value)) throw new Error("JSON object required");
        const req = ctx.body.value;
        const seconds = req.seconds === undefined ? req.duration : req.seconds;
        if (seconds !== undefined && Number(seconds) !== -1 && (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0 || Number(seconds) > 3600))
          throw new Error("seconds must be -1 or between 1 and 3600");
        const requestBody = Object.assign({}, req, { model: ctx.model });
        // buildSubmitRequest reads seconds; duration is accepted as its alias.
        if (seconds !== undefined) requestBody.seconds = seconds;
        return {
          kind: "submit",
          model: ctx.model,
          action: req.input_reference || req.image ? "image_to_video" : "text_to_video",
          requestBody: requestBody,
        };
      }
      const first = function (name) {
        const values = (ctx.body.fields || {})[name] || [];
        if (values.length > 1) throw new Error(name + " must be provided once");
        return values[0];
      };
      const req = {};
      const fields = ctx.body.fields || {};
      for (const name of Object.keys(fields)) req[name] = first(name);
      if (req.metadata !== undefined) {
        let parsed;
        try {
          parsed = JSON.parse(req.metadata);
        } catch (e) {
          throw new Error("metadata must be a JSON object string");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("metadata must be a JSON object string");
        req.metadata = parsed;
      }
      if ((ctx.body.files || []).length) throw new Error("Ark requires image and video references to be URLs inside metadata.content");
      if (req.seconds !== undefined) req.seconds = Number(req.seconds);
      else if (req.duration !== undefined) req.seconds = Number(req.duration);
      const seconds = req.seconds === undefined ? req.duration : req.seconds;
      if (seconds !== undefined && Number(seconds) !== -1 && (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0 || Number(seconds) > 3600))
        throw new Error("seconds must be -1 or between 1 and 3600");
      return {
        kind: "submit",
        model: ctx.model,
        action: req.input_reference || req.image ? "image_to_video" : "text_to_video",
        requestBody: Object.assign({}, req, { model: ctx.model }),
      };
    },
    render: function (ctx, task) {
      const data = task.data || {};
      const statusMap = { NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued", IN_PROGRESS: "in_progress", SUCCESS: "completed", FAILURE: "failed" };
      const output = {
        id: task.task_id,
        object: "video",
        model: task.properties ? task.properties.origin_model_name || "" : "",
        status: statusMap[task.status] || "unknown",
        progress: Number(String(task.progress || "0").replace("%", "")),
        created_at: task.created_at,
        completed_at: task.updated_at,
      };
      if (data.status === "failed") output.error = { message: data.error ? data.error.message || "" : "", code: data.error ? data.error.code || "" : "" };
      return output;
    },
  },
};
