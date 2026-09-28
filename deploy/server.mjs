#!/usr/bin/env node
// work.js 的 Node 单机壳：HTTP 入口 + D1(JSON 配置文件)适配 + node-cron 定时
// 仅按需绑定 0.0.0.0（.env BIND），数据落 config.json，无数据库依赖
// 可选 WebDAV 持久化（容器/临时盘环境用）：配 WEBDAV_URL/WEBDAV_USER/WEBDAV_PASS 即启用
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const cron = require("node-cron");

const HERE = path.dirname(fileURLToPath(import.meta.url));
process.title = "webtask";

function loadDotEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && out[m[1]] === undefined) out[m[1]] = m[2];
  }
  return out;
}

const fileEnv = loadDotEnv(path.join(HERE, ".env"));
const PORT = Number(process.env.PORT || fileEnv.PORT || 8787);
const BIND = process.env.BIND || fileEnv.BIND || "127.0.0.1";
// 口令净化: 平台注入的环境变量可能带首尾空白/成对引号,一律剥掉。
// 未配置时: 优先复用持久化的 access-key.json(随 WebDAV 同步,重启不变),
// 实在没有才新生成,并立刻写盘+上传 WebDAV。
const rawAccessKeyInput = String(process.env.ACCESS_KEY || fileEnv.ACCESS_KEY || "");
const cleanedAccessKey = rawAccessKeyInput.trim().replace(/^["']|["']$/g, "").trim();
let ACCESS_KEY = cleanedAccessKey;

const nativeFetch = globalThis.fetch;

// ---- WebDAV 持久化(可选,容器环境用) ----
// 启动时把远端 config.json / challenge-state.json 拉回本地(仅本地缺失时,本地优先),
// 运行中每 60s 比对 md5 变更上传。不配 WEBDAV_URL = 纯本地盘,零行为差异。
// 注意:必须在导入 browser-executor(读冷却状态)和 makeJsonD1(读配置)之前完成恢复。
const WEBDAV_URL = String(process.env.WEBDAV_URL || fileEnv.WEBDAV_URL || "").replace(/\/+$/, "");
const WEBDAV_AUTH = (process.env.WEBDAV_USER || fileEnv.WEBDAV_USER)
  ? "Basic " + Buffer.from(`${process.env.WEBDAV_USER || fileEnv.WEBDAV_USER}:${process.env.WEBDAV_PASS || fileEnv.WEBDAV_PASS || ""}`).toString("base64")
  : "";
const SYNC_FILES = ["config.json", "challenge-state.json", "access-key.json"];
const lastSynced = new Map();
const md5 = (buf) => createHash("md5").update(buf).digest("hex");
async function davGet(file) {
  const r = await nativeFetch(`${WEBDAV_URL}/${file}`, { headers: { authorization: WEBDAV_AUTH } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${file} -> ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function davPut(file, buf) {
  const r = await nativeFetch(`${WEBDAV_URL}/${file}`, {
    method: "PUT",
    headers: { authorization: WEBDAV_AUTH, "content-type": "application/octet-stream" },
    body: buf,
  });
  if (!r.ok) throw new Error(`PUT ${file} -> ${r.status}`);
}
async function webdavRestore() {
  for (const file of SYNC_FILES) {
    try {
      const remote = await davGet(file);
      const local = path.join(HERE, file);
      if (remote && !existsSync(local)) {
        writeFileSync(local, remote);
        console.log(`[webdav] 已恢复 ${file} (${remote.length}B)`);
      }
      if (remote) lastSynced.set(file, md5(readFileSync(local)));
    } catch (error) {
      console.error(`[webdav] 恢复 ${file} 失败:`, String(error?.message || error));
    }
  }
}
function webdavStartSync() {
  console.log("[webdav] 持久化已启用:", WEBDAV_URL);
  const timer = setInterval(() => {
    (async () => {
      for (const file of SYNC_FILES) {
        const p = path.join(HERE, file);
        if (!existsSync(p)) continue;
        const buf = readFileSync(p);
        const h = md5(buf);
        if (lastSynced.get(file) === h) continue;
        await davPut(file, buf);
        lastSynced.set(file, h);
        console.log(`[webdav] 已上传 ${file} (${buf.length}B)`);
      }
    })().catch((error) => console.error("[webdav] 同步失败:", String(error?.message || error)));
  }, 60_000);
  timer.unref?.();
}

if (WEBDAV_URL && WEBDAV_AUTH) await webdavRestore();

// ---- 访问口令兜底解析(必须在 webdavRestore 之后,才能吃到持久化的口令) ----
if (!ACCESS_KEY) {
  const keyFile = path.join(HERE, "access-key.json");
  if (existsSync(keyFile)) {
    try {
      const parsed = JSON.parse(readFileSync(keyFile, "utf8"));
      if (parsed?.access_key) ACCESS_KEY = String(parsed.access_key);
    } catch {}
  }
  if (!ACCESS_KEY) {
    ACCESS_KEY = randomBytes(12).toString("hex");
    try {
      writeFileSync(keyFile, JSON.stringify({ access_key: ACCESS_KEY, generated_at: new Date().toISOString() }));
      if (WEBDAV_URL && WEBDAV_AUTH) {
        davPut("access-key.json", readFileSync(keyFile))
          .then(() => lastSynced.set("access-key.json", md5(readFileSync(keyFile))))
          .catch(() => {});
      }
    } catch {}
  }
}

// ---- 浏览器执行器接线 ----
// 在 import work.js 之前替换 globalThis.fetch: vsllm 被保护端点(盾绑 TLS 指纹,
// Node fetch 必 403)改走无头 Chromium 页内 fetch,其余请求走原生 fetch
const { browserFetch } = await import("./browser-executor.mjs");
const PROTECTED_RE = /^https?:\/\/([^/]+\.)?vsllm\.(cc|com)\/api\/(gwent\/|user\/checkin)/i;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input?.url || String(input);
  return PROTECTED_RE.test(url) ? browserFetch(url, init) : nativeFetch(input, init);
};

const worker = (await import("./work.js")).default;

// ---- D1 → JSON 配置文件适配 ----
// work.js 的 SQL 语句是封闭集合（共 11 种 + schema DDL），不解析 SQL，
// 按归一化语句逐一映射到 config.json 上的操作；未适配语句直接抛错暴露问题
function makeJsonD1(file) {
  const load = () => {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      return {
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        settings: parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {},
        schedule_runs: Array.isArray(parsed.schedule_runs) ? parsed.schedule_runs : [],
        nextId: Number(parsed.nextId) || 0,
      };
    } catch {
      return { accounts: [], settings: {}, schedule_runs: [], nextId: 0 };
    }
  };
  const data = load();
  if (!data.nextId) data.nextId = data.accounts.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
  const save = () => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  };

  const accountColumns = [
    "id", "name", "url", "user_id", "session", "cf_clearance", "auth_mode", "system_token",
    "site_kind", "username", "password", "checkin_status", "checkin_message", "checkin_at",
    "enabled", "created_at", "updated_at",
  ];

  const handlers = [
    { re: /^create (table|index)/i, fn: () => ({ changes: 0 }) },
    { re: /^alter table accounts add column/i, fn: () => ({ changes: 0 }) },
    { re: /^pragma table_info\(accounts\)$/i, fn: () => ({ rows: accountColumns.map((name) => ({ name })) }) },
    { re: /^select \* from accounts where enabled = 1 order by id asc$/i, fn: () => ({ rows: data.accounts.filter((row) => Number(row.enabled) === 1) }) },
    { re: /^select \* from accounts order by id asc$/i, fn: () => ({ rows: data.accounts }) },
    {
      re: /^select value from settings where key = 'app'$/i,
      fn: () => (data.settings.app === undefined ? { row: null } : { row: { value: data.settings.app } }),
    },
    {
      re: /^insert into settings \(key, value, updated_at\) values \('app', \?, \?\) on conflict\(key\) do update set value = excluded\.value, updated_at = excluded\.updated_at$/i,
      fn: (a) => { data.settings.app = String(a[0]); save(); return { changes: 1 }; },
    },
    {
      re: /^delete from accounts where id = \?$/i,
      fn: (a) => {
        const before = data.accounts.length;
        data.accounts = data.accounts.filter((row) => Number(row.id) !== Number(a[0]));
        const changes = before - data.accounts.length;
        if (changes) save();
        return { changes };
      },
    },
    {
      re: /^update accounts set name = \?, url = \?, user_id = \?, session = \?, cf_clearance = \?, auth_mode = \?, system_token = \?, site_kind = \?, username = \?, password = \?, enabled = \?, updated_at = \? where id = \?$/i,
      fn: (a) => {
        const row = data.accounts.find((r) => Number(r.id) === Number(a[12]));
        if (!row) return { changes: 0 };
        ["name", "url", "user_id", "session", "cf_clearance", "auth_mode", "system_token", "site_kind", "username", "password", "enabled", "updated_at"]
          .forEach((key, i) => { row[key] = a[i]; });
        save();
        return { changes: 1 };
      },
    },
    {
      re: /^insert into accounts \(name, url, user_id, session, cf_clearance, auth_mode, system_token, site_kind, username, password, enabled, created_at, updated_at\) values \(\?(?:, \?){12}\)$/i,
      fn: (a) => {
        const row = {
          id: data.nextId,
          name: a[0], url: a[1], user_id: a[2], session: a[3], cf_clearance: a[4],
          auth_mode: a[5], system_token: a[6], site_kind: a[7], username: a[8], password: a[9],
          enabled: a[10],
          checkin_status: "unknown", checkin_message: "", checkin_at: "",
          created_at: a[11], updated_at: a[12],
        };
        data.accounts.push(row);
        data.nextId += 1;
        save();
        return { changes: 1, lastRowId: row.id };
      },
    },
    {
      re: /^update accounts set checkin_status = \?, checkin_message = \?, checkin_at = \?, updated_at = \? where id = \?$/i,
      fn: (a) => {
        const row = data.accounts.find((r) => Number(r.id) === Number(a[4]));
        if (!row) return { changes: 0 };
        row.checkin_status = a[0];
        row.checkin_message = a[1];
        row.checkin_at = a[2];
        row.updated_at = a[3];
        save();
        return { changes: 1 };
      },
    },
    {
      re: /^insert or ignore into schedule_runs \(slot, task, status, started_at\) values \(\?, \?, 'running', \?\)$/i,
      fn: (a) => {
        if (data.schedule_runs.some((row) => row.slot === a[0])) return { changes: 0 };
        data.schedule_runs.push({ slot: a[0], task: a[1], status: "running", started_at: a[2], finished_at: null, message: "" });
        save();
        return { changes: 1 };
      },
    },
    {
      re: /^update schedule_runs set status = \?, finished_at = \?, message = \? where slot = \?$/i,
      fn: (a) => {
        const row = data.schedule_runs.find((r) => r.slot === a[3]);
        if (!row) return { changes: 0 };
        row.status = a[0];
        row.finished_at = a[1];
        row.message = a[2];
        save();
        return { changes: 1 };
      },
    },
    {
      re: /^select 1 as found from schedule_runs where slot = \?$/i,
      fn: (a) => ({ row: data.schedule_runs.some((row) => row.slot === a[0]) ? { found: 1 } : null }),
    },
    {
      re: /^select 1 as found from schedule_runs where slot like \? and slot <> \? limit 1$/i,
      fn: (a) => {
        const pattern = String(a[0]);
        const prefix = pattern.endsWith("%") ? pattern.slice(0, -1) : pattern;
        const hit = data.schedule_runs.some((row) => row.slot.startsWith(prefix) && row.slot !== String(a[1]));
        return { row: hit ? { found: 1 } : null };
      },
    },
    {
      re: /^delete from schedule_runs where datetime\(started_at\) < datetime\('now', '-14 days'\)$/i,
      fn: () => {
        const cutoff = Date.now() - 14 * 86400000;
        const before = data.schedule_runs.length;
        data.schedule_runs = data.schedule_runs.filter((row) => Date.parse(row.started_at || "") >= cutoff);
        const changes = before - data.schedule_runs.length;
        if (changes) save();
        return { changes };
      },
    },
  ];

  const makeStatement = (sql) => {
    const norm = sql.replace(/\s+/g, " ").trim();
    const match = (args) => {
      const handler = handlers.find((h) => h.re.test(norm));
      if (!handler) throw new Error(`json-db 未适配的 SQL: ${norm.slice(0, 90)}`);
      return handler.fn(args || []);
    };
    const toRun = (out) => ({
      success: true,
      changes: out?.changes ?? 0,
      meta: { changes: out?.changes ?? 0, last_row_id: Number(out?.lastRowId ?? 0) },
    });
    const run = (...args) => toRun(match(args));
    const bound = (...args) => ({
      run: () => run(...args),
      first: () => match(args)?.row ?? null,
      all: () => ({ results: match(args)?.rows ?? [], success: true }),
      __exec: () => run(...args),
    });
    return {
      bind: (...args) => bound(...args),
      run,
      first: (...args) => match(args)?.row ?? null,
      all: (...args) => ({ results: match(args)?.rows ?? [], success: true }),
      __exec: () => run(),
    };
  };

  return {
    prepare: makeStatement,
    batch: (statements) => statements.map((statement) => statement.__exec()),
    close: () => {},
  };
}

const env = {
  DB: makeJsonD1(path.join(HERE, "config.json")),
  ...(ACCESS_KEY ? { ACCESS_KEY } : {}),
};

// ---- HTTP 壳 ----
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers };
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    const init = { method: req.method, headers };
    if (!["GET", "HEAD"].includes(req.method)) {
      init.body = body;
      init.duplex = "half";
    }
    const request = new Request(`http://${BIND}:${PORT}${req.url}`, init);
    const response = await worker.fetch(request, env);
    const outHeaders = {};
    response.headers.forEach((value, key) => { outHeaders[key] = value; });
    res.writeHead(response.status, outHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(new Date().toISOString(), req.method, req.url, String(error?.message || error));
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "服务器内部错误" }));
  }
});

