// 浏览器执行器: vsllm 被保护端点(/api/gwent/*、/api/user/checkin)的请求
// 改由无头 Chromium 页内 fetch 执行。
// 原因: CF 盾按 TLS 指纹拦截,Node 的 fetch 即使带 cf_clearance + 同 UA 也 403;
// 页面内的请求走 Chrome 自己的网络栈,过盾上下文直接放行,令牌+ID 认证头原样透传。
// profile 持久化在 ./.profile,cookie/clearance 跨次保留,通常免挑战。
// patchright 按需动态加载,空闲时服务内存不含浏览器代码。
// 过盾失败(180s 未放行或仍返回 403 挑战页)后进入 2 小时冷却:
// 冷却期内不再启动浏览器,直接返回 403 挑战响应,避免高频重试加深 IP 风控。
import path from "node:path";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.join(HERE, ".profile");
const STATE_FILE = path.join(HERE, "challenge-state.json");
const CHALLENGE_RE = /just a moment|attention required|checking your browser|安全验证|请稍候/i;
const IDLE_MS = 120_000;
const COOLDOWN_MS = 2 * 60 * 60 * 1000;

let session = null;
let opening = null;
let closing = null;
let idleTimer = null;
let challengeState = { lastFailAt: 0, lastPassAt: 0 };

try {
  challengeState = { ...challengeState, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
} catch {}

function saveChallengeState() {
  try {
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(challengeState));
    renameSync(tmp, STATE_FILE);
  } catch {}
}

function markChallengePass() {
  if (challengeState.lastFailAt) {
    challengeState = { lastFailAt: 0, lastPassAt: challengeState.lastPassAt };
    saveChallengeState();
  }
}

function markChallengeFail() {
  if (Date.now() - challengeState.lastFailAt < 60_000) return;
  challengeState.lastFailAt = Date.now();
  saveChallengeState();
}

function cooldownResponse() {
  return new Response(
    "<html><head><title>Just a moment...</title></head><body>challenge cooldown</body></html>",
    { status: 403, headers: { "content-type": "text/html; charset=UTF-8" } },
  );
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(closeSession, IDLE_MS);
  idleTimer.unref?.();
}

async function closeSession() {
  const current = session;
  session = null;
  if (!current) return;
  closing = (async () => {
    try { await current.context.close(); } catch {}
    closing = null;
  })();
  await closing;
}

async function waitRelease(page) {
  const t0 = Date.now();
  let stable = 0;
  while (Date.now() - t0 < 180_000) {
    const title = await page.title().catch(() => "");
    if (CHALLENGE_RE.test(title)) stable = 0;
    else { stable += 1; if (stable >= 2) return true; }
    await page.waitForTimeout(3000);
  }
  return !CHALLENGE_RE.test(await page.title().catch(() => ""));
}

async function openSession() {
  if (session) return session;
  if (closing) await closing;
  if (opening) return opening;
  opening = (async () => {
    const { chromium } = await import("patchright");
    const context = await chromium.launchPersistentContext(PROFILE, {
      headless: true,
      channel: "chromium", // 全量 Chrome 二进制的新无头模式;headless shell 是阉割版,风控更容易识破
      viewport: { width: 1280, height: 800 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = context.pages()[0] || (await context.newPage());
      await page.goto("https://vsllm.cc/api/user/checkin", { waitUntil: "domcontentloaded", timeout: 60_000 });
      const title = await page.title().catch(() => "");
      if (CHALLENGE_RE.test(title) && !(await waitRelease(page))) {
        markChallengeFail();
        throw new Error("浏览器过盾超时(180s),等下次任务重试");
      }
      markChallengePass();
      session = { context, page };
      return session;
    } catch (error) {
      try { await context.close(); } catch {}
      throw error;
    }
  })();
  try {
    return await opening;
  } finally {
    opening = null;
  }
}

export async function browserFetch(url, init = {}) {
  if (challengeState.lastFailAt && Date.now() - challengeState.lastFailAt < COOLDOWN_MS) {
    return cooldownResponse();
  }
  const { page } = await openSession();
  scheduleIdleClose();
  const method = init.method || "GET";
  const headers = {};
  if (init.headers) {
    const source = init.headers instanceof Headers ? [...init.headers] : Object.entries(init.headers || {});
    for (const [key, value] of source) headers[key] = value;
  }
  const body = typeof init.body === "string" ? init.body : null;
  const result = await page.evaluate(async ({ url, method, headers, body }) => {
    try {
      const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30_000) });
      const text = await response.text();
      const outHeaders = {};
      response.headers.forEach((value, key) => { outHeaders[key] = value; });
      return { status: response.status, headers: outHeaders, body: text };
    } catch (error) {
      return { error: String(error) };
    }
  }, { url, method, headers, body });

  if (result.error) throw new Error(`browser_fetch: ${result.error}`);
  const status = Number(result.status) || 0;
  if (status === 403 && JSON.stringify(result.headers).toLowerCase().includes("text/html")) {
    markChallengeFail();
  }
  const noBody = status === 204 || status === 205 || status === 304;
  return new Response(noBody ? null : result.body, { status, headers: result.headers });
}
