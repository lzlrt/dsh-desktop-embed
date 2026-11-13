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
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
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
  const mod = target.protocol === 'https:' ? httpsRequest : httpRequest
  const upstream = mod({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: clientReq.method,
    path: upstreamPath(clientReq.url),
    headers: upstreamHeaders(clientReq.headers, state.cookie, target.host),
    agent: false,
  })
  upstream.on('response', (up) => {
    if (up.statusCode === 401 && !retried && state.canRemint) {
      up.resume()
      return state
        .remint()
        .then(() => proxyOnce(state, clientReq, clientRes, true))
        .catch((error) => proxyOnce(state, clientReq, clientRes, true) ?? sendHtml(clientRes, 502, page('上游失败', `<p>${escapeHtml(error?.message)}</p>`)))
    }
    const headers = downstreamHeaders(up.headers, state.relay)
    const location = rewriteLocation(up.headers.location, state.relay)
    if (location) headers.location = location
    clientRes.writeHead(up.statusCode ?? 502, headers)
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
    agent: false,
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

/** iframe 外壳：整页只有一个 iframe，唯一的外壳元素是一个小齿轮。 */
function embedPage(state, port) {
  const src = `http://127.0.0.1:${port}/`
  return page(
    '桌面版 DSH',
    `<iframe src="${escapeHtml(src)}" title="桌面版 DSH"
       allow="clipboard-read; clipboard-write; microphone; camera"
       style="position:fixed;inset:0;width:100%;height:100%;border:0;background:#fff"></iframe>
     <a href="/embed/setup" title="中转与端口设置"
        style="position:fixed;right:10px;bottom:calc(10px + env(safe-area-inset-bottom));z-index:2147483000;
               width:40px;height:40px;border-radius:20px;background:rgba(0,0,0,.45);color:#fff;
               display:flex;align-items:center;justify-content:center;text-decoration:none;
               font:18px/1 system-ui">⚙</a>`,
    '<style>body{margin:0;padding:0;overflow:hidden}</style>',
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