server.listen(PORT, BIND, () => {
  console.log(`[webtask] http://${BIND}:${PORT} config=${path.join(HERE, "config.json")} access_key=${ACCESS_KEY ? "on" : "off"}`);
  const keyOrigin = !cleanedAccessKey
    ? (WEBDAV_URL && WEBDAV_AUTH ? "自动生成,已通过 WebDAV 持久化(重启不变)" : "自动生成,重启会更换")
    : (process.env.ACCESS_KEY ? "平台环境变量" : ".env 配置文件");
  console.log(`[webtask] 本次生效的访问口令: ${ACCESS_KEY}  (来源: ${keyOrigin})`);
  if (cleanedAccessKey && ACCESS_KEY !== rawAccessKeyInput) {
    console.log("[webtask] ACCESS_KEY 已自动清理首尾空白/成对引号");
  }
  if (WEBDAV_URL && WEBDAV_AUTH) webdavStartSync();
});

// ---- 定时壳: 每小时整点触发一次 Worker 的 scheduled ----
// 任务的到期槽位本身就按"整点小时"设计,整点触发恰好对齐、零迟到;
// 槽位认领幂等,不会重复执行;启动 20 秒后的补跑兜底停机错过的槽位
function triggerCron() {
  try {
    worker.scheduled(
      { scheduledTime: Date.now() },
      env,
      {
        waitUntil: (p) => Promise.resolve(p).catch((e) => console.error("[cron]", String(e?.message || e))),
        passThroughOnException: () => {},
      },
    );
  } catch (error) {
    console.error("[cron]", String(error?.message || error));
  }
}
if (cron.validate("0 * * * *")) cron.schedule("0 * * * *", triggerCron);
setTimeout(triggerCron, 20_000); // 启动补跑一次(停机期间错过的槽位由幂等认领兜底)

const shutdown = (signal) => {
  console.log(`[webtask] ${signal} -> shutdown`);
  server.close(() => { try { env.DB.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(0), 4000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));