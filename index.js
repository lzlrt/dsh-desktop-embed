/**
 * dsh-desktop-embed —— 宿主半区（装在**手机**侧那一份 DSH 上）。
 *
 * 要解决的问题
 * ------------
 * DSHA 的 WebView 只认 `http://127.0.0.1:<端口>` 这一个服务，任何**顶层**跳转到别的
 * 地址都会被 `openExternal()` 交给系统浏览器。源码里那行判断写得很清楚：
 *
 *   // 插件的 iframe / 内嵌预览保持 WebView 原有行为，只接管顶层导航。
 *   if (!request.isForMainFrame()) return false;
 *
 * 也就是说：**iframe 是被允许的，被拦掉的只有顶层跳转。** 于是只要让桌面版界面以
 * `127.0.0.1` 的地址出现在一个 iframe 里，它就留在 DSHA 里，不会再被甩给浏览器。
 *
 * 但直接把中继地址塞进 iframe 不行：`/pair-accept` 下发的 `dsh_pair` 是
 * `SameSite=Lax; Secure`，而 DSHA 又显式关掉了第三方 cookie
 * （`cookies.setAcceptThirdPartyCookies(view, false)`），跨站的 iframe 拿不到它。
 *
 * 所以这里起一个**回环反向代理**（默认 127.0.0.1:8799）：代理自己持有配对 cookie，
 * 服务端注入到每一个上游请求里；浏览器侧完全不需要 cookie。iframe 指向代理，
 * 代理把 `https://<中继>` 以 `http://127.0.0.1:8799` 同源端出来 —— 页面里的
 * 绝对路径（`/assets/…`、`/plugins/…`、`/api/…`）和 WebSocket 全部照常工作。
 *
 * 路由（都挂在这台手机的 DSH 上）
 * ------------------------------
 *   GET  /embed                 iframe 外壳页（全屏，零外链）
 *   GET  /embed/setup           无脚本配置表单
 *   POST /embed/setup           保存并立即配对一次，然后 303 到 /embed
 *   GET  /api/dsh-embed/status  同源 JSON 诊断
 *
 * 配置来源（命中即停）：本行 config → 环境变量 → `$DSH_HOME/dsh-embed.json`
 *
 *   {
 *     "bridgeUrl": "http://192.168.100.2:8791",   // dsha-pair/bridge.py
 *     "bridgeKey": "<bridge-secret.txt 的内容>",
 *     "proxyPort": 8799
 *   }
 *
 * 配对流程：`GET {bridgeUrl}/link` 铸一枚码 → 取回 `pair-accept?pair=…` 的
 * `Set-Cookie: dsh_pair=…`（不跟随重定向，只留 cookie）→ 中继 origin 由该链接推出。
 * cookie 只留在内存里，进程重启就重铸一枚；设备会话本身仍然沿用
 * `~/.dsh/remote-web-ui-devices.json`，重启 `dsh web` 不会掉。
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { Agent as HttpAgent, createServer, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NS = 'dsh-embed'
const EMBED_PATH = '/embed'
const SETUP_PATH = '/embed/setup'
const STATUS_PATH = '/api/dsh-embed/status'
const DEFAULT_PROXY_PORT = 8799
const CONFIG_FILE_NAME = 'dsh-embed.json'
/** cookie 由 `/embed` 下发、由代理校验；都绑在 127.0.0.1 上（cookie 不区分端口）。 */
const GATE_COOKIE = 'dsh_embed'
const TARGET_COOKIE = 'dsh_pair'

/**
 * 这两条是「第一次打开要等一两分钟」的主要来源：每个资源都新建一条 TCP+TLS
 * 连接，手机上每次握手几百毫秒，几十个资源排下来就是一分钟。改成 keep-alive
 * 池以后同一台中继上的请求复用同一条连接。
 */
const httpAgent = new HttpAgent({ keepAlive: true, keepAliveMsecs: 20000, maxSockets: 16 })
const httpsAgent = new HttpsAgent({ keepAlive: true, keepAliveMsecs: 20000, maxSockets: 16 })

/** 静态资源（带内容哈希的文件名）可以长期缓存；入口页 5 分钟内有效。 */
const MAX_CACHE_ENTRY = 4 * 1024 * 1024
const MAX_CACHE_BYTES = 96 * 1024 * 1024
const ENTRY_TTL_MS = 5 * 60 * 1000

function agentFor(target) {
  return target.protocol === 'https:' ? httpsAgent : httpAgent
}

/**
 * 定位随 harness 一起安装的 schemastery；找不到就不导出 Config，
 * 插件仍然可以用文件 / 环境变量配置。裸 `import` 在插件目录里解析不到，
 * 会把整个插件一起拖死。
 * @returns {any} schemastery 的 z 函数，或 undefined
 */
