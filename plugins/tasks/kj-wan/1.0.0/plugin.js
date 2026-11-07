// Wan video generation (Alibaba Bailian's Wan 3.0 family) addressed through an
// upstream New API gateway that serves the same task wire format.
//
// The plugin exists so a downstream client can keep the paths and request
// bodies it already sends while the gateway meters the calls. Requests arrive
// on /kj-wan/api/v1/services/aigc/video-generation/tasks and leave for the
// upstream gateway's own /api/v3/contents/generations/tasks, which is where the
// upstream publishes the Wan task API. The two names differ on purpose: the
// public path is this plugin's own stable address, and the upstream path is an
// implementation detail that may move without a client change.
//
// Only two operations are wired, because Wan 3.0 publishes only two:
//
//   POST /kj-wan/api/v1/services/aigc/video-generation/tasks      create
//   GET  /kj-wan/api/v1/services/aigc/video-generation/tasks/{id} query
//
// The upstream wire format is DashScope's: a request body carries `input` and
// `parameters` rather than Ark's flat `content` array. Pass it through
// unchanged so a client reads and writes exactly what the vendor documents.
//
// Capability tables below describe what each model offers, not what it costs:
// output resolutions, the longest output duration, and whether the request body
// may carry reference media (Wan 3.0 accepts images, video, audio, files and
// links through one `input.media` list).

const VIDEO_MODELS = {
  "wan3.0-video": { resolutions: ["480P", "720P", "1080P"], maxDuration: 30, media: true },
  "wan3.0-video-prime": { resolutions: ["480P", "720P", "1080P"], maxDuration: 30, media: true },
};

// Resolutions any declared model may be asked for, used when a request reaches
// the plugin under an endpoint ID that matches no declared name.
const WAN_RESOLUTIONS = ["480P", "720P", "1080P"];
const DEFAULT_VIDEO_PROFILE = { resolutions: WAN_RESOLUTIONS, maxDuration: 30, media: true };

// The longest output a request may reserve quota for, whatever the model.
const MAX_RESERVED_SECONDS = 30;

// Upstream task API, published at the host root. The upstream gateway serves
// its plugin routes behind this plugin's key, which is not the same as this
// plugin's key, so the prefix below is fixed rather than derived from ctx: the
// upstream path is a property of the vendor, not of the channel that reaches it.
const UPSTREAM_TASK_PATH = "/api/v3/contents/generations/tasks";

function trimmed(value) {
  return String(value || "").trim();
}

// The model identity a request is billed and reported under. Channel mapping
// may send a declared name to another model name; the declared name still
// describes that model, so profiles resolve against both.
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

// The model a request is reported under. Wan requests always carry one, so this
// only has to normalise it: a name the channel was not configured for must not
// reach the upstream, because an unknown model selects no channel there.
function requestModel(ctx) {
  const body = (ctx && ctx.body && ctx.body.kind === "json" && ctx.body.value) || {};
  const requestBody = (ctx && ctx.requestBody) || {};
  const claimed = trimmed(ctx && ctx.upstreamModel) || trimmed(ctx && ctx.model) || trimmed(body.model) || trimmed(requestBody.model);
  if (!claimed) throw new Error("model is required");
  return claimed;
}

function objectValue(value, name) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(name + " must be an object");
  return value;
}

// Wan 3.0 accepts a resolution in one of three cases. Anything else is rejected
// before the request leaves, so a typo cannot reserve quota for a call the
// vendor will refuse.
function normalizeResolution(value) {
  const raw = trimmed(value).toUpperCase();
  if (WAN_RESOLUTIONS.includes(raw)) return raw;
  const parts = raw.replace("*", "x").split("x");
  if (parts.length !== 2) return "";
  const max = Math.max(Number(parts[0]), Number(parts[1]));
  if (!Number.isFinite(max) || max <= 0) return "";
  if (max >= 1920) return "1080P";
  if (max >= 1280) return "720P";
  return "480P";
}

function mediaList(input) {
  return Array.isArray(input.media) ? input.media : [];
}

