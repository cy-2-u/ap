const DEFAULT_VSLLM_URL = "https://vsllm.cc";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_QUOTA_PER_YUAN = 500_000;
const DEFAULT_AD_DURATION_SECONDS = 15;
const MAX_AD_DURATION_SECONDS = 120;
const MAX_QUIZ_ATTEMPTS = 20;
const MAX_MESSAGE_LENGTH = 180;
const MAX_ACCOUNT_NAME_LENGTH = 64;
const MAX_COOKIE_LENGTH = 16 * 1024;

const sensitiveAssignment =
  /(?:authorization|cookie|session|token|password|cf_clearance)\s*(?::|=)\s*(?:bearer\s+)?[^\s,;]+/giu;
const bearerValue = /bearer\s+[A-Za-z0-9._~+/=-]+/giu;
const cooldownMarkers = [
  "冷却",
  "次数不足",
  "暂无可用",
  "cooldown",
  "too soon",
  "next draw",
  "no available",
];
const quizTaskStates = new Set([
  "pending",
  "available",
  "ready",
  "in_progress",
  "completed",
  "done",
  "success",
  "claimed",
  "unknown",
]);
const taskRewardTypes = new Set(["charge", "extra_draw", "quota"]);

function compactText(value, fallback = "", limit = MAX_MESSAGE_LENGTH) {
  const text = String(value ?? fallback)
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(sensitiveAssignment, "***")
    .replace(bearerValue, "Bearer ***")
    .replace(/\s+/gu, " ")
    .trim();
  return text.slice(0, limit);
}

function secretValues(account) {
  if (!account || typeof account !== "object") return [];
  const values = new Set();
  for (const value of [account.cookie, account.session, account.cf_clearance, account.cfClearance, account.system_token, account.systemToken, account.username, account.password]) {
    if (typeof value !== "string" || value.length < 4) continue;
    values.add(value);
    for (const part of value.split(";")) {
      const separator = part.indexOf("=");
      const candidate = (separator >= 0 ? part.slice(separator + 1) : part).trim();
      if (candidate.length >= 4) values.add(candidate);
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function safeMessage(value, account, fallback = "请求失败") {
  let text = String(value ?? fallback);
  for (const secret of secretValues(account)) {
    text = text.split(secret).join("***");
  }
  return compactText(text, fallback);
}

function safeInteger(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value === "boolean" || value === null || value === undefined || value === "") {
    return null;
  }
  const number = typeof value === "number" ? value : Number(String(value).replaceAll(",", "").trim());
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) return null;
  return number;
}

function quotaInteger(value) {
  return safeInteger(value, { minimum: 0 }) ?? 0;
}

function normalizeBonusPercent(value) {
  if (typeof value === "boolean" || value === null || value === undefined || value === "") {
    return 0;
  }
  const number = Number(String(value).replaceAll(",", "").trim());
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.trunc(number > 0 && number <= 1 ? number * 100 : number);
}

function quotaWithBonus(rawValue, bonusPercent) {
  const rawQuota = quotaInteger(rawValue);
  const percent = normalizeBonusPercent(bonusPercent);
  const adjustedQuota = Math.round(rawQuota * (1 + percent / 100));
  return Number.isSafeInteger(adjustedQuota) && adjustedQuota >= 0 ? adjustedQuota : rawQuota;
}

function quotaResult(rawValue, quotaPerYuan = DEFAULT_QUOTA_PER_YUAN) {
  const quotaRaw = quotaInteger(rawValue);
  const unit = safeInteger(quotaPerYuan, { minimum: 1 }) ?? DEFAULT_QUOTA_PER_YUAN;
  const amountMicroyuan = Number.isSafeInteger(quotaRaw * 1_000_000)
    ? Math.trunc((quotaRaw * 1_000_000) / unit)
    : null;
  const amountYuan = amountMicroyuan === null
    ? null
    : `${Math.trunc(amountMicroyuan / 1_000_000)}.${String(amountMicroyuan % 1_000_000).padStart(6, "0")}`;
  return {
    quota_raw: quotaRaw,
    quota_per_yuan: unit,
    amount_microyuan: amountMicroyuan,
    amount_yuan: amountYuan,
  };
}

function normalizedBaseUrl(value) {
  const candidate = String(value || DEFAULT_VSLLM_URL).trim();
  if (candidate.length === 0 || candidate.length > 2048 || /[\u0000-\u001f\u007f]/u.test(candidate)) {
    throw new TypeError("账号 URL 无效");
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new TypeError("账号 URL 无效");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new TypeError("账号 URL 必须是不含认证信息、查询参数或片段的 HTTPS 地址");
  }
  return url.href.replace(/\/+$/u, "");
}

function siteKindForUrl(baseUrl) {
  const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/u, "");
  if (hostname === "vsllm.com" || hostname === "vsllm.cc") return "vsllm";
  if (hostname === "nai.rinko.ai") return "yesnai";
  return "generic";
}

function cookieItems(value) {
  const items = new Map();
  for (const part of value.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim().toLowerCase();
    if (!name || items.has(name)) continue;
    items.set(name, part.slice(separator + 1).trim());
  }
  return items;
}

function normalizedCookie(input) {
  const cookieValue = input.cookie ?? input.session;
  if (typeof cookieValue !== "string" || cookieValue.trim().length === 0) {
    throw new TypeError("账号缺少 Cookie/Session");
  }
  let value = cookieValue.trim();
  if (value.length > MAX_COOKIE_LENGTH || /[\r\n\u0000]/u.test(value)) {
    throw new TypeError("账号 Cookie 无效");
  }
  const hasHeaderPrefix = /^cookie\s*:/iu.test(value);
  if (hasHeaderPrefix) value = value.replace(/^cookie\s*:\s*/iu, "");

  const hasCookieSyntax = hasHeaderPrefix || value.includes(";") || /^session\s*=/iu.test(value);
  const items = hasCookieSyntax ? cookieItems(value) : null;
  const session = hasCookieSyntax ? items.get("session") : value;
  if (typeof session !== "string" || session.length === 0) {
    throw new TypeError("账号 Cookie 缺少 session");
  }

  const inlineClearance = items?.get("cf_clearance") || "";
  const configuredClearance = input.cf_clearance ?? input.cfClearance;
  let cfClearance = typeof configuredClearance === "string" && configuredClearance.trim()
    ? configuredClearance.trim()
    : inlineClearance;
  if (/^cf_clearance\s*=/iu.test(cfClearance)) {
    cfClearance = cfClearance.replace(/^cf_clearance\s*=\s*/iu, "");
  }
  cfClearance = cfClearance.replace(/;\s*$/u, "").trim();
  if (
    /[;\r\n\u0000]/u.test(cfClearance) ||
    `session=${session}; cf_clearance=${cfClearance};`.length > MAX_COOKIE_LENGTH
  ) {
    throw new TypeError("账号 cf_clearance 无效");
  }
  return {
    cookie: `session=${session};`,
    cfClearance,
  };
}

function normalizeAccount(input, index) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`第 ${index + 1} 个账号格式无效`);
  }
  const baseUrl = normalizedBaseUrl(input.baseUrl ?? input.url ?? DEFAULT_VSLLM_URL);
  const siteKind = siteKindForUrl(baseUrl);
  const name = compactText(input.name, `账号${index + 1}`, MAX_ACCOUNT_NAME_LENGTH) || `账号${index + 1}`;
  if (siteKind === "yesnai") {
    const username = String(input.username ?? input.session ?? "").trim();
    const password = String(input.password ?? input.system_token ?? "").trim();
    if (!username || username.length > 256 || /[\r\n\u0000]/u.test(username)) {
      throw new TypeError(`${name} 缺少或无效的 YesNAI 账号`);
    }
    if (!password || password.length > 4096 || /[\r\n\u0000]/u.test(password)) {
      throw new TypeError(`${name} 缺少或无效的 YesNAI 密码`);
    }
    return {
      name,
      baseUrl,
      userId: "",
      authMode: "yesnai",
      siteKind,
      username,
      password,
      isVsllm: false,
      isYesNai: true,
    };
  }
  const authMode = input.auth_mode === "token" || input.authMode === "token" ? "token" : "session";
  let cookie = "";
  let cfClearance = "";
  let systemToken = "";
  if (authMode === "token") {
    systemToken = String(input.system_token ?? input.systemToken ?? input.token ?? "").trim();
    if (!systemToken || systemToken.length > 4096 || /[\r\n\u0000]/u.test(systemToken)) {
      throw new TypeError("账号系统令牌无效");
    }
  } else {
    ({ cookie, cfClearance } = normalizedCookie(input));
  }
  const rawUserId = input.userId ?? input.user_id;
  const userId = rawUserId === null || rawUserId === undefined
    ? ""
    : String(rawUserId).trim();
  if (userId.length > 128 || /[\r\n\u0000]/u.test(userId)) {
    throw new TypeError(`第 ${index + 1} 个账号 userId 无效`);
  }
  return {
    name,
    baseUrl,
    userId,
    authMode,
    siteKind,
    cookie,
    ...(cfClearance ? { cfClearance } : {}),
    ...(systemToken ? { systemToken } : {}),
    isVsllm: siteKind === "vsllm",
    isYesNai: false,
  };
}

function operationAccount(account) {
  try {
    return { account: normalizeAccount(account, 0), error: null };
  } catch (error) {
    return {
      account: null,
      error: {
        ok: false,
        success: false,
        status: "invalid",
        message: compactText(error instanceof Error ? error.message : "账号配置无效"),
      },
    };
  }
}