function loadSchemastery() {
  const requireFrom = createRequire(import.meta.url)
  const candidates = ['@deepseek-ai/schemastery']
  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1) {
    const dir = dirname(resolve(argv1))
    candidates.push(join(dir, '..', 'node_modules', '@deepseek-ai', 'schemastery'))
    candidates.push(join(dir, 'node_modules', '@deepseek-ai', 'schemastery'))
  }
  try {
    for (const base of requireFrom.resolve.paths?.('@deepseek-ai/schemastery') ?? []) {
      candidates.push(join(base, '@deepseek-ai', 'schemastery'))
    }
  } catch {}
  for (const spec of candidates) {
    try {
      const mod = requireFrom(spec)
      const z = mod?.default ?? mod
      if (typeof z === 'function') return z
    } catch {}
  }
  return undefined
}

const z = loadSchemastery()
const configSchema = z?.object({
  bridgeUrl: z.string().description('中转地址，例如 http://192.168.100.2:8791（dsha-pair/bridge.py）'),
  bridgeKey: z.string().description('中转密钥，就是 bridge-secret.txt 的内容'),
  proxyPort: z.natural().description('回环代理端口，默认 8799'),
})

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

function configPath() {
  return join(dshHome(), CONFIG_FILE_NAME)
}

function readConfigFile() {
  const file = configPath()
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeConfigFile(next) {
  const file = configPath()
  const tmp = `${file}.tmp`
  const payload = `${JSON.stringify(next, null, 2)}\n`
  writeFileSync(tmp, payload, { mode: 0o600 })
  try {
    renameSync(tmp, file)
  } catch {
    writeFileSync(file, payload, { mode: 0o600 })
  }
}

/** 逐字段读配置：Cordis 的 config 是代理对象，整块展开可能抛错。 */
function resolveConfig(live) {
  const fromFile = readConfigFile()
  const pick = (name, envName, fallback) => {
    let value
    try {
      value = live?.[name]
    } catch {
      value = undefined
    }
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return value
    const env = process.env[envName]
    if (typeof env === 'string' && env.trim()) return env.trim()
    const file = fromFile[name]
    if (typeof file === 'string' && file.trim()) return file.trim()
    if (typeof file === 'number' && Number.isFinite(file)) return file
    return fallback
  }
  const port = Number(pick('proxyPort', 'DSH_EMBED_PORT', DEFAULT_PROXY_PORT))
  return {
    bridgeUrl: String(pick('bridgeUrl', 'DSH_EMBED_BRIDGE_URL', '')).replace(/\/+$/, ''),
    bridgeKey: String(pick('bridgeKey', 'DSH_EMBED_BRIDGE_KEY', '')),
    proxyPort: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PROXY_PORT,
  }
}

/** 会话状态：中继 origin + 配对 cookie，全在内存里。 */
function createState() {
  return {
    relay: '',
    cookie: '',
    mintedAt: 0,
    lastError: '',
    server: null,
    actualPort: 0,
    gate: randomBytes(8).toString('hex'),
    minting: null,
    cache: new Map(),
    cacheBytes: 0,
    inflight: new Map(),
    warming: null,
    warm: null,
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch])
}

function sendHtml(res, status, body) {
  const raw = Buffer.from(body, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(raw.length),
    'cache-control': 'no-store',
  })
  res.end(raw)
}

function sendJson(res, status, obj) {
  const raw = Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(raw.length),
    'cache-control': 'no-store',
  })
  res.end(raw)
}

function parseCookies(header) {
  const out = {}
  if (typeof header !== 'string' || !header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const name = part.slice(0, idx).trim()
    if (!name) continue
    out[name] = part.slice(idx + 1).trim()
  }
  return out
}

/**
 * 铸一次配对：bridge 铸码 → 取回 pair-accept 的 Set-Cookie。
 * 只留 `dsh_pair`，不跟随 303（跟过去只会把设备会话又打一次）。
 */
async function mint(cfg) {
  if (!cfg.bridgeUrl) throw new Error('还没配置中转地址（bridgeUrl）')
  const linkRes = await fetch(`${cfg.bridgeUrl}/link`, {
    headers: cfg.bridgeKey ? { 'x-pair-key': cfg.bridgeKey } : {},
    redirect: 'manual',
  })
  if (!linkRes.ok) throw new Error(`中转返回 HTTP ${linkRes.status}`)
  const link = await linkRes.json()
  const pairUrl = typeof link?.url === 'string' ? link.url : ''
  if (!pairUrl) throw new Error('中转没有返回配对链接')
  const accept = await fetch(pairUrl, { redirect: 'manual' })
  const cookies = typeof accept.headers.getSetCookie === 'function' ? accept.headers.getSetCookie() : []
  const pair = cookies
    .map((line) => line.split(';')[0].trim())
    .find((line) => line.startsWith(`${TARGET_COOKIE}=`))
  if (!pair) throw new Error(`配对链接没有下发 cookie（HTTP ${accept.status}）`)
  return { relay: new URL(pairUrl).origin, cookie: pair }
}