// A request that carries reference media is billed and reported apart from a
// prompt-only one, so the action reflects what actually travels.
function hasMedia(input) {
  return mediaList(input).length > 0;
}

// The resolution a request asks for, after the plugin's own default is applied.
// The vendor defaults to 1080P, so the plugin reports the same tier when the
// caller leaves it out rather than reporting nothing.
//
// `parameters` sits beside `input` in the vendor's body, not inside it.
function requestResolution(body) {
  const parameters = objectValue(body.parameters, "parameters");
  const claimed = parameters.resolution;
  if (claimed === undefined || claimed === null || trimmed(claimed) === "") return "1080P";
  const resolution = normalizeResolution(claimed);
  if (!resolution) throw new Error("resolution must be one of " + WAN_RESOLUTIONS.join(", "));
  return resolution;
}

// Output duration. -1 asks the model to choose, which reserves the longest
// output the model can produce; the completion usage replaces the estimate.
// As with the resolution, `parameters` sits beside `input`.
function requestSeconds(body, profile) {
  const parameters = objectValue(body.parameters, "parameters");
  const claimed = parameters.duration;
  if (claimed === undefined || claimed === null || trimmed(claimed) === "") return 5;
  const seconds = Number(claimed);
  if (!Number.isFinite(seconds)) throw new Error("duration must be a number");
  if (seconds === -1) return -1;
  if (!Number.isInteger(seconds) || seconds < 2 || seconds > profile.maxDuration)
    throw new Error("duration must be -1 or an integer between 2 and " + profile.maxDuration);
  return seconds;
}

function reservedSeconds(seconds, profile) {
  if (seconds === -1) return profile.maxDuration;
  return seconds;
}

// A request is valid when it names a prompt or carries reference media. Wan
// accepts either, and rejects a body with neither.
function validateInput(input) {
  const prompt = trimmed(input.prompt);
  if (!prompt && !hasMedia(input)) throw new Error("input.prompt or input.media is required");
  if (input.media !== undefined && !Array.isArray(input.media)) throw new Error("input.media must be an array");
}