function optionNumber(options, name, fallback, minimum, maximum) {
  const value = options?.[name];
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function fetchImplementation(options) {
  if (typeof options?.fetch === "function") return options.fetch;
  if (typeof globalThis.fetch !== "function") throw new TypeError("fetch 不可用");
  return globalThis.fetch.bind(globalThis);
}

function requestHeaders(account) {
  const headers = new Headers({
    Accept: "application/json, text/plain, */*",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  });
  if (account.authMode === "token") {
    headers.set("Authorization", `Bearer ${account.systemToken}`);
  } else {
    const cookie = account.cfClearance
      ? `${account.cookie} cf_clearance=${account.cfClearance};`
      : account.cookie;
    headers.set("Cookie", cookie);
  }
  if (account.userId) headers.set("new-api-user", account.userId);
  return headers;
}

async function yesNaiRequest(account, path, { method = "GET", json: body, token = "" } = {}, options = {}) {
  const timeoutMs = optionNumber(options, "timeoutMs", DEFAULT_TIMEOUT_MS, 1, 120_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  const headers = new Headers({ Accept: "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  try {
    const response = await fetchImplementation(options)(`${account.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: "manual",
    });
    let payload = null;
    let parseError = null;
    try {
      const parsed = await response.json();
      payload = parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      parseError = "invalid_json";
    }
    return { received: true, response, payload, parseError };
  } catch (error) {
    return {
      received: false,
      response: null,
      payload: null,
      parseError: null,
      transportError: controller.signal.aborted ? "timeout" : "network",
      transportDetail: safeMessage(error instanceof Error ? `${error.name}: ${error.message}` : error, account),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function yesNaiMessage(payload, account, fallback) {
  return safeMessage(payload?.error?.message || payload?.detail || payload?.message, account, fallback);
}

async function yesNaiLogin(account, options = {}) {
  const result = await yesNaiRequest(account, "/api/ynai/auth/login", {
    method: "POST",
    json: { username: account.username, password: account.password },
  }, options);
  if (!result.received) {
    return { ok: false, status: result.transportError === "timeout" ? "uncertain" : "error", message: result.transportError === "timeout" ? "登录超时" : "登录网络失败" };
  }
  const token = result.payload?.data?.access_token;
  if (!result.response.ok || !token) {
    return { ok: false, status: result.response.status === 401 ? "auth" : "error", http_status: result.response.status, message: yesNaiMessage(result.payload, account, `登录失败（HTTP ${result.response.status}）`) };
  }
  return { ok: true, token: String(token), uid: result.payload?.data?.uid ?? null };
}

async function yesNaiBalance(account, options = {}) {
  const login = await yesNaiLogin(account, options);
  if (!login.ok) return login;
  const result = await yesNaiRequest(account, "/api/ynai/user/balance", { token: login.token }, options);
  if (!result.received) return { ok: false, status: result.transportError === "timeout" ? "uncertain" : "error", message: result.transportError === "timeout" ? "余额请求超时" : "余额网络失败" };
  const gems = Number(result.payload?.data?.balance_gems);
  if (!result.response.ok || !Number.isFinite(gems)) {
    return { ok: false, status: result.response.status === 401 ? "auth" : "error", http_status: result.response.status, message: yesNaiMessage(result.payload, account, `余额读取失败（HTTP ${result.response.status}）`) };
  }
  return {
    ok: true,
    success: true,
    status: "success",
    http_status: result.response.status,
    message: "余额读取成功",
    balance_gems: gems,
    balance_yuan: null,
  };
}

async function yesNaiCheckin(account, options = {}) {
  const login = await yesNaiLogin(account, options);
  if (!login.ok) return login;
  const result = await yesNaiRequest(account, "/api/user/checkin", { method: "POST", token: login.token }, options);
  if (!result.received) return { ok: false, status: result.transportError === "timeout" ? "uncertain" : "error", message: result.transportError === "timeout" ? "签到请求超时" : "签到网络失败" };
  const message = yesNaiMessage(result.payload, account, result.response.ok ? "签到成功" : `签到失败（HTTP ${result.response.status}）`);
  const already = alreadyCheckedInMessage(message);
  if (!result.response.ok && !already) return { ok: false, status: result.response.status === 401 ? "auth" : "error", http_status: result.response.status, message };
  const data = result.payload?.data && typeof result.payload.data === "object" ? result.payload.data : {};
  const reward = data.gems ?? data.checkin_gems ?? data.quota_awarded ?? data.quota ?? data.reward ?? null;
  return {
    ok: true,
    success: true,
    status: already ? "completed" : "success",
    skipped: already,
    completed: already,
    http_status: result.response.status,
    message: "已签到",
    quota_awarded: Number.isFinite(Number(reward)) ? Number(reward) : 0,
  };
}

async function readJsonLimited(response, maximumBytes) {
  const declaredLength = safeInteger(response.headers.get("content-length"), { minimum: 0 });
  if (declaredLength !== null && declaredLength > maximumBytes) {
    try {
      await response.body?.cancel("response too large");
    } catch {
      // Best-effort cancellation only.
    }
    return { ok: false, error: "too_large" };
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    return { ok: false, error: "empty" };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("response too large");
        return { ok: false, error: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, error: "read_failed" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes).trim();
  if (!text) return { ok: false, error: "empty" };
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? { ok: true, value }
      : { ok: false, error: "invalid_shape" };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}

async function apiRequest(account, path, requestOptions = {}, options = {}) {
  const timeoutMs = optionNumber(options, "timeoutMs", DEFAULT_TIMEOUT_MS, 1, 120_000);
  const maximumBytes = optionNumber(
    options,
    "maxResponseBytes",
    DEFAULT_MAX_RESPONSE_BYTES,
    1024,
    256 * 1024,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  const headers = requestHeaders(account);
  let body;
  if (Object.prototype.hasOwnProperty.call(requestOptions, "json")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
    body = JSON.stringify(requestOptions.json);
  }

  let response;
  try {
    response = await fetchImplementation(options)(`${account.baseUrl}${path}`, {
      method: requestOptions.method || "GET",
      headers,
      body,
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (error) {
    clearTimeout(timeout);
    const transportDetail = safeMessage(
      error instanceof Error ? `${error.name}: ${error.message}` : error,
      account,
      "fetch failed",
    ).slice(0, 240);
    console.error(JSON.stringify({
      event: "upstream_fetch_failed",
      host: new URL(account.baseUrl).hostname,
      path,
      error: transportDetail,
    }));
    const timeoutError = controller.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError";
    return {
      received: false,
      transport_error: timeoutError ? "timeout" : "network",
      transport_detail: transportDetail,
      http_status: 0,
      response_ok: false,
      payload: null,
      parse_error: null,
    };
  }

  let parsed;
  try {
    parsed = await readJsonLimited(response, maximumBytes);
  } catch {
    parsed = { ok: false, error: controller.signal.aborted ? "read_timeout" : "read_failed" };
  } finally {
    clearTimeout(timeout);
  }
  return {
    received: true,
    transport_error: null,
    transport_detail: null,
    http_status: response.status,
    response_ok: response.ok,
    payload: parsed.ok ? parsed.value : null,
    parse_error: parsed.ok ? null : parsed.error,
  };
}

function isUpstreamChallenge(result) {
  return Boolean(
    result &&
      result.received &&
      result.parse_error === "invalid_json" &&
      result.http_status === 403,
  );
}

async function apiRequestMirrored(account, path, requestOptions = {}, options = {}) {
  const result = await apiRequest(account, path, requestOptions, options);
  if (isUpstreamChallenge(result)) return { ...result, parse_error: "upstream_challenge" };
  return result;
}

function apiMessage(result, account, fallback) {
  return safeMessage(result.payload?.message, account, fallback);
}

function failureStatus(result, message) {
  if (result.http_status === 401) return "auth";
  const lower = String(message || "").toLowerCase();
  return cooldownMarkers.some((marker) => lower.includes(marker)) ? "cooldown" : "error";
}

function endpointFailure(result, account, fallback, { uncertainTransport = false } = {}) {
  if (!result.received) {
    return {
      ok: false,
      success: false,
      status: uncertainTransport ? "uncertain" : "error",
      http_status: 0,
      message: result.transport_error === "timeout" ? "请求超时" : "网络请求失败",
    };
  }
  const message = result.parse_error === "upstream_challenge"
    ? `上游人机验证拦截 (HTTP ${result.http_status})`
    : result.parse_error
      ? `响应格式错误 (HTTP ${result.http_status})`
      : apiMessage(result, account, fallback);
  return {
    ok: false,
    success: false,
    status: failureStatus(result, message),
    http_status: result.http_status,
    message,
  };
}

function requireVsllm(account) {
  if (!account.isVsllm) {
    return {
      ok: false,
      success: false,
      status: "unsupported",
      message: "该操作仅支持 vsllm 站点",
    };
  }
  if (!account.userId) {
    return {
      ok: false,
      success: false,
      status: "invalid",
      message: "VSLLM 账号缺少 userId",
    };
  }
  return null;
}

function successfulPayload(result, { allowMissingSuccess = false } = {}) {
  if (!result.received || result.parse_error || !result.response_ok || !result.payload) return false;
  return result.payload.success === true || (allowMissingSuccess && result.payload.success !== false);
}

function alreadyCheckedInMessage(value) {
  const message = String(value ?? "").normalize("NFKC").toLowerCase();
  return (
    /已(?:经)?\s*签到(?:过)?/u.test(message) ||
    /\balready[\s-]+check(?:ed)?[\s-]+in\b/u.test(message)
  );
}

async function checkinAccount(accountInput, options = {}) {
  const prepared = operationAccount(accountInput);
  if (prepared.error) return prepared.error;
  const account = prepared.account;
  if (account.isYesNai) return yesNaiCheckin(account, options);
  const result = await apiRequestMirrored(account, "/api/user/checkin", { method: "POST" }, options);
  const alreadyCheckedIn =
    result.received &&
    result.response_ok &&
    !result.parse_error &&
    result.payload &&
    alreadyCheckedInMessage(result.payload.message);
  if (!successfulPayload(result) && !alreadyCheckedIn) {
    return endpointFailure(result, account, "签到失败", { uncertainTransport: !result.received });
  }
  const data = result.payload.data && typeof result.payload.data === "object" ? result.payload.data : {};
  const checkinDate = safeMessage(data.checkin_date, account, "");
  return {
    ok: true,
    success: true,
    ...(alreadyCheckedIn ? { skipped: true, completed: true } : {}),
    status: alreadyCheckedIn ? "completed" : "success",
    http_status: result.http_status,
    message: apiMessage(result, account, "签到成功"),
    checkin_date: /^\d{4}-\d{2}-\d{2}$/u.test(checkinDate) ? checkinDate : null,
    quota_awarded: quotaInteger(data.quota_awarded),
  };
}

async function getBalance(accountInput, options = {}) {
  const prepared = operationAccount(accountInput);
  if (prepared.error) return prepared.error;
  const account = prepared.account;
  if (account.isYesNai) return yesNaiBalance(account, options);
  const result = await apiRequestMirrored(account, "/api/user/self", { method: "GET" }, options);
  if (!successfulPayload(result)) {
    const failure = endpointFailure(result, account, "余额读取失败");
    return result.transport_detail
      ? { ...failure, diagnostic: result.transport_detail }
      : failure;
  }
  const data = result.payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return endpointFailure({ ...result, parse_error: "invalid_shape" }, account, "余额响应格式错误");
  }
  const quotaPerYuan = optionNumber(
    options,
    "quotaPerYuan",
    DEFAULT_QUOTA_PER_YUAN,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const balance = quotaResult(data.quota, quotaPerYuan);
  const used = quotaResult(data.used_quota, quotaPerYuan);
  return {
    ok: true,
    success: true,
    status: "success",
    http_status: result.http_status,
    message: apiMessage(result, account, "余额读取成功"),
    quota_raw: balance.quota_raw,
    quota: balance.quota_raw,
    balance_quota: balance.quota_raw,
    used_quota_raw: used.quota_raw,
    used_quota: used.quota_raw,
    quota_per_yuan: quotaPerYuan,
    balance_microyuan: balance.amount_microyuan,
    used_microyuan: used.amount_microyuan,
    balance_yuan: balance.amount_yuan,
    used_yuan: used.amount_yuan,
    request_count: quotaInteger(data.request_count),
  };
}

function normalizeEpochSeconds(value) {
  if (value === undefined) return null;
  if (value === null || value === "") return 0;
  const integer = safeInteger(value, { minimum: 0 });
  if (integer !== null) return integer > 100_000_000_000 ? Math.trunc(integer / 1000) : integer;
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.trunc(timestamp / 1000)) : null;
}

function normalizeTaskReward(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const fields = {};
  if (Object.prototype.hasOwnProperty.call(value, "reward_type")) {
    const rawType = compactText(value.reward_type, "", 24).toLowerCase();
    fields.reward_type = taskRewardTypes.has(rawType) ? rawType : "unknown";
  }
  if (Object.prototype.hasOwnProperty.call(value, "reward_amount")) {
    fields.reward_amount = safeInteger(value.reward_amount, { minimum: 1, maximum: 100 });
  }
  return fields;
}

function normalizeQuizTask(value, account) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawStatus = safeMessage(value.status, account, "unknown").toLowerCase();
  // The upstream UI treats `won` as finished, but `lost` as retryable.
  const status = rawStatus === "won" ? "completed" : rawStatus === "lost" ? "pending" : rawStatus;
  return {
    status: quizTaskStates.has(status) ? status : "unknown",
    suspended: value.suspended === true,
    ...normalizeTaskReward(value),
  };
}

function normalizeAdTask(value, nowSeconds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const doneCount = safeInteger(value.done_count, { minimum: 0 });
  const serverCap = safeInteger(value.daily_cap, { minimum: 1 }) ?? 3;
  const dailyCap = Math.min(serverCap, 3);
  const nextAvailableAt = normalizeEpochSeconds(value.next_available_at);
  const completed = doneCount !== null && doneCount >= dailyCap;
  let status = "unknown";
  if (value.suspended === true) status = "suspended";
  else if (completed) status = "completed";
  else if (nextAvailableAt !== null && nextAvailableAt > nowSeconds) status = "cooldown";
  else if (doneCount !== null && nextAvailableAt !== null) status = "available";
  return {
    status,
    suspended: value.suspended === true,
    completed,
    done_count: doneCount,
    daily_cap: dailyCap,
    next_available_at: nextAvailableAt,
    duration_seconds: normalizeAdDuration(value.duration_sec),
    min_interval_seconds: safeInteger(value.min_interval_sec, { minimum: 0 }),
    ...normalizeTaskReward(value),
  };
}

function normalizeAdDuration(value) {
  if (typeof value === "boolean" || value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.max(1, Math.min(MAX_AD_DURATION_SECONDS, Math.trunc(number)));
}

function nowEpochSeconds(options) {
  let value = options?.now;
  if (typeof value === "function") value = value();
  if (value instanceof Date) return Math.trunc(value.getTime() / 1000);
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value > 100_000_000_000 ? value / 1000 : value);
  }
  return Math.trunc(Date.now() / 1000);
}

function rewardCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function rewardSnapshot(status) {
  if (!status || status.ok !== true) return null;
  return {
    charges_current: rewardCounter(status.charges_current),
    charges_max: rewardCounter(status.charges_max),
    extra_draws_left: rewardCounter(status.extra_draws_left),
    available: rewardCounter(status.available),
  };
}

function rewardDelta(before, after) {
  if (!before || !after) return null;
  return {
    charges_current:
      before.charges_current !== null && after.charges_current !== null
        ? after.charges_current - before.charges_current
        : null,
    extra_draws_left:
      before.extra_draws_left !== null && after.extra_draws_left !== null
        ? after.extra_draws_left - before.extra_draws_left
        : null,
  };
}

function taskRewardState(task, beforeStatus, afterStatus, { inactive = false } = {}) {
  const rewardType = task?.reward_type ?? null;
  const rewardAmount = task?.reward_amount ?? null;
  const before = rewardSnapshot(beforeStatus);
  const after = rewardSnapshot(afterStatus);
  const delta = rewardDelta(before, after);
  let status = inactive ? "not_applicable" : "unknown";
  let drawReady = false;

  if (!inactive && rewardAmount !== null && rewardAmount > 0) {
    if (rewardType === "quota") {
      status = "not_applicable";
    } else if (before && after && delta) {
      if (rewardType === "extra_draw") {
        if (delta.extra_draws_left !== null && delta.extra_draws_left >= rewardAmount) {
          status = "confirmed";
          drawReady = true;
        }
      } else if (rewardType === "charge") {
        const knownMax = before.charges_max ?? after.charges_max;
        if (delta.charges_current !== null && delta.charges_current >= rewardAmount) {
          status = knownMax === null ? "unknown" : "confirmed";
          drawReady = status === "confirmed";
        } else if (
          delta.charges_current === 0 &&
          knownMax !== null &&
          ((before.charges_current !== null && before.charges_current >= knownMax) ||
            (after.charges_current !== null && after.charges_current >= knownMax))
        ) {
          status = "capped";
        }
      }
    }
  }

  return {
    reward_type: rewardType,
    reward_amount: rewardAmount,
    reward_status: status,
    reward_before: before,
    reward_after: after,
    reward_delta: delta,
    reward_draw_ready: drawReady,
  };
}

async function getGwentStatus(accountInput, options = {}) {
  const prepared = operationAccount(accountInput);
  if (prepared.error) return prepared.error;
  const account = prepared.account;
  if (account.isYesNai) {
    return { ok: true, success: true, status: "not_applicable", message: "该站点不提供翻牌任务", available: null, charges_current: null, charges_max: null, quiz: null, ad: null };
  }
  const unsupported = requireVsllm(account);
  if (unsupported) return unsupported;
  const result = await apiRequestMirrored(account, "/api/gwent/status", { method: "GET" }, options);
  if (!successfulPayload(result)) return endpointFailure(result, account, "读取翻牌状态失败");
  const data = result.payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return endpointFailure({ ...result, parse_error: "invalid_shape" }, account, "翻牌状态格式错误");
  }
  const tasks = data.tasks && typeof data.tasks === "object" && !Array.isArray(data.tasks)
    ? data.tasks
    : {};
  const hasChargeFields =
    Object.prototype.hasOwnProperty.call(data, "charges_current") ||
    Object.prototype.hasOwnProperty.call(data, "extra_draws_left");
  const chargesCurrent = quotaInteger(data.charges_current);
  const extraDrawsLeft = quotaInteger(data.extra_draws_left);
  const chargesMax = safeInteger(data.charges_max, { minimum: 0 });
  return {
    ok: true,
    success: true,
    status: "success",
    http_status: result.http_status,
    message: apiMessage(result, account, "翻牌状态读取成功"),
    available: hasChargeFields ? chargesCurrent + extraDrawsLeft : null,
    charges_current: hasChargeFields ? chargesCurrent : null,
    extra_draws_left: hasChargeFields ? extraDrawsLeft : null,
    charges_max: chargesMax,
    next_available_at: normalizeEpochSeconds(data.next_available_at),
    next_charge_at: normalizeEpochSeconds(data.next_charge_at),
    cooldown_seconds: safeInteger(data.cooldown_seconds, { minimum: 0 }),
    quiz: normalizeQuizTask(tasks.task3, account),
    ad: normalizeAdTask(tasks.task2, nowEpochSeconds(options)),
  };
}

function prizeRarity(value) {
  const rarity = compactText(value, "unknown", 16).toLowerCase();
  return ["common", "rare", "epic", "legendary"].includes(rarity) ? rarity : "unknown";
}

async function unlockAndDraw(accountInput, options = {}) {
  const prepared = operationAccount(accountInput);
  if (prepared.error) return prepared.error;
  const account = prepared.account;
  const unsupported = requireVsllm(account);
  if (unsupported) return unsupported;

  let unlockResult;
  if (options.shareBonus === false) {
    unlockResult = {
      ok: true,
      status: "skipped",
      message: "未启用加成",
    };
  } else {
    const unlock = await apiRequestMirrored(account, "/api/gwent/share_unlock", { method: "POST" }, options);
    const unlockMessage = apiMessage(unlock, account, "50% 加成解锁失败");
    const alreadyUnlocked = ["已解锁", "已激活", "已经", "already", "activated"].some((marker) =>
      unlockMessage.toLowerCase().includes(marker),
    );
    const unlockSuccess = successfulPayload(unlock, { allowMissingSuccess: true }) ||
      (unlock.received && !unlock.parse_error && unlock.http_status !== 401 && alreadyUnlocked);
    if (!unlockSuccess) {
      return {
        ...endpointFailure(unlock, account, "50% 加成解锁失败"),
        unlock: {
          ok: false,
          status: failureStatus(unlock, unlockMessage),
          http_status: unlock.http_status,
          message: unlockMessage,
        },
        draw_sent: false,
      };
    }

    unlockResult = {
      ok: true,
      status: "success",
      http_status: unlock.http_status,
      message: unlockMessage || "50% 加成已解锁",
    };
  }
  const draw = await apiRequestMirrored(account, "/api/gwent/draw", { method: "POST" }, options);
  if (!draw.received || draw.parse_error) {
    const uncertain = endpointFailure(draw, account, "翻牌结果无法确认", { uncertainTransport: true });
    return {
      ...uncertain,
      status: "uncertain",
      message: draw.parse_error ? `翻牌结果无法确认 (HTTP ${draw.http_status})` : uncertain.message,
      unlock: unlockResult,
      draw_sent: true,
    };
  }
  if (!successfulPayload(draw)) {
    return {
      ...endpointFailure(draw, account, "翻牌失败"),
      unlock: unlockResult,
      draw_sent: true,
    };
  }

  const data = draw.payload.data && typeof draw.payload.data === "object" ? draw.payload.data : {};
  const prize = data.prize && typeof data.prize === "object" ? data.prize : {};
  const hasChargeFields =
    Object.prototype.hasOwnProperty.call(data, "charges_current") ||
    Object.prototype.hasOwnProperty.call(data, "extra_draws_left");
  const chargesCurrent = quotaInteger(data.charges_current);
  const extraDrawsLeft = quotaInteger(data.extra_draws_left);
  const rawPrizeQuota = quotaInteger(prize.quota);
  const bonusPercent = options.shareBonus === false
    ? 0
    : normalizeBonusPercent(
        data.applied_bonus_pct ??
          data.applied_bonus_percent ??
          data.bonus_pct ??
          data.bonus_percent ??
          50,
      );
  return {
    ok: true,
    success: true,
    status: "success",
    http_status: draw.http_status,
    message: apiMessage(draw, account, "翻牌成功"),
    unlock: unlockResult,
    draw_sent: true,
    prize_name: safeMessage(prize.name, account, "未知奖品").slice(0, 80) || "未知奖品",
    base_prize_quota: rawPrizeQuota,
    prize_quota: quotaWithBonus(rawPrizeQuota, bonusPercent),
    prize_rarity: prizeRarity(prize.rarity),
    bonus_percent: bonusPercent,
    charges_current: hasChargeFields ? chargesCurrent : null,
    extra_draws_left: hasChargeFields ? extraDrawsLeft : null,
    available_after: hasChargeFields ? chargesCurrent + extraDrawsLeft : null,
  };
}

function normalizeQuizText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[?？。，!！:：\s]+/gu, "");
}

function quizOptionText(option) {
  if (option && typeof option === "object" && !Array.isArray(option)) {
    return String(option.text ?? option.label ?? option.value ?? "");
  }
  return String(option ?? "");
}

function knownQuizAnswer(question) {
  const text = normalizeQuizText(question?.text);
  const options = Array.isArray(question?.options) ? question.options : [];
  let target = "";
  if (text.includes("v9.11") && text.includes("v9.9")) target = "v9.11";
  else if (text.includes("9.11") && text.includes("9.9")) target = "9.9";
  if (!target) return -1;
  const normalized = options.map((option) => normalizeQuizText(quizOptionText(option)));
  let index = normalized.findIndex((value) => value === target);
  if (index < 0) index = normalized.findIndex((value) => value.includes(target));
  return index;
}

function quizQuestion(result) {
  const question = result.payload?.data?.question;
  if (!question || typeof question !== "object" || Array.isArray(question)) return null;
  if (!Array.isArray(question.options) || question.options.length === 0 || question.options.length > 20) {
    return null;
  }
  return question;
}

function quizOrder(question) {
  const indices = question.options.map((_, index) => index);
  const known = knownQuizAnswer(question);
  return known < 0 ? indices : [known, ...indices.filter((index) => index !== known)];
}

function quizFingerprint(question) {
  return JSON.stringify([
    normalizeQuizText(question.text),
    question.options.map((option) => normalizeQuizText(quizOptionText(option))),
  ]);
}

async function wait(options, milliseconds) {
  const sleep = options?.sleep ?? ((duration) => new Promise((resolve) => setTimeout(resolve, duration)));
  if (typeof sleep !== "function") throw new TypeError("sleep 必须是函数");
  await sleep(milliseconds);
}

async function runQuiz(accountInput, options = {}) {
  const prepared = operationAccount(accountInput);
  if (prepared.error) return prepared.error;
  const account = prepared.account;
  const unsupported = requireVsllm(account);
  if (unsupported) return unsupported;

  const initialStatus = await getGwentStatus(account, options);
  if (!initialStatus.ok) return { ...initialStatus, reward_ready: false, newly_completed: false };
  const task = initialStatus.quiz;
  if (!task) {
    return {
      ok: false,
      success: false,
      status: "error",
      message: "答题任务状态缺失",
      reward_ready: false,
      newly_completed: false,
    };
  }
  if (task.suspended) {
    return {
      ok: true,
      success: true,
      status: "suspended",
      skipped: true,
      completed: false,
      reward_ready: false,
      newly_completed: false,
      message: "答题任务已暂停",
    };
  }
  if (["completed", "done", "success", "claimed"].includes(task.status)) {
    return {
      ok: true,
      success: true,
      status: "completed",
      skipped: true,
      completed: true,
      reward_ready: false,
      newly_completed: false,
      message: "今日答题已完成",
    };
  }
  if (!["pending", "available", "ready", "in_progress"].includes(task.status)) {
    return {
      ok: false,
      success: false,
      status: "error",
      completed: false,
      reward_ready: false,
      newly_completed: false,
      message: `未知答题任务状态: ${compactText(task.status, "unknown", 24)}`,
    };
  }

  const start = await apiRequestMirrored(account, "/api/gwent/task3/start", { method: "POST" }, options);
  if (!successfulPayload(start)) {
    return {
      ...endpointFailure(start, account, "开始答题失败", { uncertainTransport: !start.received }),
      completed: false,
      reward_ready: false,
      newly_completed: false,
    };
  }
  let question = quizQuestion(start);
  if (!question) {
    return {
      ok: false,
      success: false,
      status: "error",
      completed: false,
      reward_ready: false,
      newly_completed: false,
      message: "答题题目格式异常",
    };
  }

  const maxAttempts = optionNumber(options, "maxQuizAttempts", MAX_QUIZ_ATTEMPTS, 1, MAX_QUIZ_ATTEMPTS);
  const triedByQuestion = new Map();
  const attempts = [];
  for (let attemptNumber = 0; attemptNumber < maxAttempts; attemptNumber += 1) {
    const fingerprint = quizFingerprint(question);
    const tried = triedByQuestion.get(fingerprint) ?? new Set();
    triedByQuestion.set(fingerprint, tried);
    const answerIndex = quizOrder(question).find((index) => !tried.has(index));
    if (answerIndex === undefined) {
      return {
        ok: false,
        success: false,
        status: "error",
        completed: false,
        reward_ready: false,
        newly_completed: false,
        attempts,
        message: "同一题的选项已全部尝试",
      };
    }
    tried.add(answerIndex);

    try {
      await wait(options, attemptNumber === 0 ? 2200 : 800);
    } catch {
      return {
        ok: false,
        success: false,
        status: "error",
        completed: false,
        reward_ready: false,
        newly_completed: false,
        attempts,
        message: "答题等待失败",
      };
    }
    const answer = await apiRequestMirrored(
      account,
      "/api/gwent/task3/answer",
      { method: "POST", json: { answer_index: answerIndex } },
      options,
    );
    if (!successfulPayload(answer)) {
      return {
        ...endpointFailure(answer, account, "提交答案失败", { uncertainTransport: !answer.received }),
        completed: false,
        reward_ready: false,
        newly_completed: false,
        attempts,
      };
    }
    const correct = answer.payload?.data?.correct;
    if (typeof correct !== "boolean") {
      return {
        ok: false,
        success: false,
        status: "uncertain",
        completed: false,
        reward_ready: false,
        newly_completed: false,
        attempts,
        message: "答题结果格式异常",
      };
    }
    attempts.push({ answer_index: answerIndex, correct });
    if (correct) {
      // The answer endpoint only reports `correct`; confirm the charge was
      // actually credited before the caller schedules a reward draw.
      const refreshedStatus = await getGwentStatus(account, options);
      const rewardState = taskRewardState(task, initialStatus, refreshedStatus);
      const rewardMessage = rewardState.reward_status === "confirmed"
        ? "答题完成，奖励可翻牌"
        : rewardState.reward_status === "capped"
          ? "答题完成，但充能已达上限，跳过奖励翻牌"
          : "答题完成，但无法确认充能到账，暂不翻牌";
      return {
        ok: true,
        success: true,
        status: "completed",
        completed: true,
        skipped: false,
        reward_ready: true,
        ...rewardState,
        newly_completed: true,
        attempts,
        message: rewardMessage,
      };
    }

    if (attemptNumber + 1 >= maxAttempts) break;

    const restart = await apiRequestMirrored(account, "/api/gwent/task3/start", { method: "POST" }, options);
    if (!successfulPayload(restart)) {
      return {
        ...endpointFailure(restart, account, "答错后刷新题目失败", {
          uncertainTransport: !restart.received,
        }),
        completed: false,
        reward_ready: false,
        newly_completed: false,
        attempts,
      };
    }
    question = quizQuestion(restart);
    if (!question) {
      return {
        ok: false,
        success: false,
        status: "error",
        completed: false,
        reward_ready: false,
        newly_completed: false,
        attempts,
        message: "刷新响应缺少题目",
      };
    }
  }
  return {
    ok: false,
    success: false,
    status: "error",
    completed: false,
    reward_ready: false,
    newly_completed: false,
    attempts,
    message: `超过 ${maxAttempts} 次答题尝试`,
  };
}

function taskCandidate(payload) {
  const data = payload?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const tasks = data.tasks;
  for (const candidate of [
    tasks && typeof tasks === "object" ? tasks.task2 : null,
    data.task2,
    data.task,
    data,
  ]) {
    if (
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      ["done_count", "daily_cap", "next_available_at", "status", "suspended"].some((key) =>
        Object.prototype.hasOwnProperty.call(candidate, key),
      )
    ) {
      return candidate;
    }
  }
  return null;
}

function applyAdDailyLimit(task, dailyLimit, nowSeconds) {
  if (!task) return null;
  const cap = Math.min(task.daily_cap ?? 3, dailyLimit);
  const completed = task.done_count !== null && task.done_count >= cap;
  let status = task.status;
  if (task.suspended) status = "suspended";
  else if (completed) status = "completed";
  else if (task.next_available_at !== null && task.next_available_at > nowSeconds) status = "cooldown";
  else if (task.done_count !== null && task.next_available_at !== null) status = "available";
  else status = "unknown";
  return { ...task, status, completed, daily_cap: cap };
}

function adResult(result, task, taskStatus = task?.status ?? result.status) {
  if (!task) return result;
  return {
    ...result,
    task,
    task_status: taskStatus,
    completed: task.completed === true,
    done_count: task.done_count,
    daily_cap: task.daily_cap,
    next_available_at: task.next_available_at,
  };
}

async function runAd(accountInput, options = {}) {
  const prepared = operationAccount(accountInput);
  if (prepared.error) return prepared.error;
  const account = prepared.account;
  const unsupported = requireVsllm(account);
  if (unsupported) return unsupported;

  const nowSeconds = nowEpochSeconds(options);
  const dailyLimit = optionNumber(options, "dailyLimit", 3, 1, 3);
  const initialStatus = await getGwentStatus(account, options);
  if (!initialStatus.ok) return { ...initialStatus, reward_ready: false, newly_completed: false };
  const task = applyAdDailyLimit(initialStatus.ad, dailyLimit, nowSeconds);
  if (!task) {
    return {
      ok: false,
      success: false,
      status: "error",
      message: "视频任务状态缺失",
      reward_ready: false,
      newly_completed: false,
    };
  }
  if (task.suspended) {
    return adResult({
      ok: true,
      success: true,
      status: "suspended",
      skipped: true,
      reward_ready: false,
      newly_completed: false,
      message: "视频任务已暂停",
    }, task);
  }
  if (task.done_count === null || task.next_available_at === null) {
    return adResult({
      ok: false,
      success: false,
      status: "error",
      reward_ready: false,
      newly_completed: false,
      message: "视频任务状态字段缺失或格式错误",
    }, { ...task, status: "error", completed: false }, "error");
  }
  if (task.done_count >= task.daily_cap) {
    const completedTask = { ...task, status: "completed", completed: true };
    return adResult({
      ok: true,
      success: true,
      status: "completed",
      skipped: true,
      reward_ready: false,
      newly_completed: false,
      message: "今日视频任务已完成",
    }, completedTask);
  }
  if (task.next_available_at > nowSeconds) {
    const cooldownTask = { ...task, status: "cooldown", completed: false };
    return adResult({
      ok: true,
      success: true,
      status: "cooldown",
      skipped: true,
      reward_ready: false,
      newly_completed: false,
      message: "视频任务冷却中",
    }, cooldownTask);
  }

  const start = await apiRequestMirrored(account, "/api/gwent/ad/start", { method: "POST" }, options);
  if (!successfulPayload(start)) {
    return adResult({
      ...endpointFailure(start, account, "开始视频任务失败", { uncertainTransport: !start.received }),
      reward_ready: false,
      newly_completed: false,
    }, { ...task, status: "error", completed: false }, "error");
  }
  const configuredDuration = normalizeAdDuration(start.payload?.data?.duration_sec) ??
    task.duration_seconds ??
    DEFAULT_AD_DURATION_SECONDS;
  const durationSeconds = Math.max(1, Math.min(MAX_AD_DURATION_SECONDS, configuredDuration));
  try {
    await wait(options, (durationSeconds + 1) * 1000);
  } catch {
    return adResult({
      ok: false,
      success: false,
      status: "error",
      reward_ready: false,
      newly_completed: false,
      duration_seconds: durationSeconds,
      message: "视频等待失败",
    }, { ...task, status: "error", completed: false }, "error");
  }

  const claim = await apiRequestMirrored(account, "/api/gwent/ad/claim", { method: "POST" }, options);
  const claimExplicitSuccess = successfulPayload(claim);
  const claimFailure = claimExplicitSuccess
    ? null
    : endpointFailure(claim, account, "领取视频奖励失败", { uncertainTransport: !claim.received });

  const refreshed = await getGwentStatus(account, options);
  const responseTask = applyAdDailyLimit(
    normalizeAdTask(taskCandidate(claim.payload), nowEpochSeconds(options)),
    dailyLimit,
    nowEpochSeconds(options),
  );
  const refreshedTask = refreshed.ok
    ? applyAdDailyLimit(refreshed.ad, dailyLimit, nowEpochSeconds(options))
    : null;
  const observedTask = refreshedTask ?? responseTask;
  const observedIncrease =
    observedTask?.done_count !== null &&
    observedTask?.done_count !== undefined &&
    observedTask.done_count > task.done_count;
  const rewardReady = claimExplicitSuccess || observedIncrease;
  const rewardState = taskRewardState(task, initialStatus, refreshed);

  if (!rewardReady) {
    const claimUncertain = !claim.received || claim.parse_error !== null;
    const finalTask = observedTask ?? { ...task, status: "unknown", completed: false };
    return adResult({
      ...(claimFailure ?? {
        ok: false,
        success: false,
        status: "uncertain",
        http_status: claim.http_status,
        message: "视频奖励是否到账无法确认",
      }),
      status: claimUncertain ? "uncertain" : (claimFailure?.status ?? "error"),
      reward_ready: false,
      ...rewardState,
      newly_completed: false,
      duration_seconds: durationSeconds,
      before_done_count: task.done_count,
      after_done_count: observedTask?.done_count ?? task.done_count,
    }, finalTask, claimUncertain ? "unknown" : finalTask.status);
  }

  const estimatedDone = Math.min(task.daily_cap, task.done_count + 1);
  const finalDone = Math.max(estimatedDone, observedTask?.done_count ?? 0);
  const dailyCap = Math.min(observedTask?.daily_cap ?? task.daily_cap, dailyLimit, 3);
  const nextAvailableAt = observedTask?.next_available_at ?? task.next_available_at;
  const completed = finalDone >= dailyCap;
  const finalStatus = completed
    ? "completed"
    : nextAvailableAt > nowEpochSeconds(options)
      ? "cooldown"
      : refreshed.ok
        ? "available"
        : "unknown";
  const finalTask = {
    ...task,
    status: finalStatus,
    suspended: false,
    completed,
    done_count: finalDone,
    daily_cap: dailyCap,
    next_available_at: nextAvailableAt,
    duration_seconds: observedTask?.duration_seconds ?? task.duration_seconds,
  };
  const rewardMessage = rewardState.reward_status === "confirmed"
    ? (refreshed.ok ? "视频奖励已领取，可进行奖励翻牌" : "视频奖励已领取，状态刷新失败")
    : rewardState.reward_status === "capped"
      ? "视频奖励已领取，但充能已达上限，跳过奖励翻牌"
      : "视频奖励已领取，但无法确认充能到账，暂不翻牌";
  return adResult({
    ok: true,
    success: true,
    status: "claimed",
    skipped: false,
    reward_ready: true,
    ...rewardState,
    newly_completed: true,
    duration_seconds: durationSeconds,
    before_done_count: task.done_count,
    after_done_count: finalDone,
    message: rewardMessage,
  }, finalTask);
}


const STATIC_ASSETS = Object.freeze({"/index.html":"<!doctype html>\n<html lang=\"zh-CN\">\n  <head>\n    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n    <meta name=\"color-scheme\" content=\"light\">\n    <meta name=\"theme-color\" content=\"#f6f5f1\">\n    <title>签到助手</title>\n    <link rel=\"stylesheet\" href=\"/styles.css\">\n    <script src=\"/app.js\" defer></script>\n  </head>\n  <body>\n    <div class=\"glow glow-a\" aria-hidden=\"true\"></div>\n    <div class=\"glow glow-b\" aria-hidden=\"true\"></div>\n    <div class=\"grid-veil\" aria-hidden=\"true\"></div>\n\n    <section class=\"auth-view\" id=\"authView\" hidden>\n      <form class=\"auth-form\" id=\"authForm\">\n        <label class=\"sr-only\" for=\"accessKey\">访问口令</label>\n        <input id=\"accessKey\" type=\"password\" autocomplete=\"current-password\" placeholder=\"访问口令\" required>\n        <button type=\"submit\">进入</button>\n      </form>\n      <p class=\"form-message\" id=\"authMessage\"></p>\n    </section>\n\n    <div class=\"site-shell\" id=\"siteShell\" hidden>\n      <header class=\"site-header\">\n        <div class=\"brand\" aria-label=\"签到助手\">\n          <span class=\"brand-mark\"></span>\n          <span id=\"brandName\">签到助手</span>\n        </div>\n        <nav class=\"top-nav\" aria-label=\"主导航\">\n          <button class=\"nav-button\" id=\"refreshButton\" type=\"button\">刷新</button>\n          <a href=\"/config.html\">配置</a>\n          <button class=\"nav-button\" id=\"logoutButton\" type=\"button\">退出</button>\n        </nav>\n      </header>\n\n      <main>\n        <section class=\"hero\">\n          <div class=\"hero-left\">\n            <p class=\"eyebrow\" id=\"heroStatus\">读取中</p>\n            <div class=\"hero-balance\">\n              <span>总余额</span>\n              <strong id=\"metricBalance\">—</strong>\n            </div>\n            <div class=\"hero-meta\">\n              <div><span>账号</span><b id=\"metricAccounts\">—</b></div>\n              <div><span>可翻牌</span><b id=\"metricDraws\">—</b></div>\n              <div><span>更新</span><time id=\"updatedAt\">—</time></div>\n            </div>\n          </div>\n          <div class=\"orbit\" aria-hidden=\"true\">\n            <span class=\"orbit-ring r1\"></span>\n            <span class=\"orbit-ring r2\"></span>\n            <span class=\"orbit-ring r3\"></span>\n            <span class=\"orbit-dot d1\"></span>\n            <span class=\"orbit-dot d2\"></span>\n            <span class=\"orbit-dot d3\"></span>\n          </div>\n        </section>\n\n        <section class=\"panel\">\n          <div class=\"panel-head\">\n            <h2>执行</h2>\n            <div class=\"account-picker\">\n              <div class=\"custom-select\" id=\"accountSelect\">\n                <button class=\"custom-select-trigger\" id=\"accountSelectButton\" type=\"button\" aria-haspopup=\"listbox\" aria-expanded=\"false\">\n                  <span id=\"accountSelectLabel\">全部账号</span><i></i>\n                </button>\n                <div class=\"custom-select-menu\" id=\"accountSelectMenu\" role=\"listbox\" hidden></div>\n              </div>\n            </div>\n          </div>\n\n          <div class=\"action-row\" id=\"actionRow\">\n            <button class=\"action-button\" data-action=\"checkin\" type=\"button\"><em>01</em><b>签到</b></button>\n            <button class=\"action-button\" data-action=\"draw\" type=\"button\"><em>02</em><b>翻牌</b></button>\n            <button class=\"action-button\" data-action=\"ad\" type=\"button\"><em>03</em><b>看广告</b></button>\n            <button class=\"action-button\" data-action=\"quiz\" type=\"button\"><em>04</em><b>答题</b></button>\n            <button class=\"run-all-button\" data-action=\"all\" type=\"button\"><b>全部</b><i>↗</i></button>\n          </div>\n\n          <div class=\"run-status\" id=\"runStatus\" hidden>\n            <span class=\"spinner\"></span>\n            <p id=\"runStatusText\">正在执行</p>\n          </div>\n\n          <div class=\"schedule-line\" id=\"scheduleLine\" aria-label=\"自动计划\"></div>\n        </section>\n\n        <section class=\"panel soft-panel\">\n          <div class=\"panel-head\">\n            <h2>账号</h2>\n          </div>\n          <div class=\"account-list\" id=\"accountList\">\n            <p class=\"empty-state\">…</p>\n          </div>\n        </section>\n      </main>\n    </div>\n\n    <div class=\"toast\" id=\"toast\" role=\"status\" aria-live=\"polite\"></div>\n  </body>\n</html>\n","/config.html":"<!doctype html>\n<html lang=\"zh-CN\">\n  <head>\n    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n    <meta name=\"color-scheme\" content=\"light\">\n    <meta name=\"theme-color\" content=\"#f6f5f1\">\n    <title>配置</title>\n    <link rel=\"stylesheet\" href=\"/styles.css\">\n    <script src=\"/config.js\" defer></script>\n  </head>\n  <body>\n    <div class=\"glow glow-a\" aria-hidden=\"true\"></div>\n    <div class=\"glow glow-b\" aria-hidden=\"true\"></div>\n    <div class=\"grid-veil\" aria-hidden=\"true\"></div>\n\n    <section class=\"auth-view\" id=\"authView\" hidden>\n      <form class=\"auth-form\" id=\"authForm\">\n        <label class=\"sr-only\" for=\"accessKey\">访问口令</label>\n        <input id=\"accessKey\" type=\"password\" autocomplete=\"current-password\" placeholder=\"访问口令\" required>\n        <button type=\"submit\">进入</button>\n      </form>\n      <p class=\"form-message\" id=\"authMessage\"></p>\n    </section>\n\n    <div class=\"site-shell\" id=\"siteShell\" hidden>\n      <header class=\"site-header\">\n        <div class=\"brand\" aria-label=\"签到助手\">\n          <span class=\"brand-mark\"></span>\n          <span>签到助手</span>\n        </div>\n        <nav class=\"top-nav\" aria-label=\"配置导航\">\n          <a href=\"/\">控制台</a>\n          <button class=\"nav-button\" id=\"logoutButton\" type=\"button\">退出</button>\n        </nav>\n      </header>\n\n      <main class=\"config-main\">\n        <section class=\"config-hero\">\n          <p class=\"eyebrow\">配置</p>\n          <div class=\"config-art\" aria-hidden=\"true\">\n            <span></span><span></span><span></span>\n          </div>\n        </section>\n\n        <form id=\"settingsForm\">\n          <section class=\"config-block\">\n            <div class=\"config-label\"><em>01</em><h2>常规</h2></div>\n            <div class=\"config-body\">\n              <label class=\"field\">\n                <span>名称</span>\n                <input id=\"siteName\" maxlength=\"40\" placeholder=\"签到助手\">\n              </label>\n              <div class=\"switch-row\">\n                <label class=\"switch-field\">\n                  <span>奖励后自动翻牌</span>\n                  <input id=\"rewardDraw\" type=\"checkbox\">\n                  <i></i>\n                </label>\n                <label class=\"switch-field\">\n                  <span>翻牌 50% 加成</span>\n                  <input id=\"shareBonus\" type=\"checkbox\">\n                  <i></i>\n                </label>\n              </div>\n            </div>\n          </section>\n\n          <section class=\"config-block\">\n            <div class=\"config-label\"><em>02</em><h2>计划</h2></div>\n            <div class=\"config-body\">\n              <div class=\"schedule-editor\" id=\"scheduleEditor\"></div>\n            </div>\n          </section>\n\n          <div class=\"form-actions\">\n            <p id=\"settingsMessage\"></p>\n            <button class=\"primary-button\" type=\"submit\">保存</button>\n          </div>\n        </form>\n\n        <section class=\"config-block accounts-config\">\n          <div class=\"config-label\"><em>03</em><h2>账号</h2></div>\n          <div class=\"config-body\">\n            <div class=\"account-editor\" id=\"accountEditor\"></div>\n            <div class=\"form-actions end-actions\">\n              <p id=\"accountsMessage\"></p>\n              <div class=\"action-cluster\">\n                <button class=\"text-button\" id=\"addAccountButton\" type=\"button\">添加</button>\n                <button class=\"primary-button\" id=\"saveAccountsButton\" type=\"button\">保存</button>\n              </div>\n            </div>\n          </div>\n        </section>\n      </main>\n    </div>\n\n    <template id=\"accountTemplate\">\n      <article class=\"account-edit-row\">\n        <div class=\"account-edit-index\"></div>\n        <div class=\"account-fields\">\n          <label class=\"field\"><span>名称</span><input data-field=\"name\" maxlength=\"64\" placeholder=\"主账号\"></label>\n          <label class=\"field\"><span>站点</span><input data-field=\"url\" type=\"url\" placeholder=\"https://vsllm.cc\"></label>\n          <label class=\"field\"><span>用户 ID</span><input data-field=\"user_id\" maxlength=\"128\" placeholder=\"new-api-user\"></label>\n          <label class=\"field credential-input\"><span>Session</span><input data-field=\"session\" type=\"text\" autocomplete=\"off\" placeholder=\"新账号必填，已有留空\"></label>\n          <label class=\"field credential-input\"><span>令牌</span><input data-field=\"system_token\" type=\"text\" autocomplete=\"off\" placeholder=\"使用令牌时填写\"></label>\n          <div class=\"field auth-mode-field\">\n            <span>使用</span>\n            <div class=\"credential-mode\" data-field=\"auth_mode\" role=\"group\" aria-label=\"凭据类型\">\n              <button type=\"button\" data-mode=\"session\">Session</button>\n              <button type=\"button\" data-mode=\"token\">令牌</button>\n            </div>\n          </div>\n        </div>\n        <div class=\"account-row-actions\">\n          <label class=\"mini-switch\"><input data-field=\"enabled\" type=\"checkbox\" checked><span></span>启用</label>\n          <button class=\"remove-account\" type=\"button\">删除</button>\n        </div>\n      </article>\n    </template>\n\n    <div class=\"toast\" id=\"toast\" role=\"status\" aria-live=\"polite\"></div>\n  </body>\n</html>\n","/styles.css":":root {\n  --bg: #f6f5f1;\n  --bg-soft: #efeee8;\n  --ink: #141714;\n  --muted: #7a7f79;\n  --line: rgba(20, 23, 20, 0.1);\n  --line-strong: rgba(20, 23, 20, 0.18);\n  --surface: rgba(255, 255, 255, 0.55);\n  --surface-strong: rgba(255, 255, 255, 0.82);\n  --accent: #2f6b4f;\n  --accent-soft: rgba(47, 107, 79, 0.1);\n  --warm: #e8c39a;\n  --danger: #b2453a;\n  --page: min(1120px, calc(100vw - 48px));\n  font-family: \"SF Pro Display\", \"Segoe UI\", Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif;\n  color: var(--ink);\n  background: var(--bg);\n  font-synthesis: none;\n  text-rendering: optimizeLegibility;\n}\n\n* { box-sizing: border-box; }\nhtml { min-width: 320px; }\nbody {\n  min-height: 100vh;\n  margin: 0;\n  background: var(--bg);\n  overflow-x: hidden;\n}\nbutton, input { font: inherit; color: inherit; }\nbutton, a { -webkit-tap-highlight-color: transparent; }\na { color: inherit; text-decoration: none; }\n[hidden] { display: none !important; }\n\n.glow {\n  position: fixed;\n  z-index: -2;\n  width: 42vw;\n  height: 42vw;\n  border-radius: 50%;\n  filter: blur(90px);\n  opacity: 0.45;\n  pointer-events: none;\n}\n.glow-a { top: -16vw; right: -8vw; background: #d9eadf; }\n.glow-b { bottom: -20vw; left: -12vw; background: #e4e8f3; }\n\n.grid-veil {\n  position: fixed;\n  inset: 0;\n  z-index: -1;\n  pointer-events: none;\n  background-image:\n    linear-gradient(rgba(20, 23, 20, 0.035) 1px, transparent 1px),\n    linear-gradient(90deg, rgba(20, 23, 20, 0.035) 1px, transparent 1px);\n  background-size: 72px 72px;\n  mask-image: radial-gradient(circle at 50% 20%, #000 0%, transparent 72%);\n}\n\n.sr-only {\n  position: absolute;\n  width: 1px;\n  height: 1px;\n  padding: 0;\n  margin: -1px;\n  overflow: hidden;\n  clip: rect(0, 0, 0, 0);\n  white-space: nowrap;\n  border: 0;\n}\n\n.auth-view {\n  width: min(420px, calc(100vw - 40px));\n  min-height: 100vh;\n  margin: 0 auto;\n  display: grid;\n  place-content: center;\n  gap: 14px;\n}\n.auth-form {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  padding-bottom: 14px;\n  border-bottom: 1px solid var(--line-strong);\n}\n.auth-form input {\n  flex: 1;\n  min-width: 0;\n  border: 0;\n  outline: 0;\n  background: transparent;\n  font-size: 16px;\n  letter-spacing: 0.04em;\n}\n.auth-form button {\n  border: 0;\n  background: transparent;\n  font-size: 14px;\n  font-weight: 600;\n  cursor: pointer;\n}\n.auth-form button::after { content: \" →\"; color: var(--muted); }\n.form-message { min-height: 20px; margin: 0; color: var(--danger); font-size: 12px; }\n\n.site-shell {\n  width: var(--page);\n  margin: 0 auto;\n  padding-bottom: 72px;\n}\n\n.site-header {\n  height: 72px;\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n}\n.brand {\n  display: inline-flex;\n  align-items: center;\n  gap: 10px;\n  font-size: 14px;\n  font-weight: 650;\n  letter-spacing: -0.02em;\n  pointer-events: none;\n  user-select: none;\n}\n.brand-mark {\n  width: 9px;\n  height: 9px;\n  border-radius: 50%;\n  background: var(--ink);\n  box-shadow: 0 0 0 5px rgba(20, 23, 20, 0.06);\n}\n.top-nav {\n  display: flex;\n  align-items: center;\n  gap: 22px;\n  color: var(--muted);\n  font-size: 13px;\n}\n.top-nav a:hover,\n.nav-button:hover { color: var(--ink); }\n.nav-button {\n  padding: 0;\n  border: 0;\n  background: transparent;\n  cursor: pointer;\n}\n\n.hero {\n  position: relative;\n  display: grid;\n  grid-template-columns: 1.1fr 0.9fr;\n  gap: 40px;\n  align-items: center;\n  min-height: 320px;\n  padding: 36px 0 28px;\n}\n.eyebrow {\n  margin: 0 0 18px;\n  color: var(--muted);\n  font-size: 12px;\n  letter-spacing: 0.14em;\n}\n.hero-balance span {\n  display: block;\n  color: var(--muted);\n  font-size: 11px;\n  letter-spacing: 0.12em;\n}\n.hero-balance strong {\n  display: block;\n  margin-top: 10px;\n  font-family: Georgia, \"Times New Roman\", serif;\n  font-size: clamp(56px, 8vw, 88px);\n  font-weight: 400;\n  letter-spacing: -0.05em;\n  line-height: 0.95;\n}\n.hero-meta {\n  display: grid;\n  grid-template-columns: repeat(3, minmax(0, 1fr));\n  gap: 18px;\n  margin-top: 34px;\n  padding-top: 22px;\n  border-top: 1px solid var(--line);\n}\n.hero-meta span {\n  display: block;\n  margin-bottom: 8px;\n  color: var(--muted);\n  font-size: 10px;\n  letter-spacing: 0.12em;\n}\n.hero-meta b,\n.hero-meta time {\n  font-size: 15px;\n  font-weight: 600;\n  letter-spacing: -0.02em;\n}\n\n.orbit {\n  position: relative;\n  width: min(320px, 100%);\n  aspect-ratio: 1;\n  margin-left: auto;\n}\n.orbit-ring,\n.orbit-dot {\n  position: absolute;\n  border-radius: 50%;\n}\n.orbit-ring {\n  inset: 0;\n  border: 1px solid rgba(20, 23, 20, 0.12);\n}\n.orbit-ring.r2 { inset: 18%; border-color: rgba(47, 107, 79, 0.22); }\n.orbit-ring.r3 {\n  inset: 38%;\n  border: 0;\n  background: var(--ink);\n  box-shadow: 0 18px 40px rgba(20, 23, 20, 0.18);\n  animation: core-float 4s ease-in-out infinite;\n}\n.orbit-ring.r1 { animation: spin 28s linear infinite; }\n.orbit-ring.r2 { animation: spin 18s linear infinite reverse; }\n.orbit-ring.r1::before,\n.orbit-ring.r2::before {\n  content: \"\";\n  position: absolute;\n  width: 8px;\n  height: 8px;\n  border-radius: 50%;\n  background: var(--ink);\n}\n.orbit-ring.r1::before {\n  top: 18px;\n  left: 42%;\n  box-shadow: 0 0 0 7px rgba(20, 23, 20, 0.06);\n}\n.orbit-ring.r2::before {\n  top: 50%;\n  right: -4px;\n  background: var(--accent);\n  box-shadow: 0 0 0 7px var(--accent-soft);\n}\n.orbit-dot {\n  width: 14px;\n  height: 14px;\n  background: var(--warm);\n}\n.orbit-dot.d1 { top: 18%; left: 12%; animation: drift 7s ease-in-out infinite; }\n.orbit-dot.d2 { right: 10%; bottom: 24%; width: 8px; height: 8px; background: #8ea7d4; animation: drift 6s ease-in-out infinite reverse; }\n.orbit-dot.d3 { left: 46%; bottom: 8%; width: 6px; height: 6px; background: var(--accent); animation: drift 8s ease-in-out infinite; }\n\n@keyframes spin { to { transform: rotate(360deg); } }\n@keyframes core-float {\n  0%, 100% { transform: translateY(-8px); }\n  50% { transform: translateY(8px); }\n}\n@keyframes drift {\n  0%, 100% { transform: translate(0, 0); }\n  50% { transform: translate(14px, -12px); }\n}\n\n.panel {\n  padding: 42px 0 8px;\n  border-top: 1px solid var(--line-strong);\n}\n.soft-panel { padding-top: 36px; }\n.panel-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 20px;\n  margin-bottom: 22px;\n}\n.panel-head h2,\n.config-label h2 {\n  margin: 0;\n  font-size: 18px;\n  font-weight: 600;\n  letter-spacing: -0.03em;\n}\n\n.custom-select { position: relative; min-width: 168px; }\n.custom-select-trigger {\n  width: 100%;\n  min-height: 40px;\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 16px;\n  padding: 9px 14px;\n  border: 1px solid var(--line);\n  border-radius: 999px;\n  background: var(--surface);\n  cursor: pointer;\n  transition: border-color .16s ease, background .16s ease;\n}\n.custom-select-trigger:hover,\n.custom-select-trigger[aria-expanded=\"true\"] {\n  border-color: var(--line-strong);\n  background: var(--surface-strong);\n}\n.custom-select-trigger i {\n  width: 7px;\n  height: 7px;\n  border-right: 1.5px solid currentColor;\n  border-bottom: 1.5px solid currentColor;\n  transform: rotate(45deg) translateY(-1px);\n  transition: transform .16s ease;\n}\n.custom-select-trigger[aria-expanded=\"true\"] i {\n  transform: rotate(225deg) translate(-1px, -1px);\n}\n.custom-select-menu {\n  position: absolute;\n  z-index: 40;\n  top: calc(100% + 8px);\n  right: 0;\n  width: 100%;\n  min-width: 168px;\n  padding: 6px;\n  border: 1px solid rgba(20, 23, 20, 0.1);\n  border-radius: 16px;\n  background: rgba(250, 249, 245, 0.96);\n  box-shadow: 0 18px 50px rgba(20, 23, 20, 0.12);\n  backdrop-filter: blur(16px);\n  animation: pop .15s ease both;\n}\n.custom-select-option {\n  width: 100%;\n  position: relative;\n  padding: 10px 32px 10px 12px;\n  border: 0;\n  border-radius: 11px;\n  background: transparent;\n  text-align: left;\n  font-size: 13px;\n  cursor: pointer;\n}\n.custom-select-option:hover { background: rgba(20, 23, 20, 0.05); }\n.custom-select-option.selected {\n  font-weight: 650;\n  background: var(--accent-soft);\n}\n.custom-select-option.selected::after {\n  content: \"\";\n  position: absolute;\n  top: 50%;\n  right: 13px;\n  width: 6px;\n  height: 10px;\n  border-right: 1.5px solid var(--accent);\n  border-bottom: 1.5px solid var(--accent);\n  transform: translateY(-65%) rotate(45deg);\n}\n@keyframes pop {\n  from { opacity: 0; transform: translateY(-6px) scale(.98); }\n  to { opacity: 1; transform: translateY(0) scale(1); }\n}\n\n.action-row {\n  display: grid;\n  grid-template-columns: repeat(4, 1fr) 1.15fr;\n  border-top: 1px solid var(--line-strong);\n  border-bottom: 1px solid var(--line-strong);\n}\n.action-button,\n.run-all-button {\n  min-height: 168px;\n  padding: 22px;\n  border: 0;\n  border-right: 1px solid var(--line);\n  background: transparent;\n  text-align: left;\n  cursor: pointer;\n  transition: background .16s ease;\n}\n.action-button:hover { background: rgba(255, 255, 255, 0.42); }\n.action-button:active,\n.run-all-button:active { transform: translateY(1px); }\n.action-button em {\n  display: block;\n  color: var(--muted);\n  font-style: normal;\n  font-size: 11px;\n  letter-spacing: 0.12em;\n}\n.action-button b {\n  display: block;\n  margin-top: 48px;\n  font-size: 20px;\n  font-weight: 600;\n  letter-spacing: -0.03em;\n}\n.run-all-button {\n  display: flex;\n  align-items: flex-end;\n  justify-content: space-between;\n  border-right: 0;\n  color: #fff;\n  background: var(--ink);\n}\n.run-all-button:hover { background: #252925; }\n.run-all-button b {\n  font-size: 20px;\n  font-weight: 600;\n}\n.run-all-button i {\n  font-style: normal;\n  font-size: 24px;\n  font-weight: 400;\n  line-height: 1;\n}\n.action-row button:disabled {\n  opacity: 0.48;\n  cursor: wait;\n}\n\n.run-status {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 16px 0 0;\n  color: var(--muted);\n  font-size: 13px;\n}\n.run-status p { margin: 0; }\n.spinner {\n  width: 13px;\n  height: 13px;\n  border: 1.5px solid var(--line-strong);\n  border-top-color: var(--ink);\n  border-radius: 50%;\n  animation: spin .8s linear infinite;\n}\n\n.schedule-line {\n  display: grid;\n  grid-template-columns: repeat(4, 1fr);\n  margin-top: 18px;\n  padding: 8px 0 4px;\n}\n.schedule-item {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  min-height: 42px;\n  padding: 0 16px;\n  border-right: 1px solid var(--line);\n  font-size: 12px;\n}\n.schedule-item:first-child { padding-left: 0; }\n.schedule-item:last-child { border-right: 0; padding-right: 0; }\n.schedule-item span {\n  width: 6px;\n  height: 6px;\n  border-radius: 50%;\n  background: var(--accent);\n  flex: 0 0 auto;\n}\n.schedule-item em {\n  font-style: normal;\n  color: var(--ink);\n}\n.schedule-item b {\n  margin-left: auto;\n  font-weight: 600;\n  color: var(--muted);\n}\n.schedule-item.disabled { color: var(--muted); }\n.schedule-item.disabled span { background: #b7bbb6; }\n.schedule-item.disabled em { color: var(--muted); }\n\n.account-list { border-top: 1px solid var(--line); }\n.account-row {\n  display: grid;\n  grid-template-columns: minmax(180px, 1.35fr) repeat(4, minmax(90px, .8fr));\n  gap: 18px;\n  align-items: center;\n  min-height: 108px;\n  border-bottom: 1px solid var(--line);\n}\n.account-row.account-simple {\n  grid-template-columns: minmax(180px, 1.35fr) repeat(2, minmax(120px, .8fr));\n}\n.account-identity h3 {\n  margin: 0 0 6px;\n  font-size: 16px;\n  font-weight: 600;\n  letter-spacing: -0.02em;\n}\n.account-identity p,\n.empty-state {\n  margin: 0;\n  color: var(--muted);\n  font-size: 12px;\n}\n.empty-state { padding: 28px 0; }\n.account-data span,\n.task-data span {\n  display: block;\n  margin-bottom: 8px;\n  color: var(--muted);\n  font-size: 10px;\n  letter-spacing: 0.1em;\n}\n.account-data b {\n  font-family: Georgia, \"Times New Roman\", serif;\n  font-size: 24px;\n  font-weight: 400;\n}\n.account-data small {\n  display: block;\n  margin-top: 5px;\n  color: var(--muted);\n  font-size: 11px;\n}\n.task-data b {\n  display: inline-flex;\n  align-items: center;\n  gap: 8px;\n  font-size: 13px;\n  font-weight: 550;\n}\n.task-data b::before {\n  content: \"\";\n  width: 6px;\n  height: 6px;\n  border-radius: 50%;\n  background: #9aa09a;\n}\n.task-data b.success::before,\n.task-data b.completed::before,\n.task-data b.available::before { background: #3f9a63; }\n.task-data b.cooldown::before { background: #d0a15d; }\n.task-data b.error::before,\n.task-data b.auth::before { background: #c55446; }\n.account-disabled { opacity: 0.45; }\n\n.toast {\n  position: fixed;\n  z-index: 50;\n  right: 22px;\n  bottom: 22px;\n  max-width: min(340px, calc(100vw - 40px));\n  padding: 12px 16px;\n  border-radius: 12px;\n  color: #fff;\n  background: var(--ink);\n  box-shadow: 0 16px 44px rgba(20, 23, 20, 0.18);\n  font-size: 13px;\n  line-height: 1.45;\n  opacity: 0;\n  transform: translateY(12px);\n  pointer-events: none;\n  transition: .2s ease;\n}\n.toast.visible {\n  opacity: 1;\n  transform: translateY(0);\n}\n\n.config-main { padding-bottom: 40px; }\n.config-hero {\n  position: relative;\n  min-height: 160px;\n  display: flex;\n  align-items: flex-end;\n  justify-content: space-between;\n  padding: 28px 0 24px;\n  border-bottom: 1px solid var(--line-strong);\n  margin-bottom: 8px;\n}\n.config-hero .eyebrow {\n  margin: 0;\n  font-size: 28px;\n  letter-spacing: -0.04em;\n  color: var(--ink);\n  font-weight: 600;\n}\n.config-art {\n  position: relative;\n  width: 180px;\n  height: 72px;\n}\n.config-art span {\n  position: absolute;\n  display: block;\n  border-radius: 999px;\n  background: var(--ink);\n}\n.config-art span:nth-child(1) {\n  top: 18px;\n  right: 0;\n  width: 140px;\n  height: 1px;\n  transform-origin: right center;\n  animation: sway 8s ease-in-out infinite;\n}\n.config-art span:nth-child(2) {\n  top: 42px;\n  right: 18px;\n  width: 110px;\n  height: 1px;\n  background: #8a958d;\n  transform-origin: right center;\n  animation: sway 10s ease-in-out infinite reverse;\n}\n.config-art span:nth-child(3) {\n  top: 10px;\n  right: 8px;\n  width: 10px;\n  height: 10px;\n  background: var(--accent);\n  animation: drift 6s ease-in-out infinite;\n}\n@keyframes sway {\n  0%, 100% { transform: rotate(-7deg) scaleX(.86); }\n  50% { transform: rotate(7deg) scaleX(1); }\n}\n\n.config-block {\n  display: grid;\n  grid-template-columns: 140px 1fr;\n  gap: 36px;\n  padding: 36px 0;\n  border-bottom: 1px solid var(--line);\n}\n.config-label {\n  display: flex;\n  align-items: flex-start;\n  gap: 12px;\n}\n.config-label em {\n  padding-top: 4px;\n  color: var(--muted);\n  font-style: normal;\n  font-size: 11px;\n  letter-spacing: 0.12em;\n}\n.config-body {\n  display: grid;\n  gap: 8px;\n}\n.field {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n.field > span {\n  color: var(--muted);\n  font-size: 11px;\n  letter-spacing: 0.08em;\n}\n.field input,\n.schedule-select-trigger {\n  width: 100%;\n  padding: 12px 0;\n  border: 0;\n  border-bottom: 1px solid var(--line-strong);\n  border-radius: 0;\n  outline: 0;\n  background: transparent;\n}\n.field input:focus,\n.schedule-select-trigger:focus { border-color: var(--ink); }\n\n.switch-row {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 0 28px;\n  border-top: 1px solid var(--line);\n}\n.switch-field {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 20px;\n  min-height: 56px;\n  padding: 8px 0;\n  cursor: pointer;\n}\n.switch-field span { font-size: 14px; }\n.switch-field input { position: absolute; opacity: 0; }\n.switch-field i,\n.mini-switch span {\n  position: relative;\n  flex: 0 0 auto;\n  width: 40px;\n  height: 22px;\n  border-radius: 999px;\n  background: #cfd2cc;\n  transition: .16s ease;\n}\n.switch-field i::after,\n.mini-switch span::after {\n  content: \"\";\n  position: absolute;\n  top: 3px;\n  left: 3px;\n  width: 16px;\n  height: 16px;\n  border-radius: 50%;\n  background: #fff;\n  box-shadow: 0 1px 3px rgba(0,0,0,.12);\n  transition: .16s ease;\n}\n.switch-field input:checked + i,\n.mini-switch input:checked + span { background: var(--ink); }\n.switch-field input:checked + i::after,\n.mini-switch input:checked + span::after { transform: translateX(18px); }\n\n.schedule-editor { border-top: 1px solid var(--line); }\n.schedule-edit-row {\n  display: grid;\n  grid-template-columns: 120px 1fr 1fr;\n  gap: 18px;\n  align-items: center;\n  min-height: 78px;\n  border-bottom: 1px solid var(--line);\n}\n.schedule-name {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  font-size: 14px;\n  font-weight: 600;\n}\n.schedule-name input {\n  width: 15px;\n  height: 15px;\n  accent-color: var(--ink);\n}\n.schedule-control {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  color: var(--muted);\n  font-size: 12px;\n}\n.schedule-select { position: relative; flex: 1; min-width: 100px; }\n.schedule-select-trigger {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  color: var(--ink);\n  text-align: left;\n  cursor: pointer;\n  background: transparent;\n}\n.schedule-select-trigger i {\n  width: 7px;\n  height: 7px;\n  border-right: 1.5px solid currentColor;\n  border-bottom: 1.5px solid currentColor;\n  transform: rotate(45deg) translateY(-1px);\n  transition: transform .16s ease;\n}\n.schedule-select-trigger[aria-expanded=\"true\"] i {\n  transform: rotate(225deg) translate(-1px, -1px);\n}\n.schedule-select-menu {\n  position: absolute;\n  z-index: 40;\n  top: calc(100% + 8px);\n  right: 0;\n  width: 100%;\n  min-width: 110px;\n  max-height: 220px;\n  overflow-y: auto;\n  padding: 6px;\n  border: 1px solid rgba(20, 23, 20, 0.1);\n  border-radius: 14px;\n  background: rgba(250, 249, 245, 0.98);\n  box-shadow: 0 16px 42px rgba(20, 23, 20, 0.12);\n  backdrop-filter: blur(14px);\n  animation: pop .15s ease both;\n}\n.schedule-select-option {\n  position: relative;\n  width: 100%;\n  padding: 9px 28px 9px 10px;\n  border: 0;\n  border-radius: 9px;\n  background: transparent;\n  text-align: left;\n  font-size: 12px;\n  cursor: pointer;\n}\n.schedule-select-option:hover { background: rgba(20, 23, 20, 0.05); }\n.schedule-select-option.selected {\n  font-weight: 650;\n  background: var(--accent-soft);\n}\n.schedule-select-option.selected::after {\n  content: \"\";\n  position: absolute;\n  top: 50%;\n  right: 11px;\n  width: 5px;\n  height: 9px;\n  border-right: 1.5px solid var(--accent);\n  border-bottom: 1.5px solid var(--accent);\n  transform: translateY(-65%) rotate(45deg);\n}\n\n.form-actions {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 18px;\n  padding: 22px 0 8px;\n}\n.form-actions p {\n  margin: 0;\n  color: var(--muted);\n  font-size: 12px;\n}\n.end-actions { padding-top: 18px; }\n.action-cluster {\n  display: flex;\n  align-items: center;\n  gap: 18px;\n}\n.primary-button,\n.text-button {\n  border: 0;\n  cursor: pointer;\n}\n.primary-button {\n  min-width: 104px;\n  padding: 12px 18px;\n  border-radius: 999px;\n  color: #fff;\n  background: var(--ink);\n  font-weight: 650;\n}\n.primary-button:hover { background: #252925; }\n.text-button {\n  padding: 10px 0;\n  background: transparent;\n  font-weight: 600;\n  color: var(--muted);\n}\n.text-button:hover { color: var(--ink); }\n\n.account-editor { border-top: 1px solid var(--line); }\n.account-edit-row {\n  display: grid;\n  grid-template-columns: 36px 1fr auto;\n  gap: 18px;\n  padding: 26px 0;\n  border-bottom: 1px solid var(--line);\n}\n.account-edit-index {\n  padding-top: 18px;\n  color: var(--muted);\n  font: italic 18px Georgia, serif;\n}\n.account-fields {\n  display: grid;\n  grid-template-columns: 1fr 1.3fr 1fr;\n  gap: 18px 22px;\n}\n.credential-input { transition: opacity .16s ease; }\n.credential-input.inactive { opacity: .42; }\n.auth-mode-field { justify-content: flex-end; }\n.credential-mode {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  padding: 3px;\n  border: 1px solid var(--line);\n  border-radius: 999px;\n  background: rgba(20, 23, 20, 0.035);\n}\n.credential-mode button {\n  min-height: 34px;\n  padding: 7px 14px;\n  border: 0;\n  border-radius: 999px;\n  color: var(--muted);\n  background: transparent;\n  font-size: 12px;\n  cursor: pointer;\n  transition: color .16s ease, background .16s ease, box-shadow .16s ease;\n}\n.credential-mode button.selected {\n  color: var(--ink);\n  background: var(--surface-strong);\n  box-shadow: 0 2px 10px rgba(20, 23, 20, .08);\n}\n.account-row-actions {\n  display: flex;\n  flex-direction: column;\n  justify-content: space-between;\n  align-items: flex-end;\n  padding: 14px 0 4px;\n}\n.mini-switch {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  color: var(--muted);\n  font-size: 11px;\n  cursor: pointer;\n}\n.mini-switch input { position: absolute; opacity: 0; }\n.mini-switch span { width: 32px; height: 18px; }\n.mini-switch span::after { width: 12px; height: 12px; }\n.mini-switch input:checked + span::after { transform: translateX(14px); }\n.remove-account {\n  padding: 0;\n  border: 0;\n  color: var(--danger);\n  background: transparent;\n  font-size: 11px;\n  cursor: pointer;\n}\n\n@media (max-width: 980px) {\n  :root { --page: min(100% - 36px, 920px); }\n  .hero { grid-template-columns: 1fr; min-height: auto; }\n  .orbit { margin: 0 auto; width: min(260px, 70vw); }\n  .action-row { grid-template-columns: repeat(4, 1fr); }\n  .run-all-button { grid-column: 1 / -1; min-height: 96px; }\n  .account-row { grid-template-columns: 1.2fr repeat(2, 1fr); padding: 22px 0; }\n  .account-row > :nth-child(n+4) { grid-column: span 1; }\n  .config-block { grid-template-columns: 110px 1fr; gap: 24px; }\n  .account-fields { grid-template-columns: 1fr 1fr; }\n}\n\n@media (max-width: 720px) {\n  :root { --page: calc(100% - 28px); }\n  .site-header { height: 64px; }\n  .top-nav { gap: 16px; }\n  .hero { padding-top: 18px; }\n  .hero-balance strong { font-size: clamp(48px, 14vw, 68px); }\n  .hero-meta { grid-template-columns: 1fr 1fr 1fr; gap: 12px; }\n  .action-row { grid-template-columns: 1fr 1fr; }\n  .action-button { min-height: 132px; }\n  .action-button:nth-child(2n) { border-right: 0; }\n  .action-button b { margin-top: 34px; }\n  .schedule-line { grid-template-columns: 1fr 1fr; }\n  .schedule-item { padding: 8px 12px; min-height: 48px; }\n  .schedule-item:nth-child(2n) { border-right: 0; }\n  .schedule-item:nth-child(n+3) { border-top: 1px solid var(--line); }\n  .account-row {\n    grid-template-columns: 1fr 1fr;\n    gap: 18px 12px;\n    padding: 22px 0;\n  }\n  .account-identity { grid-column: 1 / -1; }\n  .config-block { display: block; }\n  .config-label { margin-bottom: 18px; }\n  .schedule-edit-row {\n    grid-template-columns: 1fr 1fr;\n    padding: 14px 0;\n  }\n  .schedule-name { grid-column: 1 / -1; }\n  .account-edit-row { grid-template-columns: 28px 1fr; }\n  .account-fields { grid-template-columns: 1fr; }\n  .account-row-actions {\n    grid-column: 2;\n    flex-direction: row;\n    align-items: center;\n    padding-top: 0;\n  }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after {\n    animation-duration: 0.01ms !important;\n    transition-duration: 0.01ms !important;\n  }\n}","/app.js":"const KEY_NAME = \"daily-desk-access-key\";\nconst actionLabels = { checkin: \"签到\", draw: \"翻牌\", ad: \"看广告\", quiz: \"答题\", all: \"全部任务\" };\nconst statusLabels = {\n  success: \"成功\",\n  completed: \"已完成\",\n  claimed: \"已领取\",\n  available: \"可执行\",\n  cooldown: \"冷却中\",\n  suspended: \"已暂停\",\n  skipped: \"已跳过\",\n  auth: \"凭据失效\",\n  error: \"失败\",\n  uncertain: \"待确认\",\n  unknown: \"未知\",\n};\n\nconst $ = (selector) => document.querySelector(selector);\nconst authView = $(\"#authView\");\nconst siteShell = $(\"#siteShell\");\nconst authForm = $(\"#authForm\");\nconst authMessage = $(\"#authMessage\");\nconst toast = $(\"#toast\");\nlet toastTimer;\nlet selectedAccountId = \"all\";\n\nfunction element(tag, className, text) {\n  const node = document.createElement(tag);\n  if (className) node.className = className;\n  if (text !== undefined) node.textContent = text;\n  return node;\n}\n\nfunction key() {\n  return localStorage.getItem(KEY_NAME) || \"\";\n}\n\nasync function api(path, options = {}) {\n  const k = key();\n  const headers = new Headers(options.headers || {});\n  headers.set(\"Authorization\", `Bearer ${k}`);\n  if (options.body) headers.set(\"Content-Type\", \"application/json\");\n  let response = await fetch(path, { ...options, headers });\n  if (response.status === 401 && k) {\n    const retry = path + (path.includes(\"?\") ? \"&\" : \"?\") + \"key=\" + encodeURIComponent(k);\n    response = await fetch(retry, { ...options, headers });\n  }\n  const data = await response.json().catch(() => ({}));\n  if (response.status === 401) {\n    localStorage.removeItem(KEY_NAME);\n    showAuth(data.error || \"口令错误\");\n    throw new Error(data.error || \"访问口令不正确\");\n  }\n  if (!response.ok) throw new Error(data.error || \"失败\");\n  return data;\n}\n\nfunction showAuth(message = \"\") {\n  authView.hidden = false;\n  siteShell.hidden = true;\n  authMessage.textContent = message;\n  $(\"#accessKey\").focus();\n}\n\nfunction showApp() {\n  authView.hidden = true;\n  siteShell.hidden = false;\n}\n\nfunction notify(message) {\n  clearTimeout(toastTimer);\n  toast.textContent = message;\n  toast.classList.add(\"visible\");\n  toastTimer = setTimeout(() => toast.classList.remove(\"visible\"), 3200);\n}\n\nfunction formatBalance(value) {\n  const amount = Number(value || 0) / 500000;\n  return Number.isFinite(amount) ? `¥${amount.toFixed(2)}` : \"—\";\n}\n\nfunction formatDate(value, withDate = true) {\n  if (!value) return \"—\";\n  const date = new Date(value);\n  if (Number.isNaN(date.getTime())) return \"—\";\n  return new Intl.DateTimeFormat(\"zh-CN\", {\n    timeZone: \"Asia/Shanghai\",\n    ...(withDate ? { month: \"2-digit\", day: \"2-digit\" } : {}),\n    hour: \"2-digit\",\n    minute: \"2-digit\",\n    hourCycle: \"h23\",\n  }).format(date);\n}\n\nfunction taskLabel(task) {\n  if (!task) return { text: \"暂无状态\", className: \"unknown\" };\n  if (task.done_count !== null && task.done_count !== undefined) {\n    return { text: `${task.done_count}/${task.daily_cap ?? 3} · ${statusLabels[task.status] || task.status}`, className: task.status };\n  }\n  return { text: statusLabels[task.status] || task.status, className: task.status };\n}\n\nfunction renderMetrics(data) {\n  const accounts = data.accounts || [];\n  const available = accounts.reduce((sum, account) => sum + Math.max(0, Number(account.is_vsllm ? account.available_draws || 0 : 0)), 0);\n  const quotaAccounts = accounts.filter((account) => account.balance_quota !== null && account.balance_quota !== undefined && Number.isFinite(Number(account.balance_quota)));\n  const gemsAccounts = accounts.filter((account) => account.balance_gems !== null && account.balance_gems !== undefined && Number.isFinite(Number(account.balance_gems)));\n  const quota = quotaAccounts.reduce((sum, account) => sum + Math.max(0, Number(account.balance_quota)), 0);\n  const gems = gemsAccounts.reduce((sum, account) => sum + Math.max(0, Number(account.balance_gems)), 0);\n  const parts = [];\n  if (quotaAccounts.length) parts.push(formatBalance(quota));\n  if (gemsAccounts.length) parts.push(String(gems) + \" Gems\");\n  $(\"#metricBalance\").textContent = parts.length ? parts.join(\" · \") : \"—\";\n  $(\"#metricAccounts\").textContent = String(accounts.length).padStart(2, \"0\");\n  $(\"#metricDraws\").textContent = String(available).padStart(2, \"0\");\n}\n\nfunction renderSchedule(settings) {\n  const target = $(\"#scheduleLine\");\n  target.replaceChildren();\n  const names = { checkin: \"签到\", quiz: \"答题\", draw: \"翻牌\", ad: \"广告\" };\n  for (const task of [\"checkin\", \"quiz\", \"draw\", \"ad\"]) {\n    const config = settings.schedule[task];\n    const item = element(\"div\", `schedule-item${config.enabled ? \"\" : \" disabled\"}`);\n    item.append(element(\"span\"), element(\"em\", \"\", names[task]));\n    const timing = task === \"draw\" || task === \"ad\"\n      ? `${String(config.hour).padStart(2, \"0\")}:00 / 每 ${config.interval_hours} 小时`\n      : `${String(config.hour).padStart(2, \"0\")}:00`;\n    item.append(element(\"b\", \"\", config.enabled ? timing : \"已停用\"));\n    target.append(item);\n  }\n}\n\nfunction closeAccountSelect() {\n  $(\"#accountSelectMenu\").hidden = true;\n  $(\"#accountSelectButton\").setAttribute(\"aria-expanded\", \"false\");\n}\n\nfunction chooseAccount(value, label) {\n  selectedAccountId = String(value);\n  $(\"#accountSelectLabel\").textContent = label;\n  $(\"#accountSelectMenu\").querySelectorAll(\".custom-select-option\").forEach((button) => {\n    const isSelected = String(button.dataset.value || \"\") === selectedAccountId;\n    button.classList.toggle(\"selected\", isSelected);\n    button.setAttribute(\"aria-selected\", String(isSelected));\n  });\n  closeAccountSelect();\n}\n\nfunction renderAccountSelect(accounts) {\n  const options = [\n    { value: \"all\", label: \"全部账号\" },\n    ...accounts.filter((item) => item.enabled).map((item) => ({ value: String(item.id), label: item.name })),\n  ];\n  if (!options.some((option) => option.value === selectedAccountId)) selectedAccountId = \"all\";\n  const selected = options.find((option) => option.value === selectedAccountId) || options[0];\n  $(\"#accountSelectLabel\").textContent = selected.label;\n  const menu = $(\"#accountSelectMenu\");\n  menu.replaceChildren();\n  for (const option of options) {\n    const button = element(\"button\", \"custom-select-option\" + (option.value === selectedAccountId ? \" selected\" : \"\"), option.label);\n    button.type = \"button\";\n    button.dataset.value = option.value;\n    button.setAttribute(\"role\", \"option\");\n    button.setAttribute(\"aria-selected\", String(option.value === selectedAccountId));\n    button.addEventListener(\"click\", () => chooseAccount(option.value, option.label));\n    menu.append(button);\n  }\n}\n\nfunction renderAccounts(accounts) {\n  const target = $(\"#accountList\");\n  target.replaceChildren();\n  if (!accounts.length) {\n    target.append(element(\"p\", \"empty-state\", \"暂无账号\"));\n    return;\n  }\n  for (const account of accounts) {\n    const row = element(\"article\", `account-row${account.is_vsllm ? \"\" : \" account-simple\"}${account.enabled ? \"\" : \" account-disabled\"}`);\n    const identity = element(\"div\", \"account-identity\");\n    const identityMeta = account.is_vsllm ? `${account.host} · ID ${account.user_id}` : account.host;\n    identity.append(element(\"h3\", \"\", account.name), element(\"p\", \"\", identityMeta));\n\n    const balance = element(\"div\", \"account-data\");\n    const balanceText = account.is_yesnai\n      ? (account.balance_gems === null || account.balance_gems === undefined ? \"—\" : String(account.balance_gems) + \" Gems\")\n      : (account.balance_quota === null || account.balance_quota === undefined ? \"—\" : formatBalance(account.balance_quota));\n    balance.append(element(\"span\", \"\", \"余额\"), element(\"b\", \"\", balanceText), element(\"small\", \"\", account.balance?.ok ? \"当前余额\" : account.balance?.message || \"读取失败\"));\n\n    if (!account.is_vsllm) {\n      const checkin = element(\"div\", \"task-data\");\n      const checkinStatus = account.checkin_status || \"unknown\";\n      const checkinState = taskLabel({ status: checkinStatus });\n      const checkinDone = [\"success\", \"completed\", \"claimed\"].includes(checkinStatus);\n      const checkinText = checkinDone\n        ? \"已签到\"\n        : (account.checkin_message || (checkinStatus === \"unknown\" ? \"等待运行\" : checkinState.text));\n      checkin.append(element(\"span\", \"\", \"签到\"), element(\"b\", checkinState.className, checkinText));\n      row.append(identity, balance, checkin);\n      target.append(row);\n      continue;\n    }\n\n    const draws = element(\"div\", \"account-data\");\n    draws.append(element(\"span\", \"\", \"可翻牌\"), element(\"b\", \"\", account.available_draws ?? \"—\"), element(\"small\", \"\", account.charges_max === null ? \"可用次数\" : `充能 ${account.charges_current ?? 0}/${account.charges_max}`));\n    const quiz = element(\"div\", \"task-data\");\n    const quizState = taskLabel(account.quiz);\n    quiz.append(element(\"span\", \"\", \"答题\"), element(\"b\", quizState.className, quizState.text));\n    const ad = element(\"div\", \"task-data\");\n    const adState = taskLabel(account.ad);\n    ad.append(element(\"span\", \"\", \"广告\"), element(\"b\", adState.className, adState.text));\n    row.append(identity, balance, draws, quiz, ad);\n    target.append(row);\n  }\n}\n\nfunction render(data) {\n  document.title = data.settings.site_name;\n  $(\"#brandName\").textContent = data.settings.site_name;\n  $(\"#updatedAt\").textContent = formatDate(data.updated_at, false);\n  $(\"#heroStatus\").textContent = data.accounts.length ? \"\" : \"空\";\n  renderMetrics(data);\n  renderSchedule(data.settings);\n  renderAccountSelect(data.accounts);\n  renderAccounts(data.accounts);\n}\n\nasync function loadDashboard({ quiet = false } = {}) {\n  if (!quiet) $(\"#heroStatus\").textContent = \"读取中\";\n  const data = await api(\"/api/dashboard\");\n  showApp();\n  render(data);\n}\n\nfunction runSummary(data) {\n  const steps = data.results.flatMap((account) => account.steps);\n  const success = steps.filter((step) => step.result.ok).length;\n  return `${actionLabels[data.action]} ${success}/${steps.length}`;\n}\n\nasync function run(action) {\n  const buttons = [...document.querySelectorAll(\"[data-action]\")];\n  const selected = selectedAccountId;\n  buttons.forEach((button) => { button.disabled = true; });\n  $(\"#runStatus\").hidden = false;\n  $(\"#runStatusText\").textContent = `执行中 · ${actionLabels[action]}`\n  try {\n    const data = await api(\"/api/run\", {\n      method: \"POST\",\n      body: JSON.stringify({ action, account_id: selected }),\n    });\n    notify(runSummary(data));\n    await loadDashboard({ quiet: true });\n  } catch (error) {\n    notify(error.message);\n  } finally {\n    buttons.forEach((button) => { button.disabled = false; });\n    $(\"#runStatus\").hidden = true;\n  }\n}\n\nauthForm.addEventListener(\"submit\", async (event) => {\n  event.preventDefault();\n  const value = $(\"#accessKey\").value.trim();\n  if (!value) return;\n  localStorage.setItem(KEY_NAME, value);\n  authMessage.textContent = \"…\";\n  showApp();\n  loadDashboard().catch((error) => {\n    if (authView.hidden) {\n      $(\"#heroStatus\").textContent = \"加载失败，点刷新重试\";\n      notify(error.message);\n    } else {\n      authMessage.textContent = error.message;\n    }\n  });\n});\n\n$(\"#logoutButton\").addEventListener(\"click\", () => {\n  localStorage.removeItem(KEY_NAME);\n  showAuth();\n});\n\n$(\"#refreshButton\").addEventListener(\"click\", async () => {\n  try {\n    await loadDashboard();\n    notify(\"已刷新\");\n  } catch (error) {\n    notify(error.message);\n  }\n});\n\n$(\"#accountSelectButton\").addEventListener(\"click\", (event) => {\n  event.stopPropagation();\n  const menu = $(\"#accountSelectMenu\");\n  menu.hidden = !menu.hidden;\n  $(\"#accountSelectButton\").setAttribute(\"aria-expanded\", String(!menu.hidden));\n});\n$(\"#accountSelectMenu\").addEventListener(\"click\", (event) => event.stopPropagation());\ndocument.addEventListener(\"click\", closeAccountSelect);\ndocument.addEventListener(\"keydown\", (event) => { if (event.key === \"Escape\") closeAccountSelect(); });\ndocument.querySelectorAll(\"[data-action]\").forEach((button) => button.addEventListener(\"click\", () => run(button.dataset.action)));\n\nif (key()) {\n  showApp();\n  loadDashboard().catch((error) => {\n    if (authView.hidden) {\n      $(\"#heroStatus\").textContent = \"加载失败，点刷新重试\";\n      notify(error.message);\n    }\n  });\n} else {\n  showAuth();\n}\n","/config.js":"const KEY_NAME = \"daily-desk-access-key\";\nconst taskNames = { checkin: \"签到\", quiz: \"答题\", draw: \"翻牌\", ad: \"看广告\" };\nconst intervalOptions = [1, 2, 3, 4, 6, 8, 12, 24];\nconst $ = (selector) => document.querySelector(selector);\nconst authView = $(\"#authView\");\nconst siteShell = $(\"#siteShell\");\nconst authMessage = $(\"#authMessage\");\nconst toast = $(\"#toast\");\nlet accounts = [];\nlet settings = null;\nlet toastTimer;\n\nfunction key() {\n  return localStorage.getItem(KEY_NAME) || \"\";\n}\n\nasync function api(path, options = {}) {\n  const k = key();\n  const headers = new Headers(options.headers || {});\n  headers.set(\"Authorization\", `Bearer ${k}`);\n  if (options.body) headers.set(\"Content-Type\", \"application/json\");\n  let response = await fetch(path, { ...options, headers });\n  if (response.status === 401 && k) {\n    const retry = path + (path.includes(\"?\") ? \"&\" : \"?\") + \"key=\" + encodeURIComponent(k);\n    response = await fetch(retry, { ...options, headers });\n  }\n  const data = await response.json().catch(() => ({}));\n  if (response.status === 401) {\n    localStorage.removeItem(KEY_NAME);\n    showAuth(data.error || \"口令错误\");\n    throw new Error(data.error || \"访问口令不正确\");\n  }\n  if (!response.ok) throw new Error(data.error || \"失败\");\n  return data;\n}\n\nfunction showAuth(message = \"\") {\n  authView.hidden = false;\n  siteShell.hidden = true;\n  authMessage.textContent = message;\n  $(\"#accessKey\").focus();\n}\n\nfunction showApp() {\n  authView.hidden = true;\n  siteShell.hidden = false;\n}\n\nfunction notify(message) {\n  clearTimeout(toastTimer);\n  toast.textContent = message;\n  toast.classList.add(\"visible\");\n  toastTimer = setTimeout(() => toast.classList.remove(\"visible\"), 3200);\n}\n\nfunction closeScheduleSelects(except = null) {\n  document.querySelectorAll(\".schedule-select-menu\").forEach((menu) => {\n    if (menu !== except) {\n      menu.hidden = true;\n      menu.previousElementSibling?.setAttribute(\"aria-expanded\", \"false\");\n    }\n  });\n}\n\nfunction scheduleDropdown(field, value, options) {\n  const root = document.createElement(\"div\");\n  root.className = \"schedule-select\";\n  root.dataset.field = field;\n  root.dataset.value = String(value);\n\n  const trigger = document.createElement(\"button\");\n  trigger.type = \"button\";\n  trigger.className = \"schedule-select-trigger\";\n  trigger.setAttribute(\"aria-haspopup\", \"listbox\");\n  trigger.setAttribute(\"aria-expanded\", \"false\");\n  const label = document.createElement(\"span\");\n  const arrow = document.createElement(\"i\");\n  trigger.append(label, arrow);\n\n  const menu = document.createElement(\"div\");\n  menu.className = \"schedule-select-menu\";\n  menu.setAttribute(\"role\", \"listbox\");\n  menu.hidden = true;\n\n  function choose(option) {\n    root.dataset.value = String(option.value);\n    label.textContent = option.label;\n    menu.querySelectorAll(\".schedule-select-option\").forEach((button) => {\n      const selected = button.dataset.value === String(option.value);\n      button.classList.toggle(\"selected\", selected);\n      button.setAttribute(\"aria-selected\", String(selected));\n    });\n    menu.hidden = true;\n    trigger.setAttribute(\"aria-expanded\", \"false\");\n  }\n\n  for (const option of options) {\n    const button = document.createElement(\"button\");\n    button.type = \"button\";\n    button.className = \"schedule-select-option\";\n    button.dataset.value = String(option.value);\n    button.textContent = option.label;\n    button.setAttribute(\"role\", \"option\");\n    button.addEventListener(\"click\", (event) => {\n      event.stopPropagation();\n      choose(option);\n    });\n    menu.append(button);\n  }\n\n  trigger.addEventListener(\"click\", (event) => {\n    event.stopPropagation();\n    const opening = menu.hidden;\n    closeScheduleSelects(opening ? menu : null);\n    menu.hidden = !opening;\n    trigger.setAttribute(\"aria-expanded\", String(opening));\n  });\n  menu.addEventListener(\"click\", (event) => event.stopPropagation());\n  root.append(trigger, menu);\n  choose(options.find((option) => String(option.value) === String(value)) || options[0]);\n  return root;\n}\n\nfunction renderSchedule() {\n  const target = $(\"#scheduleEditor\");\n  target.replaceChildren();\n  const hourOptions = Array.from({ length: 24 }, (_, hour) => ({\n    value: hour,\n    label: String(hour).padStart(2, \"0\") + \":00\",\n  }));\n  const intervalItems = intervalOptions.map((hours) => ({ value: hours, label: hours + \" 小时\" }));\n\n  for (const task of [\"checkin\", \"quiz\", \"draw\", \"ad\"]) {\n    const value = settings.schedule[task];\n    const row = document.createElement(\"div\");\n    row.className = \"schedule-edit-row\";\n    row.dataset.task = task;\n\n    const name = document.createElement(\"label\");\n    name.className = \"schedule-name\";\n    const enabled = document.createElement(\"input\");\n    enabled.type = \"checkbox\";\n    enabled.dataset.field = \"enabled\";\n    enabled.checked = value.enabled;\n    name.append(enabled, document.createTextNode(taskNames[task]));\n\n    const hourControl = document.createElement(\"div\");\n    hourControl.className = \"schedule-control\";\n    hourControl.append(document.createTextNode(task === \"draw\" || task === \"ad\" ? \"开始\" : \"每天\"));\n    hourControl.append(scheduleDropdown(\"hour\", value.hour, hourOptions));\n\n    const intervalControl = document.createElement(\"div\");\n    intervalControl.className = \"schedule-control\";\n    if (task === \"draw\" || task === \"ad\") {\n      intervalControl.append(document.createTextNode(\"间隔\"));\n      intervalControl.append(scheduleDropdown(\"interval_hours\", value.interval_hours, intervalItems));\n    } else {\n      intervalControl.append(document.createTextNode(\n        task === \"quiz\" ? \"完成/满充后当天停止\" : \"每天一次\",\n      ));\n    }\n    row.append(name, hourControl, intervalControl);\n    target.append(row);\n  }\n}\n\nfunction setAccountAuthMode(row, mode) {\n  const value = mode === \"token\" ? \"token\" : \"session\";\n  row.dataset.authMode = value;\n  row.querySelectorAll(\"[data-mode]\").forEach((button) => {\n    const selected = button.dataset.mode === value;\n    button.classList.toggle(\"selected\", selected);\n    button.setAttribute(\"aria-pressed\", String(selected));\n  });\n  row.querySelector('[data-field=\"session\"]').closest(\".field\").classList.toggle(\"inactive\", value !== \"session\");\n  row.querySelector('[data-field=\"system_token\"]').closest(\".field\").classList.toggle(\"inactive\", value !== \"token\");\n}\n\nfunction applySiteFields(row, url) {\n  let hostname = \"\";\n  try { hostname = new URL(url || \"\").hostname.toLowerCase().replace(/\\.$/u, \"\"); } catch {}\n  const yesnai = hostname === \"nai.rinko.ai\";\n  row.classList.toggle(\"site-yesnai\", yesnai);\n  const sessionInput = row.querySelector('[data-field=\"session\"]');\n  const tokenInput = row.querySelector('[data-field=\"system_token\"]');\n  sessionInput.type = \"text\";\n  tokenInput.type = \"text\";\n  const userField = row.querySelector('[data-field=\"user_id\"]').closest(\".field\");\n  const modeField = row.querySelector('[data-field=\"auth_mode\"]').closest(\".field\");\n  const sessionField = row.querySelector('[data-field=\"session\"]').closest(\".field\");\n  const tokenField = row.querySelector('[data-field=\"system_token\"]').closest(\".field\");\n  userField.hidden = yesnai;\n  modeField.hidden = yesnai;\n  sessionField.querySelector(\"span\").textContent = yesnai ? \"账号\" : \"Session\";\n  tokenField.querySelector(\"span\").textContent = yesnai ? \"密码\" : \"令牌\";\n  row.querySelector('[data-field=\"session\"]').placeholder = yesnai\n    ? (row.dataset.hasUsername === \"true\" ? \"已保存在 D1；留空不修改\" : \"YesNAI 用户名\")\n    : (row.dataset.hasSession === \"true\" ? \"已保存在 D1；留空不修改\" : \"使用 Session 时填写\");\n  row.querySelector('[data-field=\"system_token\"]').placeholder = yesnai\n    ? (row.dataset.hasPassword === \"true\" ? \"已保存在 D1；留空不修改\" : \"YesNAI 密码\")\n    : (row.dataset.hasSystemToken === \"true\" ? \"已保存在 D1；留空不修改\" : \"使用令牌时填写\");\n  if (yesnai) {\n    sessionField.classList.remove(\"inactive\");\n    tokenField.classList.remove(\"inactive\");\n  } else {\n    setAccountAuthMode(row, row.dataset.authMode || \"session\");\n  }\n}\n\nfunction accountRow(account, index) {\n  const fragment = $(\"#accountTemplate\").content.cloneNode(true);\n  const row = fragment.querySelector(\".account-edit-row\");\n  row.dataset.id = account.id || \"\";\n  row.dataset.authMode = account.auth_mode || \"session\";\n  row.dataset.hasSession = String(Boolean(account.has_session));\n  row.dataset.hasSystemToken = String(Boolean(account.has_system_token));\n  row.dataset.hasUsername = String(Boolean(account.has_username || account.has_session));\n  row.dataset.hasPassword = String(Boolean(account.has_password || account.has_system_token));\n  row.querySelector(\".account-edit-index\").textContent = String(index + 1).padStart(2, \"0\");\n  row.querySelector('[data-field=\"name\"]').value = account.name || \"\";\n  const urlInput = row.querySelector('[data-field=\"url\"]');\n  urlInput.value = account.url || \"https://vsllm.cc\";\n  row.querySelector('[data-field=\"user_id\"]').value = account.user_id || \"\";\n  row.querySelector('[data-field=\"session\"]').value = account.session || account.username || \"\";\n  row.querySelector('[data-field=\"system_token\"]').value = account.system_token || account.password || \"\";\n  row.querySelectorAll(\"[data-mode]\").forEach((button) => {\n    button.addEventListener(\"click\", () => setAccountAuthMode(row, button.dataset.mode));\n  });\n  urlInput.addEventListener(\"input\", () => applySiteFields(row, urlInput.value.trim()));\n  setAccountAuthMode(row, account.auth_mode || \"session\");\n  applySiteFields(row, urlInput.value.trim());\n  row.querySelector('[data-field=\"enabled\"]').checked = account.enabled !== false;\n  row.querySelector(\".remove-account\").addEventListener(\"click\", () => {\n    row.remove();\n    renumberAccounts();\n  });\n  return fragment;\n}\n\nfunction renumberAccounts() {\n  document.querySelectorAll(\".account-edit-row\").forEach((row, index) => {\n    row.querySelector(\".account-edit-index\").textContent = String(index + 1).padStart(2, \"0\");\n  });\n}\n\nfunction renderAccounts() {\n  const target = $(\"#accountEditor\");\n  target.replaceChildren();\n  accounts.forEach((account, index) => target.append(accountRow(account, index)));\n  if (!accounts.length) addAccount();\n}\n\nfunction addAccount() {\n  const target = $(\"#accountEditor\");\n  const next = {\n    id: 0,\n    name: `账号 ${target.children.length + 1}`,\n    url: \"https://vsllm.cc\",\n    user_id: \"\",\n    enabled: true,\n    auth_mode: \"session\",\n    has_session: false,\n    has_system_token: false,\n    has_username: false,\n    has_password: false,\n  };\n  target.append(accountRow(next, target.children.length));\n}\n\nfunction readSettingsForm() {\n  const schedule = {};\n  document.querySelectorAll(\".schedule-edit-row\").forEach((row) => {\n    const task = row.dataset.task;\n    schedule[task] = {\n      enabled: row.querySelector('[data-field=\"enabled\"]').checked,\n      hour: Number(row.querySelector('[data-field=\"hour\"]').dataset.value),\n      ...([\"draw\", \"ad\"].includes(task)\n        ? { interval_hours: Number(row.querySelector('[data-field=\"interval_hours\"]').dataset.value) }\n        : {}),\n    };\n  });\n  return {\n    site_name: $(\"#siteName\").value.trim(),\n    reward_draw: $(\"#rewardDraw\").checked,\n    share_bonus: $(\"#shareBonus\").checked,\n    schedule,\n  };\n}\n\nfunction readAccountsForm() {\n  return [...document.querySelectorAll(\".account-edit-row\")].map((row) => ({\n    id: Number(row.dataset.id || 0),\n    name: row.querySelector('[data-field=\"name\"]').value.trim(),\n    url: row.querySelector('[data-field=\"url\"]').value.trim(),\n    user_id: row.querySelector('[data-field=\"user_id\"]').value.trim(),\n    auth_mode: row.dataset.authMode === \"token\" ? \"token\" : \"session\",\n    session: row.querySelector('[data-field=\"session\"]').value.trim(),\n    system_token: row.querySelector('[data-field=\"system_token\"]').value.trim(),\n    enabled: row.querySelector('[data-field=\"enabled\"]').checked,\n  }));\n}\n\nasync function load() {\n  const [settingsData, accountsData] = await Promise.all([\n    api(\"/api/settings\"),\n    api(\"/api/accounts\"),\n  ]);\n  settings = settingsData;\n  accounts = accountsData.accounts;\n  $(\"#siteName\").value = settings.site_name;\n  $(\"#rewardDraw\").checked = settings.reward_draw;\n  $(\"#shareBonus\").checked = settings.share_bonus;\n  renderSchedule();\n  renderAccounts();\n  showApp();\n}\n\n$(\"#authForm\").addEventListener(\"submit\", async (event) => {\n  event.preventDefault();\n  const value = $(\"#accessKey\").value.trim();\n  if (!value) return;\n  localStorage.setItem(KEY_NAME, value);\n  authMessage.textContent = \"…\";\n  try {\n    await load();\n  } catch (error) {\n    authMessage.textContent = error.message;\n  }\n});\n\n$(\"#logoutButton\").addEventListener(\"click\", () => {\n  localStorage.removeItem(KEY_NAME);\n  showAuth();\n});\n\n$(\"#settingsForm\").addEventListener(\"submit\", async (event) => {\n  event.preventDefault();\n  const message = $(\"#settingsMessage\");\n  message.textContent = \"…\";\n  try {\n    settings = await api(\"/api/settings\", { method: \"PUT\", body: JSON.stringify(readSettingsForm()) });\n    message.textContent = \"已保存\";\n    notify(\"已保存\");\n  } catch (error) {\n    message.textContent = error.message;\n  }\n});\n\n$(\"#addAccountButton\").addEventListener(\"click\", addAccount);\n\n$(\"#saveAccountsButton\").addEventListener(\"click\", async () => {\n  const message = $(\"#accountsMessage\");\n  message.textContent = \"正在保存…\";\n  try {\n    const data = await api(\"/api/accounts\", {\n      method: \"PUT\",\n      body: JSON.stringify({ accounts: readAccountsForm() }),\n    });\n    accounts = data.accounts;\n    renderAccounts();\n    message.textContent = \"已保存\";\n    notify(\"已保存\");\n  } catch (error) {\n    message.textContent = error.message;\n  }\n});\n\ndocument.addEventListener(\"click\", () => closeScheduleSelects());\ndocument.addEventListener(\"keydown\", (event) => { if (event.key === \"Escape\") closeScheduleSelects(); });\n\nif (key()) {\n  load().catch((error) => showAuth(error.message));\n} else {\n  showAuth();\n}\n"});
function staticAsset(pathname) {
  const aliases = { "/": "/index.html", "/config": "/config.html" };
  const key = aliases[pathname] || pathname;
  if (key === "/favicon.ico") return new Response(null, { status: 204 });
  const body = STATIC_ASSETS[key];
  if (body === undefined) return new Response("Not found", { status: 404 });
  const type = key.endsWith(".html")
    ? "text/html; charset=utf-8"
    : key.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "text/javascript; charset=utf-8";
  return new Response(body, {
    headers: {
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
    },
  });
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const DEFAULT_SETTINGS = {
  site_name: "签到助手",
  reward_draw: true,
  share_bonus: true,
  schedule: {
    checkin: { enabled: true, hour: 0 },
    quiz: { enabled: true, hour: 1 },
    draw: { enabled: true, hour: 2, interval_hours: 2 },
    ad: { enabled: true, hour: 3, interval_hours: 2 },
  },
};

const ACTIONS = new Set(["checkin", "draw", "quiz", "ad", "all"]);
const HOURLY_INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24];
let schemaPromise;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function messageOf(error, fallback = "请求失败") {
  return String(error instanceof Error ? error.message : error || fallback).slice(0, 240);
}

function requireDatabase(env) {
  if (!env.DB || typeof env.DB.prepare !== "function") {
    throw new Error("Worker 尚未绑定名为 DB 的 D1 数据库");
  }
  return env.DB;
}

async function ensureSchema(env) {
  if (!schemaPromise) {
    const db = requireDatabase(env);
    schemaPromise = (async () => {
      await db.batch([
        db.prepare(`
          CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            user_id TEXT NOT NULL,
            session TEXT NOT NULL,
            cf_clearance TEXT NOT NULL DEFAULT '',
            auth_mode TEXT NOT NULL DEFAULT 'session',
            system_token TEXT NOT NULL DEFAULT '',
            site_kind TEXT NOT NULL DEFAULT 'generic',
            username TEXT NOT NULL DEFAULT '',
            password TEXT NOT NULL DEFAULT '',
            checkin_status TEXT NOT NULL DEFAULT 'unknown',
            checkin_message TEXT NOT NULL DEFAULT '',
            checkin_at TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `),
        db.prepare(`
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `),
        db.prepare(`
          CREATE TABLE IF NOT EXISTS schedule_runs (
            slot TEXT PRIMARY KEY,
            task TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            message TEXT NOT NULL DEFAULT ''
          )
        `),
        db.prepare("CREATE INDEX IF NOT EXISTS schedule_runs_started_at ON schedule_runs(started_at DESC)"),
      ]);
      const tableInfo = await db.prepare("PRAGMA table_info(accounts)").all();
      const columns = new Set((tableInfo.results || []).map((column) => column.name));
      const migrations = [];
      if (!columns.has("auth_mode")) {
        migrations.push(db.prepare("ALTER TABLE accounts ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'session'"));
      }
      if (!columns.has("system_token")) {
        migrations.push(db.prepare("ALTER TABLE accounts ADD COLUMN system_token TEXT NOT NULL DEFAULT ''"));
      }
      if (!columns.has("site_kind")) {
        migrations.push(db.prepare("ALTER TABLE accounts ADD COLUMN site_kind TEXT NOT NULL DEFAULT 'generic'"));
      }
      if (!columns.has("username")) {
        migrations.push(db.prepare("ALTER TABLE accounts ADD COLUMN username TEXT NOT NULL DEFAULT ''"));
      }
      if (!columns.has("password")) {
        migrations.push(db.prepare("ALTER TABLE accounts ADD COLUMN password TEXT NOT NULL DEFAULT ''"));
      }
      if (!columns.has("checkin_status")) {
        migrations.push(db.prepare("ALTER TABLE accounts ADD COLUMN checkin_status TEXT NOT NULL DEFAULT 'unknown'"));
      }
      if (!columns.has("checkin_message")) {
        migrations.push(db.prepare("ALTER TABLE accounts ADD COLUMN checkin_message TEXT NOT NULL DEFAULT ''"));
      }
      if (!columns.has("checkin_at")) {
        migrations.push(db.prepare("ALTER TABLE accounts ADD COLUMN checkin_at TEXT NOT NULL DEFAULT ''"));
      }
      if (migrations.length) await db.batch(migrations);
    })().catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }
  await schemaPromise;
}

function accessKey(request) {
  // 优先级: URL ?key= > x-access-key > Bearer —— 因为部分平台代理会用访客自己的
  // 平台令牌覆写 Authorization 头(实测 ModelScope 创空间 449 字符 JWT),URL 参数覆盖不了
  try {
    const qk = new URL(request.url).searchParams.get("key")?.trim() || "";
    if (qk) return qk;
  } catch {}
  const xak = request.headers.get("x-access-key")?.trim() || "";
  if (xak) return xak;
  const authorization = request.headers.get("authorization") || "";
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return "";
}

function authorized(request, env) {
  const expected = String(env.ACCESS_KEY || "").trim();
  return expected && accessKey(request) === expected;
}

function checkinCompletedToday(row) {
  const status = String(row?.checkin_status || "");
  if (!["success", "completed", "claimed"].includes(status)) return false;
  const timestamp = Date.parse(String(row?.checkin_at || ""));
  if (!Number.isFinite(timestamp)) return false;
  try {
    return beijingClock(new Date(timestamp)).date === beijingClock().date;
  } catch {
    return false;
  }
}

function publicAccount(row) {
  const siteKind = accountSiteKind(row);
  const storedCheckinStatus = row.checkin_status || "unknown";
  const checkinDone = siteKind !== "vsllm" && checkinCompletedToday(row);
  const checkinStatus = checkinDone ? storedCheckinStatus : (siteKind !== "vsllm" && ["success", "completed", "claimed"].includes(storedCheckinStatus) ? "unknown" : storedCheckinStatus);
  return {
    id: Number(row.id),
    name: row.name,
    url: row.url,
    host: new URL(row.url).host,
    user_id: row.user_id,
    site_kind: siteKind,
    is_vsllm: siteKind === "vsllm",
    is_yesnai: siteKind === "yesnai",
    enabled: Number(row.enabled) === 1,
    auth_mode: row.auth_mode === "token" ? "token" : "session",
    has_session: Boolean(row.session),
    has_system_token: Boolean(row.system_token),
    has_username: Boolean(row.username),
    has_password: Boolean(row.password),
    session: row.session || "",
    system_token: row.system_token || "",
    username: row.username || "",
    password: row.password || "",
    checkin_status: checkinStatus,
    checkin_message: checkinDone ? "已签到" : (checkinStatus === "unknown" && storedCheckinStatus !== "unknown" ? "" : row.checkin_message || ""),
    checkin_at: row.checkin_at || "",
    updated_at: row.updated_at,
  };
}

function accountSiteKind(row) {
  try {
    return siteKindForUrl(normalizedBaseUrl(row.url));
  } catch {
    return row.site_kind === "yesnai" ? "yesnai" : row.site_kind === "vsllm" ? "vsllm" : "generic";
  }
}

function runtimeAccount(row) {
  const siteKind = accountSiteKind(row);
  return {
    name: row.name,
    url: row.url,
    user_id: row.user_id,
    site_kind: siteKind,
    username: row.username || (siteKind === "yesnai" ? row.session || "" : ""),
    password: row.password || (siteKind === "yesnai" ? row.system_token || "" : ""),
    auth_mode: row.auth_mode === "token" ? "token" : "session",
    session: row.session,
    cf_clearance: row.cf_clearance || "",
    system_token: row.system_token || "",
    isVsllm: siteKind === "vsllm",
    isYesNai: siteKind === "yesnai",
  };
}

async function listAccountRows(env, enabledOnly = false) {
  const db = requireDatabase(env);
  const where = enabledOnly ? " WHERE enabled = 1" : "";
  const result = await db.prepare(`SELECT * FROM accounts${where} ORDER BY id ASC`).all();
  return result.results || [];
}

async function getSettings(env) {
  const row = await requireDatabase(env)
    .prepare("SELECT value FROM settings WHERE key = 'app'")
    .first();
  if (!row?.value) return { ...DEFAULT_SETTINGS };
  try {
    const value = JSON.parse(row.value);
    return normalizeSettings(value);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function normalizeSettings(input) {
  const source = input?.schedule && typeof input.schedule === "object" ? input.schedule : {};
  const schedule = {};
  for (const task of ["checkin", "quiz", "draw", "ad"]) {
    const fallback = DEFAULT_SETTINGS.schedule[task];
    const item = source[task] && typeof source[task] === "object" ? source[task] : {};
    const legacyHour = /^([01]\d|2[0-3]):[0-5]\d$/u.test(String(item.at || ""))
      ? Number(String(item.at).slice(0, 2))
      : fallback.hour;
    const hour = Math.max(0, Math.min(23, Number.isFinite(Number(item.hour)) ? Number(item.hour) : legacyHour));
    const intervalCandidate = Number(item.interval_hours) || Math.round(Number(item.interval_minutes || 0) / 60) || fallback.interval_hours;
    const intervalHours = HOURLY_INTERVALS.reduce((best, value) =>
      Math.abs(value - intervalCandidate) < Math.abs(best - intervalCandidate) ? value : best,
    HOURLY_INTERVALS[0]);
    schedule[task] = {
      enabled: item.enabled !== false,
      hour: Math.trunc(hour),
      ...(["draw", "ad"].includes(task)
        ? {
            interval_hours: intervalHours,
          }
        : {}),
    };
  }
  return {
    site_name: String(input?.site_name || DEFAULT_SETTINGS.site_name).trim().slice(0, 40) || DEFAULT_SETTINGS.site_name,
    reward_draw: input?.reward_draw !== false,
    share_bonus: input?.share_bonus !== false,
    schedule,
  };
}

async function saveSettings(env, input) {
  const settings = normalizeSettings(input);
  const now = new Date().toISOString();
  await requireDatabase(env)
    .prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('app', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `)
    .bind(JSON.stringify(settings), now)
    .run();
  return settings;
}

function cleanUrl(value) {
  const url = new URL(String(value || "https://vsllm.cc").trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("站点地址必须是干净的 HTTPS 地址");
  }
  return url.href.replace(/\/+$/u, "");
}

function cleanAccount(input, index, existing) {
  const id = Number(input?.id || 0);
  const name = String(input?.name || `账号 ${index + 1}`).trim().slice(0, 64) || `账号 ${index + 1}`;
  const url = cleanUrl(input?.url);
  const userId = String(input?.user_id || "").trim().slice(0, 128);
  const siteKind = siteKindForUrl(url);
  const authMode = input?.auth_mode === "token" ? "token" : "session";
  const sessionInput = String(input?.session || "").trim();
  const tokenInput = String(input?.system_token || "").trim();
  const current = id ? existing.get(id) : null;
  const currentSiteKind = current ? accountSiteKind(current) : null;
  const sameCredentialFamily = current && currentSiteKind !== "yesnai" && siteKind !== "yesnai";
  const sameYesNaiAccount = current && currentSiteKind === "yesnai" && siteKind === "yesnai";
  const session = sessionInput || (sameCredentialFamily ? current.session : "") || "";
  const systemToken = tokenInput || (sameCredentialFamily ? current.system_token : "") || "";
  const clearance = sameCredentialFamily ? current.cf_clearance || "" : "";
  const username = String(
    input?.username ||
    (siteKind === "yesnai" ? input?.session : "") ||
    (sameYesNaiAccount ? current.username || current.session : "") ||
    "",
  ).trim();
  const password = String(
    input?.password ||
    (siteKind === "yesnai" ? input?.system_token : "") ||
    (sameYesNaiAccount ? current.password || current.system_token : "") ||
    "",
  ).trim();
  if (siteKind === "yesnai") {
    if (!username) throw new Error(`${name} 缺少 YesNAI 账号`);
    if (!password) throw new Error(`${name} 缺少 YesNAI 密码`);
    if (username.length > 256 || /[\r\n\u0000]/u.test(username)) throw new Error(`${name} 的 YesNAI 账号无效`);
    if (password.length > 4096 || /[\r\n\u0000]/u.test(password)) throw new Error(`${name} 的 YesNAI 密码无效`);
  } else {
    if (!userId) throw new Error(`${name} 缺少 user_id`);
    if (authMode === "session" && !session) throw new Error(`${name} 缺少 Session`);
    if (authMode === "token" && !systemToken) throw new Error(`${name} 缺少令牌`);
    if (/[\r\n\u0000]/u.test(session) || session.length > 16 * 1024) throw new Error(`${name} 的 Session 无效`);
    if (/[\r\n\u0000]/u.test(systemToken) || systemToken.length > 4096) throw new Error(`${name} 的令牌无效`);
  }
  return {
    id: current ? id : 0,
    name,
    url,
    user_id: siteKind === "yesnai" ? "" : userId,
    site_kind: siteKind,
    username: siteKind === "yesnai" ? username : "",
    password: siteKind === "yesnai" ? password : "",
    auth_mode: authMode,
    session: siteKind === "yesnai" ? "" : session,
    cf_clearance: clearance,
    system_token: siteKind === "yesnai" ? "" : systemToken,
    enabled: input?.enabled === false ? 0 : 1,
  };
}

async function replaceAccounts(env, input) {
  if (!Array.isArray(input) || input.length > 20) throw new Error("账号必须是数组，最多 20 个");
  const db = requireDatabase(env);
  const rows = await listAccountRows(env);
  const existing = new Map(rows.map((row) => [Number(row.id), row]));
  const accounts = input.map((item, index) => cleanAccount(item, index, existing));
  const now = new Date().toISOString();
  const statements = [];
  const keptIds = new Set(accounts.filter((account) => account.id).map((account) => account.id));

  for (const id of existing.keys()) {
    if (!keptIds.has(id)) statements.push(db.prepare("DELETE FROM accounts WHERE id = ?").bind(id));
  }

  for (const account of accounts) {
    if (account.id) {
      statements.push(db.prepare(`
        UPDATE accounts
        SET name = ?, url = ?, user_id = ?, session = ?, cf_clearance = ?, auth_mode = ?, system_token = ?, site_kind = ?, username = ?, password = ?, enabled = ?, updated_at = ?
        WHERE id = ?
      `).bind(
        account.name,
        account.url,
        account.user_id,
        account.session,
        account.cf_clearance,
        account.auth_mode,
        account.system_token,
        account.site_kind,
        account.username,
        account.password,
        account.enabled,
        now,
        account.id,
      ));
    } else {
      statements.push(db.prepare(`
        INSERT INTO accounts (name, url, user_id, session, cf_clearance, auth_mode, system_token, site_kind, username, password, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        account.name,
        account.url,
        account.user_id,
        account.session,
        account.cf_clearance,
        account.auth_mode,
        account.system_token,
        account.site_kind,
        account.username,
        account.password,
        account.enabled,
        now,
        now,
      ));
    }
  }
  if (statements.length) await db.batch(statements);
  return (await listAccountRows(env)).map(publicAccount);
}

function compactResult(result) {
  if (!result || typeof result !== "object") {
    return { ok: false, status: "error", message: "任务没有返回结果" };
  }
  const output = {
    ok: result.ok === true,
    status: String(result.status || (result.ok ? "success" : "error")),
    message: String(result.message || "").slice(0, 240),
  };
  for (const key of [
    "skipped", "completed", "checkin_date", "quota_awarded", "prize_name", "prize_quota",
    "base_prize_quota", "prize_rarity", "bonus_percent", "available_after", "done_count",
    "daily_cap", "next_available_at", "duration_seconds", "reward_status", "reward_draw_ready",
  ]) {
    if (result[key] !== undefined && result[key] !== null) output[key] = result[key];
  }
  if (result.reward_draw) output.reward_draw = compactResult(result.reward_draw);
  return output;
}

async function runSingle(account, action, settings) {
  if (!account.isVsllm && action !== "checkin") {
    return { ok: true, success: true, status: "not_applicable", skipped: true, message: "该站点只执行签到" };
  }
  if (action === "checkin") return compactResult(await checkinAccount(account));
  if (action === "draw") return compactResult(await unlockAndDraw(account, { shareBonus: settings.share_bonus }));
  if (action === "quiz") {
    const result = await runQuiz(account);
    if (settings.reward_draw && result.reward_draw_ready === true) {
      result.reward_draw = await unlockAndDraw(account, { shareBonus: settings.share_bonus });
    }
    return compactResult(result);
  }
  if (action === "ad") {
    const result = await runAd(account, { dailyLimit: 3 });
    if (settings.reward_draw && result.reward_draw_ready === true) {
      result.reward_draw = await unlockAndDraw(account, { shareBonus: settings.share_bonus });
    }
    return compactResult(result);
  }
  throw new Error("未知任务");
}

async function runForAccount(env, row, action, settings) {
  const account = runtimeAccount(row);
  const actions = action === "all"
    ? (account.isVsllm ? ["checkin", "quiz", "ad", "draw"] : ["checkin"])
    : [action];
  const steps = [];
  for (const currentAction of actions) {
    let result;
    try {
      result = await runSingle(account, currentAction, settings);
    } catch (error) {
      result = { ok: false, status: "error", message: messageOf(error) };
    }
    if (currentAction === "checkin") {
      await requireDatabase(env).prepare(`
        UPDATE accounts
        SET checkin_status = ?, checkin_message = ?, checkin_at = ?, updated_at = ?
        WHERE id = ?
      `).bind(
        String(result.status || (result.ok ? "success" : "error")).slice(0, 40),
        String(result.message || "").slice(0, 240),
        new Date().toISOString(),
        new Date().toISOString(),
        row.id,
      ).run();
    }
    steps.push({ action: currentAction, result });
  }
  return {
    account_id: Number(row.id),
    account_name: row.name,
    ok: steps.every((step) => step.result.ok),
    steps,
  };
}

async function runAction(env, payload) {
  const action = String(payload?.action || "");
  if (!ACTIONS.has(action)) throw new Error("action 只支持 checkin、draw、quiz、ad 或 all");
  const requested = payload?.account_id === "all" || payload?.account_id === undefined
    ? null
    : Number(payload.account_id);
  let rows = (await listAccountRows(env, true)).filter((row) => requested === null || Number(row.id) === requested);
  if (!rows.length) throw new Error("没有找到可执行的账号");
  if (["draw", "quiz", "ad"].includes(action)) {
    rows = rows.filter(isVsllmRow);
    if (!rows.length) throw new Error("所选账号只支持签到");
  }
  return runRows(env, rows, action);
}

async function runRows(env, rows, action) {
  const settings = await getSettings(env);
  const runId = crypto.randomUUID();
  const results = [];
  for (const row of rows) results.push(await runForAccount(env, row, action, settings));
  return { run_id: runId, action, results };
}

function isVsllmRow(row) {
  try {
    const hostname = new URL(row.url).hostname.toLowerCase().replace(/\.$/u, "");
    return hostname === "vsllm.com" || hostname === "vsllm.cc";
  } catch {
    return false;
  }
}

function taskState(value) {
  if (!value) return null;
  return {
    status: value.status || "unknown",
    completed: value.completed === true,
    suspended: value.suspended === true,
    done_count: value.done_count ?? null,
    daily_cap: value.daily_cap ?? null,
    next_available_at: value.next_available_at ?? null,
  };
}

// 带超时的竞速: 超时返回 fallback,原 promise 继续在后台跑(浏览器过盾完成后下次刷新可见)
function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function liveAccount(row) {
  const account = runtimeAccount(row);
  if (!account.isVsllm) {
    const balance = await getBalance(account);
    return {
      ...publicAccount(row),
      balance: compactResult(balance),
      balance_gems: account.isYesNai && balance.ok ? Number(balance.balance_gems || 0) : null,
      balance_quota: !account.isYesNai && balance.ok ? Number(balance.balance_quota || 0) : null,
      balance_yuan: null,
      available_draws: null,
      charges_current: null,
      charges_max: null,
      quiz: null,
      ad: null,
      status_error: balance.ok ? null : balance.message,
    };
  }
  const [balance, gwent] = await Promise.all([
    withTimeout(getBalance(account), 4_000, { ok: false, message: "余额刷新超时" }),
    withTimeout(getGwentStatus(account), 4_000, { ok: false, message: "浏览器通道启动中,稍后自动恢复" }),
  ]);
  return {
    ...publicAccount(row),
    balance: compactResult(balance),
    balance_quota: balance.ok ? Number(balance.balance_quota || 0) : null,
    balance_yuan: balance.ok ? balance.balance_yuan : null,
    available_draws: gwent.ok ? gwent.available : null,
    charges_current: gwent.ok ? gwent.charges_current : null,
    charges_max: gwent.ok ? gwent.charges_max : null,
    quiz: gwent.ok ? taskState(gwent.quiz) : null,
    ad: gwent.ok ? taskState(gwent.ad) : null,
    status_error: gwent.ok ? null : gwent.message,
  };
}

async function dashboard(env) {
  const [rows, settings] = await Promise.all([
    listAccountRows(env),
    getSettings(env),
  ]);
  const accounts = await Promise.all(rows.map((row) => withTimeout(
    liveAccount(row),
    5_500,
    { ...publicAccount(row), balance: null, balance_quota: null, balance_yuan: null, available_draws: null, charges_current: null, charges_max: null, quiz: null, ad: null, status_error: "刷新超时,稍后重试" },
  )));
  return {
    settings,
    accounts,
    updated_at: new Date().toISOString(),
  };
}

function beijingClock(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  };
}

function dueSlot(settings, task, date = new Date()) {
  const config = settings.schedule[task];
  if (!config?.enabled) return null;
  const clock = beijingClock(date);
  const anchor = Number(config.hour);
  if (clock.hour < anchor) return null;
  if (task === "checkin") return `${clock.date}:${task}`;
  if (task === "quiz") return `${clock.date}:${task}:${clock.hour}`;
  const interval = Math.max(1, Number(config.interval_hours) || 2);
  const index = Math.floor((clock.hour - anchor) / interval);
  return `${clock.date}:${task}:${index}`;
}

async function claimScheduleSlot(env, slot, task) {
  const result = await requireDatabase(env).prepare(`
    INSERT OR IGNORE INTO schedule_runs (slot, task, status, started_at)
    VALUES (?, ?, 'running', ?)
  `).bind(slot, task, new Date().toISOString()).run();
  return Number(result.meta?.changes ?? result.changes ?? 0) > 0;
}

async function finishScheduleSlot(env, slot, status, message = "") {
  await requireDatabase(env).prepare(`
    UPDATE schedule_runs SET status = ?, finished_at = ?, message = ? WHERE slot = ?
  `).bind(status, new Date().toISOString(), String(message).slice(0, 240), slot).run();
}

async function scheduleSlotExists(env, slot) {
  const row = await requireDatabase(env)
    .prepare("SELECT 1 AS found FROM schedule_runs WHERE slot = ?")
    .bind(slot)
    .first();
  return Boolean(row?.found);
}

async function quizAttemptedToday(env, date) {
  const row = await requireDatabase(env)
    .prepare("SELECT 1 AS found FROM schedule_runs WHERE slot LIKE ? AND slot <> ? LIMIT 1")
    .bind(`${date}:quiz:%`, `${date}:quiz:complete`)
    .first();
  return Boolean(row?.found);
}

async function quizCompletedUpstream(env, allowFullCharge) {
  const rows = (await listAccountRows(env, true)).filter(isVsllmRow);
  if (!rows.length) return false;
  const statuses = await Promise.all(rows.map((row) => getGwentStatus(runtimeAccount(row))));
  return statuses.every((status) => {
    const value = String(status?.quiz?.status || "").toLowerCase();
    const taskCompleted = ["completed", "done", "success", "claimed"].includes(value);
    const chargeFull = allowFullCharge &&
      Number.isInteger(status?.charges_current) &&
      Number.isInteger(status?.charges_max) &&
      status.charges_current >= status.charges_max;
    return status?.ok === true && (taskCompleted || chargeFull);
  });
}

async function runCron(env) {
  const settings = await getSettings(env);
  const tasks = ["checkin", "quiz", "draw", "ad"];
  const results = [];
  const rows = await listAccountRows(env, true);
  const vsllmRows = rows.filter(isVsllmRow);
  const otherRows = rows.filter((row) => !isVsllmRow(row));
  await requireDatabase(env)
    .prepare("DELETE FROM schedule_runs WHERE datetime(started_at) < datetime('now', '-14 days')")
    .run();
  for (const task of tasks) {
    if (!vsllmRows.length) {
      results.push({ task, status: "no_account" });
      continue;
    }
    const slot = dueSlot(settings, task);
    if (!slot) {
      results.push({ task, status: "not_due" });
      continue;
    }
    if (task === "quiz") {
      const date = beijingClock().date;
      const doneSlot = `${date}:quiz:complete`;
      if (await scheduleSlotExists(env, doneSlot)) {
        results.push({ task, status: "completed_today" });
        continue;
      }
      const attemptedToday = await quizAttemptedToday(env, date);
      if (await quizCompletedUpstream(env, attemptedToday)) {
        if (await claimScheduleSlot(env, doneSlot, task)) {
          await finishScheduleSlot(env, doneSlot, "success", "上游确认今日答题已完成");
        }
        results.push({ task, status: "completed_today" });
        continue;
      }
    }
    if (!(await claimScheduleSlot(env, slot, task))) {
      results.push({ task, slot, status: "already_ran" });
      continue;
    }
    try {
      const run = await runRows(env, vsllmRows, task);
      const ok = run.results.every((item) => item.ok);
      await finishScheduleSlot(env, slot, ok ? "success" : "partial", `${run.results.length} 个账号`);
      results.push({ task, slot, status: ok ? "success" : "partial", run_id: run.run_id });
    } catch (error) {
      await finishScheduleSlot(env, slot, "error", messageOf(error));
      results.push({ task, slot, status: "error", message: messageOf(error) });
    }
  }
  const clock = beijingClock();
  const otherSlot = `${clock.date}:checkin:non-vsllm`;
  if (!otherRows.length) {
    results.push({ task: "checkin_non_vsllm", status: "no_account" });
  } else if (clock.hour < 12) {
    results.push({ task: "checkin_non_vsllm", status: "not_due" });
  } else if (!(await claimScheduleSlot(env, otherSlot, "checkin"))) {
    results.push({ task: "checkin_non_vsllm", slot: otherSlot, status: "already_ran" });
  } else {
    try {
      const run = await runRows(env, otherRows, "checkin");
      const ok = run.results.every((item) => item.ok);
      await finishScheduleSlot(env, otherSlot, ok ? "success" : "partial", `${run.results.length} 个账号`);
      results.push({ task: "checkin_non_vsllm", slot: otherSlot, status: ok ? "success" : "partial", run_id: run.run_id });
    } catch (error) {
      await finishScheduleSlot(env, otherSlot, "error", messageOf(error));
      results.push({ task: "checkin_non_vsllm", slot: otherSlot, status: "error", message: messageOf(error) });
    }
  }
  return { ok: true, checked_at: new Date().toISOString(), results };
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("请求体必须是 JSON");
  }
}

async function handleApi(request, env, path) {
  if (path === "/api/health" && request.method === "GET") {
    return json({
      ok: true,
      database: Boolean(env.DB),
      access_key: Boolean(env.ACCESS_KEY),
    });
  }
  if (!authorized(request, env)) {
    const presented = accessKey(request);
    console.log(JSON.stringify({ event: "auth_fail", path, bearer: String(request.headers.get("authorization") || "").startsWith("Bearer "), auth_len: (request.headers.get("authorization") || "").length, xak: Boolean(request.headers.get("x-access-key")), key_fp: presented ? presented.slice(0, 4) : "", key_len: presented.length }));
    return json({ error: "请输入正确的访问口令" }, 401);
  }

  await ensureSchema(env);
  if (path === "/api/dashboard" && request.method === "GET") return json(await dashboard(env));
  if (path === "/api/accounts" && request.method === "GET") {
    return json({ accounts: (await listAccountRows(env)).map(publicAccount) });
  }
  if (path === "/api/accounts" && request.method === "PUT") {
    const payload = await readBody(request);
    return json({ accounts: await replaceAccounts(env, payload.accounts) });
  }
  if (path === "/api/settings" && request.method === "GET") return json(await getSettings(env));
  if (path === "/api/settings" && request.method === "PUT") return json(await saveSettings(env, await readBody(request)));
  if (path === "/api/run" && request.method === "POST") return json(await runAction(env, await readBody(request)));
  return json({ error: "接口不存在" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url.pathname);
      return staticAsset(url.pathname);
    } catch (error) {
      console.error(messageOf(error));
      return json({ error: messageOf(error) }, 500);
    }
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureSchema(env);
      const result = await runCron(env);
      console.log(JSON.stringify({ event: "scheduled_run", scheduled_at: controller.scheduledTime, result }));
    })());
  },
};