/** 同一时刻只铸一次。 */
function ensureSession(state, cfg) {
  if (state.minting) return state.minting
  state.minting = (async () => {
    try {
      const { relay, cookie } = await mint(cfg)
      state.relay = relay
      state.cookie = cookie
      state.mintedAt = Date.now()
      state.lastError = ''
    } catch (error) {
      state.lastError = error?.message ?? String(error)
      throw error
    } finally {
      state.minting = null
    }
  })()
  return state.minting
}

/** 直接向中继取一份（预热专用，不走浏览器那一层）。 */
function fetchThrough(state, path, method = 'GET') {
  return new Promise((resolvePromise, rejectPromise) => {
    const target = new URL(path, state.relay)
    const mod = target.protocol === 'https:' ? httpsRequest : httpRequest
    const req = mod(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method,
        path: upstreamPath(path),
        headers: {
          host: target.host,
          cookie: state.cookie,
          accept: '*/*',
          'accept-encoding': 'identity',
          'user-agent': 'dsh-embed-prewarm/1.1',
        },
        agent: agentFor(target),
      },
      (up) => {
        const chunks = []
        let size = 0
        up.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_CACHE_ENTRY * 2) {
            up.destroy()
            rejectPromise(new Error('响应超过预热上限'))
            return
          }
          chunks.push(chunk)
        })
        up.on('end', () =>
          resolvePromise({ status: up.statusCode ?? 0, type: String(up.headers['content-type'] || ''), body: Buffer.concat(chunks) }),
        )
        up.on('error', rejectPromise)
      },
    )
    req.on('error', rejectPromise)
    req.end()
  })
}

/** 从入口页里挑出要预热的资源（只认本地的 /assets、/plugins）。 */
function extractAssets(html) {
  const out = []
  const seen = new Set()
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/g
  let match
  while ((match = re.exec(html))) {
    let value = match[1].trim()
    if (!value || value.startsWith('data:') || value.startsWith('http://') || value.startsWith('https://')) continue
    if (value.startsWith('./')) value = value.slice(1)
    // 入口页里有两种写法：`./assets/x.js` 和裸相对的 `plugins/??a,b,c`
    if (!value.startsWith('/') && (value.startsWith('assets/') || value.startsWith('plugins/'))) value = `/${value}`
    if (!value.startsWith('/assets/') && !value.startsWith('/plugins/')) continue
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * 预热：用户点按钮之前，先把入口页和它引用的资源拉进内存缓存。
 * 这样 iframe 真正启动时，界面框架的那几十个请求全部命中本地缓存。
 */
function prewarm(state, cfg) {
  if (state.warming) return state.warming
  state.warming = (async () => {
    const started = Date.now()
    const report = { ok: false, assets: 0, fetched: 0, bytes: 0, ms: 0, at: Date.now(), error: '' }
    try {
      await ensureSession(state, cfg)
      const entry = await fetchThrough(state, ENTRY_PATH)
      if (entry.status !== 200) throw new Error(`入口页 HTTP ${entry.status}`)
      cacheSet(state, ENTRY_PATH, 'text/html; charset=utf-8', entry.body)
      report.bytes += entry.body.length
      const list = extractAssets(entry.body.toString('utf8')).slice(0, 32)
      report.assets = list.length
      let cursor = 0
      const worker = async () => {
        while (cursor < list.length) {
          const item = list[cursor++]
          if (cacheGet(state, item)) {
            report.fetched += 1
            continue
          }
          try {
            const got = await fetchThrough(state, item)
            if (got.status === 200) {
              cacheSet(state, item, got.type, got.body)
              report.bytes += got.body.length
              report.fetched += 1
            }
          } catch {}
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()])
      report.ok = true
    } catch (error) {
      report.error = error?.message ?? String(error)
      state.lastError = report.error
    } finally {
      report.ms = Date.now() - started
      state.warm = report
      state.warming = null
    }
  })()
  return state.warming
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'cookie',
  'origin',
  'referer',
  'accept-encoding',
])

function upstreamHeaders(incoming, cookie, host) {
  const headers = {}
  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase()
    if (HOP_BY_HOP.has(key)) continue
    if (key.startsWith('sec-fetch-')) continue
    if (value === undefined) continue
    headers[key] = value
  }
  headers.host = host
  headers.cookie = cookie
  headers['accept-encoding'] = 'identity'
  return headers
}

/** 下游不能看到上游的 cookie，也不能让它声明自己不许被嵌。 */
const STRIPPED_RESPONSE = new Set([
  'set-cookie',
  'content-encoding',
  'content-length',
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'alt-svc',
  'location',
])

function downstreamHeaders(incoming, upstreamOrigin) {
  const headers = {}
  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase()
    if (STRIPPED_RESPONSE.has(key)) continue
    if (value === undefined) continue
    headers[key] = value
  }
  return headers
}