// The wire body. Everything the caller sent travels unchanged, so fields this
// plugin does not know about still reach the vendor.
function requestBody(ctx) {
  const body = (ctx.body && ctx.body.kind === "json" && ctx.body.value) || null;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("request body must be an object");
  const input = body.input;
  if (input === undefined || input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("input is required and must be an object");
  validateInput(input);
  const profile = videoProfile(ctx);
  requestResolution(body);
  requestSeconds(body, profile);
  const model = requestModel(ctx);
  const out = Object.assign({}, body, { model: model });
  return out;
}

function upstreamHeaders(ctx) {
  return { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + ctx.apiKey };
}

// The task API root. Every upstream kind serves the same path: the plugin
// addresses the vendor's own task endpoints, so no plugin prefix is added.
function taskRoot(ctx) {
  return ctx.baseUrl + UPSTREAM_TASK_PATH;
}

// The native routes. They are this plugin's own public addresses and are
// registered exactly as declared.
export const native = {
  createTask: function (ctx) {
    const body = requestBody(ctx);
    return { kind: "submit", model: body.model, requestBody: body };
  },
  taskCreated: function (ctx, task) {
    const data = task.data && typeof task.data === "object" && !Array.isArray(task.data) ? task.data : {};
    return Object.assign({}, data, { id: task.task_id, task_id: task.task_id });
  },
  taskStatus: function (ctx, task) {
    if (task.data && typeof task.data === "object" && !Array.isArray(task.data)) return Object.assign({}, task.data, { id: task.task_id });
    const statusMap = { NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued", IN_PROGRESS: "running", SUCCESS: "succeeded", FAILURE: "failed" };
    const output = { id: task.task_id, status: statusMap[task.status] || "queued" };
    if (task.fail_reason) output.error = { message: task.fail_reason };
    return output;
  },
  error: function (ctx, error) {
    return { error: { code: error.code, message: error.message } };
  },
};

export function buildSubmitRequest(ctx) {
  const body = ctx.requestBody || {};
  const input = objectValue(body.input, "input");
  return {
    url: taskRoot(ctx),
    method: "POST",
    headers: upstreamHeaders(ctx),
    body: body,
    action: hasMedia(input) ? "image_to_video" : "text_to_video",
    rewriteModel: body.model,
  };
}

export function parseSubmitResponse(ctx, resp) {
  const body = resp.body;
  if (body && typeof body === "object" && !Array.isArray(body) && body.error && typeof body.error === "object")
    throw new Error((trimmed(body.error.code) || "upstream_error") + ": " + (trimmed(body.error.message) || "upstream request failed"));
  // Wan answers with both `id` and `task_id`; either names the task upstream.
  const taskId = trimmed(body && (body.id || body.task_id));
  if (!taskId) throw new Error("task_id is empty");
  return { taskId: taskId, taskData: body };
}

// The upstream id the host resolved for the task. A query reaches the plugin
// with ctx.taskId already translated, so it is used as-is; the fallback keeps a
// host that only publishes the public id from addressing a task the upstream
// has never seen.
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
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: "UNKNOWN", reason: "invalid upstream task payload" };
  if (body.status === "queued" || body.status === "pending") return { status: "QUEUED", progress: "10%" };
  if (body.status === "running" || body.status === "processing") return { status: "IN_PROGRESS", progress: "50%" };
  if (body.status === "succeeded") {
    const content = body.content || {};
    const result = { status: "SUCCESS", progress: "100%", url: trimmed(content.video_url) };
    const usage = body.usage || {};
    const completionTokens = Number(usage.completion_tokens);
    const totalTokens = Number(usage.total_tokens);
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
  return trimmed(content.video_url) ? [{ key: "video", type: "video" }] : [];
}

export function buildContentRequest(ctx) {
  const data = ctx.data || {};
  const content = data.content || {};
  const url = trimmed(content.video_url);
  if (!url) throw new Error("artifact_not_found");
  return { url: url, method: ctx.clientRequest.method, credentialless: true };
}

// Usage facts for pricing. `seconds` is the billable duration: for Wan 3.0 that
// is output duration, or input plus output when reference video is supplied,
// which only the completion payload can report.
export function extractUsage(ctx) {
  const body = ctx.requestBody || {};
  const input = objectValue(body.input, "input");
  const profile = videoProfile(ctx);
  const seconds = requestSeconds(body, profile);
  const facts = { seconds: reservedSeconds(seconds, profile), resolution: requestResolution(body) };
  if (profile.media) facts.media = hasMedia(input) ? "media" : "none";
  return facts;
}

export function extractUsageOnSubmit(ctx, body) {
  const input = (ctx.requestBody || {}).input;
  if (!input || typeof input !== "object") return {};
  const profile = videoProfile(ctx);
  const seconds = requestSeconds(ctx.requestBody, profile);
  return { seconds: reservedSeconds(seconds, profile), resolution: requestResolution(ctx.requestBody) };
}

export function extractUsageOnComplete(task, taskResult, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  if (body.status !== "succeeded") return {};
  const facts = {};
  const usage = body.usage || {};
  const content = body.content || {};
  // Wan 3.0 reports reference-video input separately from generated output and
  // bills their sum. A payload missing either half cannot establish the total,
  // so the reservation is kept rather than replaced by a partial number.
  const inputSeconds = usage.input_video_duration;
  const outputSeconds = usage.output_video_duration;
  if (typeof inputSeconds === "number" && Number.isFinite(inputSeconds) && inputSeconds >= 0 && typeof outputSeconds === "number" && Number.isFinite(outputSeconds) && outputSeconds >= 0) {
    facts.seconds = inputSeconds + outputSeconds;
  } else if (typeof outputSeconds === "number" && Number.isFinite(outputSeconds) && outputSeconds >= 0) {
    facts.seconds = outputSeconds;
  }
  const resolution = normalizeResolution(content.resolution || body.resolution);
  if (resolution) facts.resolution = resolution;
  return facts;
}

export const meta = {
  apiVersion: 1,
  key: "kj-wan",
  name: "Kuajing Wan",
  icon: "Bailian.Color",
  description: {
    en: "Wan 3.0 video generation through an upstream New API gateway",
    zh: "经上游 New API 网关接入的 Wan 3.0 视频生成",
  },
  version: "1.0.0",
  author: { name: "opcopilot" },
  models: Object.keys(VIDEO_MODELS),
  fetchMode: "per_task",
  // Only the gateway form is wired: the plugin addresses another gateway that
  // has this plugin installed, and the channel key is that gateway's token.
  // The vendor's own hosts are not addressed directly.
  upstreams: ["new_api"],
  usageSchema: {
    // Billable seconds: output duration, or input plus output for Wan 3.0.
    seconds: {
      type: "number",
      unit: "second",
      description: { en: "Video generation unit price", zh: "视频生成单价" },
    },
    resolution: {
      enum: WAN_RESOLUTIONS,
      enumLabels: { "480P": { en: "480P", zh: "480P" }, "720P": { en: "720P", zh: "720P" }, "1080P": { en: "1080P", zh: "1080P" } },
      description: { en: "Output video resolution", zh: "输出视频分辨率" },
    },
    media: {
      enum: ["none", "media"],
      enumLabels: { none: { en: "Prompt only", zh: "仅提示词" }, media: { en: "With reference media", zh: "含参考素材" } },
      description: { en: "Reference media input", zh: "参考素材输入" },
    },
  },
  usageExamples: [
    { label: "1080P · 5s", facts: { seconds: 5, resolution: "1080P", media: "none" } },
    { label: "720P · 10s", facts: { seconds: 10, resolution: "720P", media: "none" } },
    { label: "480P · 5s", facts: { seconds: 5, resolution: "480P", media: "none" } },
    { label: "1080P · 10s (with reference media)", facts: { seconds: 10, resolution: "1080P", media: "media" } },
  ],
  usageProfiles: [
    {
      models: Object.keys(VIDEO_MODELS),
      schema: {
        seconds: {
          type: "number",
          unit: "second",
          description: { en: "Video generation unit price", zh: "视频生成单价" },
        },
        resolution: {
          enum: WAN_RESOLUTIONS,
          enumLabels: { "480P": { en: "480P", zh: "480P" }, "720P": { en: "720P", zh: "720P" }, "1080P": { en: "1080P", zh: "1080P" } },
          description: { en: "Output video resolution", zh: "输出视频分辨率" },
        },
        media: {
          enum: ["none", "media"],
          enumLabels: { none: { en: "Prompt only", zh: "仅提示词" }, media: { en: "With reference media", zh: "含参考素材" } },
          description: { en: "Reference media input", zh: "参考素材输入" },
        },
      },
      examples: [
        { label: "1080P · 5s", facts: { seconds: 5, resolution: "1080P", media: "none" } },
        { label: "720P · 10s", facts: { seconds: 10, resolution: "720P", media: "none" } },
        { label: "480P · 5s", facts: { seconds: 5, resolution: "480P", media: "none" } },
        { label: "1080P · 10s (with reference media)", facts: { seconds: 10, resolution: "1080P", media: "media" } },
      ],
    },
  ],
  routes: [
    // Wan's two task operations, republished under this plugin's own path. The
    // gateway registers each route as declared, because the first segment
    // matches this plugin's key.
    //
    // No host protocol is claimed. This plugin republishes one vendor's task
    // API under a path a client already calls; it does not present the models
    // through the OpenAI video or responses surface, so nothing is declared
    // here that would need those protocol hooks implemented.
    { method: "POST", path: "/kj-wan/api/v1/services/aigc/video-generation/tasks", type: "submit", decode: "createTask", render: "taskCreated" },
    { method: "GET", path: "/kj-wan/api/v1/services/aigc/video-generation/tasks/:task_id", type: "query", render: "taskStatus" },
  ],
};