function rewriteLocation(value, upstreamOrigin) {
  if (typeof value !== 'string' || !value) return value
  try {
    const url = new URL(value, upstreamOrigin)
    if (url.origin === upstreamOrigin) return `${url.pathname}${url.search}${url.hash}`
    return value
  } catch {
    return value
  }
}

function gateOk(state, req) {
  const cookies = parseCookies(req.headers.cookie)
  return cookies[GATE_COOKIE] === state.gate
}

/**
 * 代理入口映射：中继的 `/` 是「认证门」，带 cookie 也只回 401；
 * 真正的应用页在 `/pair-app`。所以把根路径改写成它，其余路径原样透传
 * （`<base href="./">` 让资源仍落在 `/assets/…`、`/plugins/…`）。
 */
const ENTRY_PATH = '/pair-app'

function upstreamPath(rawUrl) {
  const url = new URL(rawUrl || '/', 'http://placeholder.invalid')
  const pathname = url.pathname || '/'
  if (pathname === '/') return `${ENTRY_PATH}${url.search}`
  // 中继把「已认证 API」挂在 /remote 下：GET 两个前缀都通，但 POST/PUT 只认
  // /remote/api/*（裸 /api/* 会被桌面 api-gateway 以 403 forbidden 拒掉）。
  // 浏览器侧只有在 relay 域名上运行时才会自己加这个前缀，127.0.0.1 不会，
  // 所以这里统一补上。
  if (pathname.startsWith('/api/')) return `/remote${pathname}${url.search}`
  return `${pathname}${url.search}`
}

/** 只有静态资源进缓存：带内容哈希，路径一变就是新文件，不存在脏读。 */
function cacheableKey(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return ''
  let pathname = '/'
  try {
    pathname = new URL(req.url || '/', 'http://placeholder.invalid').pathname || '/'
  } catch {
    return ''
  }
  if (pathname === '/') return ENTRY_PATH
  if (pathname.startsWith('/assets/')) return pathname
  if (pathname.startsWith('/plugins/')) return pathname
  return ''
}

function cacheGet(state, key) {
  const hit = state.cache.get(key)
  if (!hit) return null
  if (key === ENTRY_PATH && Date.now() - hit.at > ENTRY_TTL_MS) {
    state.cache.delete(key)
    state.cacheBytes -= hit.body.length
    return null
  }
  // LRU：命中就挪到末尾
  state.cache.delete(key)
  state.cache.set(key, hit)
  return hit
}

function cacheSet(state, key, type, body) {
  if (!body || body.length === 0 || body.length > MAX_CACHE_ENTRY) return
  const old = state.cache.get(key)
  if (old) {
    state.cache.delete(key)
    state.cacheBytes -= old.body.length
  }
  state.cache.set(key, { type: type || 'application/octet-stream', body, at: Date.now() })
  state.cacheBytes += body.length
  while (state.cacheBytes > MAX_CACHE_BYTES && state.cache.size > 1) {
    const [oldestKey, oldest] = state.cache.entries().next().value
    state.cache.delete(oldestKey)
    state.cacheBytes -= oldest.body.length
  }
}

/**
 * 手机上的排版修补：直接注入 iframe 里那份文档。
 * iframe 与外层不同源（端口不同），外层改不了它的 DOM，只能在代理这一层注入；
 * 全部规则都在 `(max-width: 1023px) and (pointer: coarse)` 里，桌面上完全无副作用。
 */
const MOBILE_CSS = `@media (max-width: 1023px) and (pointer: coarse) {
  html { -webkit-text-size-adjust: 100%; }
  body { overflow-x: hidden; }
  button, [role="button"], [role="tab"], [role="menuitem"], [role="option"] { min-height: 40px; min-width: 40px; }
  input, select, textarea { min-height: 40px; font-size: 16px; }
  [class*="drawer"], aside { max-width: 88vw; }
  table { display: block; overflow-x: auto; }
  textarea { padding-bottom: max(10px, env(safe-area-inset-bottom)); }
}`

/** 给 iframe 里的文档报进度用；只 postMessage，不碰 DOM。 */
const PROGRESS_SCRIPT = `<script id="dsh-embed-progress">(function(){var send=function(t){try{parent.postMessage({source:'dsh-embed',type:t},'*')}catch(e){}};send('dom');addEventListener('load',function(){send('load')});var n=0,t=setInterval(function(){if(window.__DSH_BOOT_READY__){send('boot');clearInterval(t)}if(++n>480)clearInterval(t)},250)})()<\/script>`

function injectIntoHtml(html) {
  const style = `<style id="dsh-embed-mobile">${MOBILE_CSS}</style>`
  let out = html.includes('</head>') ? html.replace('</head>', `${style}</head>`) : style + html
  out = out.includes('</body>') ? out.replace('</body>', `${PROGRESS_SCRIPT}</body>`) : out + PROGRESS_SCRIPT
  return out
}

/**
 * 通用反向代理：路径、方法、请求体、响应体一律原样转发，cookie 服务端注入。
 * 上游 401 时重铸一次再重试（设备会话过期 / cookie 被顶掉的常见情形）。
 */
function proxyOnce(state, clientReq, clientRes, retried = false) {
  if (!state.relay || !state.cookie) {
    return sendHtml(
      clientRes,
      503,
      page('还没配对', '<p>这个代理还没有拿到配对 cookie。</p><p><a href="/embed/setup">先配置中转</a></p>'),
    )
  }
  const target = new URL(clientReq.url || '/', state.relay)
  if (target.origin !== state.relay) {
    return sendHtml(clientRes, 400, page('地址不对', '<p>只代理同一个中继。</p>'))
  }
  const cacheKey = cacheableKey(clientReq)
  if (cacheKey) {
    const hit = cacheGet(state, cacheKey)
    if (hit) {
      // 入口页命中也要补注入（缓存里存的是原始 HTML），
      // 注入后长度会变，content-length 必须按最终 body 算，否则响应会被截断。
      const body = cacheKey === ENTRY_PATH ? Buffer.from(injectIntoHtml(hit.body.toString('utf8'))) : hit.body
      clientRes.writeHead(200, {
        'content-type': hit.type,
        'content-length': String(body.length),
        'cache-control': cacheKey === ENTRY_PATH ? 'no-cache' : 'public, max-age=31536000, immutable',
        'x-dsh-embed-cache': 'hit',
      })
      clientRes.end(body)
      return
    }
    // 预热和真实请求撞在一起时只发一次上游请求
    const pending = state.inflight.get(cacheKey)
    if (pending) {
      pending
        .catch(() => {})
        .then(() => proxyOnce(state, clientReq, clientRes, retried))
      return
    }
  }

  const mod = target.protocol === 'https:' ? httpsRequest : httpRequest
  const wanted = upstreamPath(clientReq.url)
  const upstream = mod({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: clientReq.method,
    path: wanted,
    headers: upstreamHeaders(clientReq.headers, state.cookie, target.host),
    agent: agentFor(target),
  })
  if (cacheKey) {
    let settle
    const done = new Promise((r) => {
      settle = r
    })
    state.inflight.set(cacheKey, done)
    const clear = () => {
      if (state.inflight.get(cacheKey) === done) state.inflight.delete(cacheKey)
      settle()
    }
    upstream.on('close', clear)
    upstream.on('error', clear)
    upstream.on('response', (up) => {
      up.on('end', clear)
      up.on('error', clear)
    })
  }
  upstream.on('response', (up) => {
    if (up.statusCode === 401 && !retried && state.canRemint) {
      up.resume()
      return state
        .remint()
        .then(() => proxyOnce(state, clientReq, clientRes, true))
        .catch((error) => proxyOnce(state, clientReq, clientRes, true) ?? sendHtml(clientRes, 502, page('上游失败', `<p>${escapeHtml(error?.message)}</p>`)))
    }
    const type = String(up.headers['content-type'] || '')
    const status = up.statusCode ?? 502

    // 入口页：缓冲下来做两件事——写进缓存、注入手机排版与进度脚本
    if (status === 200 && type.includes('text/html') && (cacheKey === ENTRY_PATH || wanted === ENTRY_PATH)) {
      const chunks = []
      up.on('data', (chunk) => chunks.push(chunk))
      up.on('end', () => {
        const raw = Buffer.concat(chunks)
        cacheSet(state, ENTRY_PATH, 'text/html; charset=utf-8', raw)
        const body = Buffer.from(injectIntoHtml(raw.toString('utf8')))
        const headers = downstreamHeaders(up.headers, state.relay)
        headers['content-type'] = 'text/html; charset=utf-8'
        headers['content-length'] = String(body.length)
        headers['cache-control'] = 'no-cache'
        headers['x-dsh-embed-injected'] = 'mobile'
        clientRes.writeHead(200, headers)
        clientRes.end(body)
      })
      up.on('error', () => {
        if (!clientRes.headersSent) sendHtml(clientRes, 502, page('上游失败', '<p>入口页读取中断。</p>'))
        else clientRes.destroy()
      })
      return
    }

    // 静态资源：边转发边存，超过上限就放弃缓存但照常转发
    if (status === 200 && cacheKey && !type.includes('text/html')) {
      const chunks = []
      let size = 0
      let streaming = false
      up.on('data', (chunk) => {
        if (streaming) return
        chunks.push(chunk)
        size += chunk.length
        if (size > MAX_CACHE_ENTRY) {
          streaming = true
          const headers = downstreamHeaders(up.headers, state.relay)
          clientRes.writeHead(status, headers)
          clientRes.write(Buffer.concat(chunks))
          chunks.length = 0
        }
      })
      up.on('end', () => {
        if (streaming) {
          clientRes.end()
          return
        }
        const body = Buffer.concat(chunks)
        cacheSet(state, cacheKey, type || 'application/octet-stream', body)
        const headers = downstreamHeaders(up.headers, state.relay)
        headers['content-length'] = String(body.length)
        headers['cache-control'] = 'public, max-age=31536000, immutable'
        headers['x-dsh-embed-cache'] = 'miss'
        clientRes.writeHead(status, headers)
        clientRes.end(body)
      })
      up.on('error', () => clientRes.destroy())
      return
    }

    const headers = downstreamHeaders(up.headers, state.relay)
    const location = rewriteLocation(up.headers.location, state.relay)
    if (location) headers.location = location
    clientRes.writeHead(status, headers)
    up.pipe(clientRes)
  })
  upstream.on('error', (error) => {
    if (!clientRes.headersSent) {
      sendHtml(clientRes, 502, page('上游失败', `<p>${escapeHtml(error?.message ?? error)}</p>`))
    } else {
      clientRes.destroy()
    }
  })
  clientReq.pipe(upstream)
}

/** WebSocket / 其它 upgrade：握手与后续字节全部双向打通。 */
function proxyUpgrade(state, req, socket, head) {
  if (!gateOk(state, req) || !state.relay || !state.cookie) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }
  const target = new URL(req.url || '/', state.relay)
  const mod = target.protocol === 'https:' ? httpsRequest : httpRequest
  const headers = upstreamHeaders(req.headers, state.cookie, target.host)
  headers.connection = 'Upgrade'
  headers.upgrade = req.headers.upgrade || 'websocket'
  if (req.headers['sec-websocket-key']) headers['sec-websocket-key'] = req.headers['sec-websocket-key']
  if (req.headers['sec-websocket-version']) headers['sec-websocket-version'] = req.headers['sec-websocket-version']
  const upstream = mod({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: 'GET',
    path: upstreamPath(req.url),
    headers,
    agent: agentFor(target),
  })
  upstream.on('upgrade', (up, upSocket, upHead) => {
    const lines = [`HTTP/1.1 101 ${up.statusMessage || 'Switching Protocols'}`]
    const raw = up.rawHeaders || []
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const name = String(raw[i]).toLowerCase()
      if (name === 'upgrade' || name === 'connection' || name === 'sec-websocket-accept' || name === 'sec-websocket-protocol' || name === 'sec-websocket-extensions') {
        lines.push(`${raw[i]}: ${raw[i + 1]}`)
      }
    }
    if (!raw.some((name) => String(name).toLowerCase() === 'sec-websocket-accept')) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      return
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (upHead?.length) upSocket.unshift(upHead)
    if (head?.length) upSocket.write(head)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
    const kill = () => {
      upSocket.destroy()
      socket.destroy()
    }
    upSocket.on('error', kill)
    socket.on('error', kill)
    upSocket.on('close', () => socket.destroy())
    socket.on('close', () => upSocket.destroy())
  })
  upstream.on('response', (up) => {
    const body = `上游拒绝了 upgrade（HTTP ${up.statusCode ?? 0}）\n`
    up.resume()
    socket.end(`HTTP/1.1 ${up.statusCode ?? 502} Bad Gateway\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  })
  upstream.on('error', () => socket.destroy())
  upstream.end()
}

function page(title, body, extraHead = '') {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 24px; }
  main { max-width: 680px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p, li { color: #444; }
  label { display: block; margin: 14px 0 6px; font-size: 14px; color: #555; }
  input { width: 100%; box-sizing: border-box; font-size: 16px; padding: 10px 12px;
          border: 1px solid #bbb; border-radius: 10px; }
  button { margin-top: 18px; width: 100%; min-height: 44px; font-size: 16px;
           border: 0; border-radius: 12px; background: #2b6cff; color: #fff; }
  .note { font-size: 13px; color: #666; margin-top: 6px; }
  a { color: #2b6cff; }
  @media (prefers-color-scheme: dark) { p, li { color: #bbb; } input { background: #1b1b1b; color: #eee; border-color: #444; } .note { color: #999; } }
</style>${extraHead}</head><body><main>${body}</main></body></html>`
}

/** iframe 外壳：iframe + 一层加载进度（纯 CSS 动画，界面一就绪就淡出）。 */
function embedPage(state, port) {
  const src = `http://127.0.0.1:${port}/`
  const origin = `http://127.0.0.1:${port}`
  const warm = state.warm?.ok ? `<span id="dsh-embed-warm">已预热 ${state.warm.fetched}/${state.warm.assets}</span>` : ''
  const overlay = `<div id="dsh-embed-cover">
  <div class="ring"></div>
  <b>正在打开桌面版</b>
  <p id="dsh-embed-step">正在建立配对…</p>
  <span id="dsh-embed-time">0s</span>
  ${warm}
  <a href="/embed/setup">设置</a>
</div>`
  const script = `<script>(function(){
  var cover=document.getElementById('dsh-embed-cover')
  var step=document.getElementById('dsh-embed-step')
  var clock=document.getElementById('dsh-embed-time')
  var frame=document.getElementById('dsh-embed-frame')
  var t0=Date.now(), hints=[[0,'正在建立配对…'],[6,'正在下载界面资源（第一次最慢）…'],[20,'正在启动界面插件…'],[45,'中继这条路有点慢，还在下载…']]
  var timer=setInterval(function(){
    var s=Math.round((Date.now()-t0)/1000)
    clock.textContent=s+'s'
    var pick=0
    for(var i=0;i<hints.length;i++){ if(s>=hints[i][0]) pick=i }
    if(step.textContent!==hints[pick][1]) step.textContent=hints[pick][1]
  },500)
  function done(){
    if(!cover||cover.dataset.done) return
    cover.dataset.done='1'
    window.__DSH_EMBED_READY_MS__=Math.round(performance.now())
    clearInterval(timer)
    cover.style.opacity='0'; cover.style.pointerEvents='none'
    setTimeout(function(){ if(cover&&cover.parentNode) cover.parentNode.removeChild(cover) },500)
  }
  window.addEventListener('message',function(e){
    if(e.origin!=='${origin}') return
    var d=e.data
    if(d&&d.source==='dsh-embed'&&(d.type==='load'||d.type==='boot')) done()
  })
  frame.addEventListener('load',function(){ setTimeout(done,600) })
  setTimeout(function(){ if(cover&&!cover.dataset.done) step.textContent='还没回来：确认电脑上 bridge.py 在跑，或回设置页重填地址。' },180000)
})()<\/script>`
  return page(
    '桌面版 DSH',
    `<iframe id="dsh-embed-frame" src="${escapeHtml(src)}" title="桌面版 DSH"
       allow="clipboard-read; clipboard-write; microphone; camera"
       style="position:fixed;inset:0;width:100%;height:100%;border:0;background:#fff"></iframe>
     ${overlay}
     <a href="/embed/setup" title="中转与端口设置"
        style="position:fixed;right:10px;bottom:calc(10px + env(safe-area-inset-bottom));z-index:2147483000;
               width:40px;height:40px;border-radius:20px;background:rgba(0,0,0,.45);color:#fff;
               display:flex;align-items:center;justify-content:center;text-decoration:none;
               font:18px/1 system-ui">⚙</a>
     ${script}`,
    `<style>
  body{margin:0;padding:0;overflow:hidden}
  #dsh-embed-cover{position:fixed;inset:0;z-index:2147483600;background:#0f1115;color:#e8e8ea;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
    font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;transition:opacity .4s}
  #dsh-embed-cover b{font-size:17px;font-weight:600}
  #dsh-embed-cover p{margin:0;color:#9aa0a6;font-size:14px;max-width:80vw;text-align:center}
  #dsh-embed-cover span{color:#6b7280;font-size:13px}
  #dsh-embed-cover a{color:#7aa2ff;font-size:14px;text-decoration:none;margin-top:4px}
  .ring{width:38px;height:38px;border-radius:50%;border:3px solid rgba(255,255,255,.15);
    border-top-color:#7aa2ff;animation:dsh-embed-spin 1s linear infinite}
  @keyframes dsh-embed-spin{to{transform:rotate(360deg)}}
</style>`,
  )
}

function setupPage(state, cfg, notice = '') {
  const rows = [
    ['bridgeUrl', '中转地址', cfg.bridgeUrl || 'http://192.168.100.2:8791', '运行 dsha-pair/bridge.py 的那台电脑，手机要能访问到。'],
    ['bridgeKey', '中转密钥', cfg.bridgeKey || '', '就是 bridge-secret.txt 的内容。'],
    ['proxyPort', '回环代理端口', String(cfg.proxyPort || DEFAULT_PROXY_PORT), '默认 8799，只有手机本机能访问。'],
  ]
  const body = `<h1>把桌面版嵌进 DSHA</h1>
<p>这台手机的 DSHA 会把任何顶层跳转交给系统浏览器，但**不会**拦截 iframe。
所以这个插件在手机里起一个回环代理，把电脑上的界面以 <code>127.0.0.1</code> 端出来，
再用 iframe 嵌回 DSHA 自己的页面。</p>
${notice ? `<p style="color:#b00">${escapeHtml(notice)}</p>` : ''}
<p class="note">当前状态：${state.relay ? `已配对 ${escapeHtml(state.relay)}` : '还未配对'}${state.actualPort ? ` · 代理端口 ${state.actualPort}` : ''}</p>
<form method="post" action="/embed/setup">
  ${rows
    .map(
      ([name, label, value, hint]) =>
        `<label for="${name}">${label}</label>
         <input id="${name}" name="${name}" value="${escapeHtml(value)}" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false">
         <div class="note">${escapeHtml(hint)}</div>`,
    )
    .join('\n  ')}
  <button type="submit">保存并配对</button>
</form>
<p class="note">电脑侧要先跑起来：<code>python bridge.py</code>（默认 8791）。
配对只是把一枚 <code>dsh_pair</code> cookie 拿在代理手里，cookie 不会进浏览器。</p>`
  return page('中转设置', body)
}

function readForm(req, limit = 8192) {
  return new Promise((resolvePromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        resolvePromise(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolvePromise(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolvePromise(null)
      }
    })
    req.on('error', () => resolvePromise(null))
  })
}

async function apply(ctx, rawConfig) {
  const state = createState()
  const cfgOf = () => resolveConfig(typeof rawConfig === 'function' ? rawConfig() : rawConfig)

  state.remint = () => ensureSession(state, cfgOf())
  state.canRemint = true

  // 配置里已经有中转地址就先把配对拿好、把资源预热好。
  // 既修掉「重启 DSHA 后不重填设置就打不开」，也让用户点按钮时资源已经在内存里。
  if (cfgOf().bridgeUrl) void prewarm(state, cfgOf())

  // ---- 回环代理 -----------------------------------------------------------
  const proxy = createServer((req, res) => {
    if (!gateOk(state, req)) {
      return sendHtml(
        res,
        403,
        page(
          '需要从 /embed 打开',
          '<p>这个代理只服务于 <a href="/embed">/embed</a> 那个页面。直接从地址栏打开是拿不到通行 cookie 的。</p>',
        ),
      )
    }
    proxyOnce(state, req, res)
  })
  proxy.on('upgrade', (req, socket, head) => proxyUpgrade(state, req, socket, head))

  const cfg = cfgOf()
  const port = cfg.proxyPort
  await new Promise((resolvePromise) => {
    proxy.once('error', (error) => {
      state.lastError = `端口 ${port} 起不来：${error?.message ?? error}`
      resolvePromise(null)
    })
    proxy.listen(port, '127.0.0.1', () => {
      state.server = proxy
      state.actualPort = proxy.address()?.port ?? port
      resolvePromise(null)
    })
  })

  // ---- 页面与接口 ---------------------------------------------------------
  const embedRoute = ctx.webServer.register({
    kind: 'exact',
    path: EMBED_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET' })
        return res.end()
      }
      const portNow = state.actualPort || port
      res.setHeader(
        'set-cookie',
        `${GATE_COOKIE}=${state.gate}; Path=/; HttpOnly; SameSite=Lax`,
      )
      sendHtml(res, 200, embedPage(state, portNow))
    },
  })

  const setupRoute = ctx.webServer.register({
    kind: 'exact',
    path: SETUP_PATH,
    handler: async (req, res) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        return sendHtml(res, 200, setupPage(state, cfgOf()))
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, POST' })
        return res.end()
      }
      const form = await readForm(req)
      if (!form) return sendHtml(res, 400, setupPage(state, cfgOf(), '提交内容太大或格式不对。'))
      const next = {
        bridgeUrl: String(form.get('bridgeUrl') ?? '').trim().replace(/\/+$/, ''),
        bridgeKey: String(form.get('bridgeKey') ?? '').trim(),
        proxyPort: Number(form.get('proxyPort') ?? DEFAULT_PROXY_PORT),
      }
      if (!/^https?:\/\/[^\s]+$/i.test(next.bridgeUrl)) {
        return sendHtml(res, 400, setupPage(state, next, '中转地址要写成 http:// 或 https:// 开头的完整地址。'))
      }
      if (!Number.isInteger(next.proxyPort) || next.proxyPort < 1024 || next.proxyPort > 65535) {
        return sendHtml(res, 400, setupPage(state, next, '端口要在 1024–65535 之间。'))
      }
      writeConfigFile(next)
      try {
        await ensureSession(state, next)
      } catch (error) {
        return sendHtml(res, 502, setupPage(state, next, `配对失败：${error?.message ?? error}`))
      }
      void prewarm(state, next)
      res.writeHead(303, { location: EMBED_PATH, 'cache-control': 'no-store' })
      res.end()
    },
  })

  const statusRoute = ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        return res.end()
      }
      const live = cfgOf()
      sendJson(res, 200, {
        ok: true,
        relay: state.relay,
        paired: Boolean(state.cookie),
        mintedAt: state.mintedAt,
        lastError: state.lastError,
        proxyPort: state.actualPort || live.proxyPort,
        bridgeUrl: live.bridgeUrl,
        configPath: configPath(),
        embedPath: EMBED_PATH,
        cache: {
          entries: state.cache.size,
          bytes: state.cacheBytes,
          budget: MAX_CACHE_BYTES,
        },
        warm: state.warm,
      })
    },
  })

  ctx.effect?.(() => () => {
    embedRoute?.()
    setupRoute?.()
    statusRoute?.()
    try {
      state.server?.close()
    } catch {}
  })
}

export const name = NS
export const inject = ['webServer']
export { apply }
export { configSchema as Config }
