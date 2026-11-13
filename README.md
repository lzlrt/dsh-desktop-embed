# dsh-desktop-embed

> **为 [`dsh-desktop-link`](https://github.com/lzlrt/dsha-desktop-link) 的下半场而生。**
> 那个插件把手机送到电脑版门口；这个插件负责把门整个搬进 DSHA——**桌面界面直接嵌在 DSHA 里用，不再跳外部浏览器**。

## 它解决什么

`dsh-desktop-link` 的行为是「跳转」：手机上的顶层导航离开本机服务时，DSHA 按设计把它交给系统浏览器（`WebPreviewActivity.shouldOverrideUrlLoading` → `openExternal`）。于是界面进了 Chrome / 夸克，DSHA 只剩一个壳，原生外壳的价值就没了。

`dsh-desktop-embed` 换成另一种走法：**手机上开一个回环反向代理，用一个 iframe 把电脑版界面装进来**。

```
DSHA 的 WebView
 └── 顶层文档  http://127.0.0.1:<手机 DSH 端口>/embed      ← 始终是本机服务，DSHA 不管
      └── iframe  http://127.0.0.1:8799/                  ← 本插件的反向代理
           └── https://<你的中继>/pair-app                 ← 电脑上的 dsh web
```

三层里只有最里面是真的远端。中间那层由插件自己持有 `dsh_pair` cookie 并在服务端注入，所以**浏览器侧完全不需要第三方 cookie**——正好绕开 DSHA 关掉的 `AcceptThirdPartyCookies`。

两条 DSHA 的既有行为被这个结构利用上了：

- `shouldOverrideUrlLoading` 只接管 **main frame**，iframe 显式放行（源码注释原文：「插件的 iframe / 内嵌预览保持 WebView 原有行为，只接管顶层导航。」）。
- `WebPreviewPolicy.loopbackBaseUrl` 接受 **任意回环端口**（`http://127.0.0.1:<1..65535>/`），不只是 DSH 自己那个端口——所以 8799 也是一个合法的「本机服务」。

代理挂在根路径上，所以 `/assets/…`、`/plugins/…`、`/api/…` 全部照常穿过。三处路径改写是实测出来的，缺一个页面就起不来：

| 进来的路径 | 发给中继的路径 | 为什么 |
|---|---|---|
| `/` | `/pair-app` | 中继的 `/` 是「认证门」，带着有效 cookie 也只回 401；应用页在 `/pair-app` |
| `/api/…` | `/remote/api/…` | 中继把已认证 API 挂在 `/remote` 下。GET 两个前缀都通，但 **POST/PUT 只认 `/remote/api/…`**，裸 `/api/*` 会被桌面 api-gateway 回 `403 forbidden`，页面就永远停在「Loading plugins…」 |
| 其它 | 原样 | `<base href="./">` 让资源和插件目录仍落在 `/assets/…`、`/plugins/…` |

## 装在哪一侧

**手机侧（DSHA 内置的那个 DSH）**。页面由手机自己的 DSH 提供，代理也跑在手机上。

```bash
dsh plugin --profile web add dsh-desktop-embed
```

装完刷新页面，侧栏底部多一个「桌面版」按钮。

## 第一次使用：填两个值

点侧栏的「桌面版」按钮会先打开 `/embed/setup`（纯表单，没有 JavaScript）：

| 字段 | 填什么 |
|---|---|
| 中转地址 | `dsh-desktop-link` 那套 `bridge.py` 的地址，例如 `http://192.168.100.2:8791` |
| 中转密钥 | `bridge-secret.txt` 里的那串 hex |
| 代理端口 | 留空用默认 `8799`；被占用就换一个 1024–65535 |

提交后插件会立刻向桥要一次配对链接（`GET /link`）、跟一次 `/pair-accept`，把 `dsh_pair` 拿在手里，然后 303 跳到 `/embed`。

配置落在 `$DSH_HOME/dsh-embed.json`（权限 `0600`）。也可以用环境变量覆盖：

```bash
export DSH_EMBED_BRIDGE_URL=http://192.168.100.2:8791
export DSH_EMBED_BRIDGE_KEY=<bridge-secret>
export DSH_EMBED_PORT=8799
```

## 自检

```bash
curl -s http://127.0.0.1:8799/embed/setup -H 'sec-fetch-site: none' | grep -o 'name="[a-zA-Z]*"'
```

手机端更直接：点按钮 → 填两个值 → 页面里出现电脑版界面，且**地址栏仍是 127.0.0.1**。

## 为什么第一次打开慢，以及 1.1.0 做了什么

手机上第一次打开要等一两分钟，主要不是「电脑慢」，是这条链路上重复了太多工作：

- 每取一个资源都新建一条 TCP + TLS 连接；界面的框架资源有几十个，手机上每次握手几百毫秒，串起来就是一分钟。
- 入口页引用的主 JS 单文件约 940 KB，从中继直取实测 **6.05 秒**。
- 用户在点按钮之后才开始取，前面这段时间完全是干等。

1.1.0 加了四件事：

| 改动 | 效果（同一台中继上实测） |
|---|---|
| 连接池（keep-alive，`maxSockets 16`） | 同一台中继的请求复用连接，不再每次重新握手 |
| 启动时预热：先把入口页和它引用的 `/assets`、`/plugins` 资源拉进内存缓存 | 点按钮时框架资源已经在本地 |
| 静态资源缓存（按内容哈希为键，上限 96 MB）+ 并发请求合并 | 主 JS `941436 B`：中继直取 **6.05 s** → 命中缓存 **1.7 ms** |
| `/embed` 加载进度层（步骤文案 + 秒表 + 「已预热 n/m」） | 不再是白屏干等；实测「页面载入 → 界面就绪」约 **4.5 s**（缓存热） |

预热是**自动**的：插件启动时若已有配置就立即开始，保存设置后也会再跑一次。缓存只在内存里，DSH 重启就没了——重启后的第一次打开会慢一些，之后又是快的。

排查「为什么还是慢」：

```bash
curl http://127.0.0.1:<手机 DSH 端口>/api/dsh-embed/status
```

返回里的 `cache.entries` / `cache.bytes` / `warm`（资产数、成功数、耗时）就是预热结果；`warm.ok=false` 时看 `warm.error`。

## 手机上的排版

iframe 与外层不同源（端口不同），外层改不了里面的 DOM，所以排版修补放在代理这一层：给经过的入口页注入一张样式表，规则全部关在 `@media (max-width: 1023px) and (pointer: coarse)` 里——

- 按钮、`[role=button|tab|menuitem|option]` 最小 40×40，输入框最小高 40 且字号 16px（小于 16px 时 iOS / 部分安卓会放大页面）
- 侧栏 / 抽屉最大 `88vw`，不再盖住全部内容
- 表格横向滚动而不是撑破页面，图片视频限宽，正文禁止横向溢出
- 文本域底部留 `env(safe-area-inset-bottom)`，软键盘弹起时输入框不被顶掉

桌面上这条 media query 不匹配，所以不影响电脑端观感。

## 已知限制

1. **`Secure` cookie 不能用明文 http 送过去。** 中继的 `dsh_pair` 带 `Secure`；手机 → 中继这一段如果是 `https://`（中继本身就是 https，正常情况都满足），代理拿着 cookie 发请求没问题。但如果你的 `bridgeUrl` 指向一个 http 桥，插件只是拿它当「取链接的信使」，不拿它传 cookie，所以照样可用。
2. **中继掉线要重新配对。** 令牌 600 秒过期、会话 cookie 一年；代理在收到上游 401 时会**自动重铸一次再重试**，所以一般无感。若中继换域名（`*.trycloudflare.com` 就是这样），要在 `/embed/setup` 里改 `bridgeUrl`。
3. **`/embed` 不接管键盘快捷键**：DSHA 的返回手势会直接退出这个页面（顶层导航回对话列表），这是 WebView 的正常行为。
4. **只支持 `http://127.0.0.1`**：DSHA 的预览策略只认回环明文。别把代理绑到 `0.0.0.0`，也没必要。
5. **中继不转发的部分插件静态资源会 403**：中继只放行 `/api`、`/assets`、`/plugins/??…` 目录批量加载和 `/pair-app`；个别插件用绝对路径挂的自己的静态文件（实测 `dsh-whale/widget.js`、`dsh-pet/pet.js`、`/plugins/<插件>/state`）会 403。它们都是可选挂件，界面照常可用，控制台里会留几条 403。
6. **iframe 里的页面禁止混合内容**（`MIXED_CONTENT_NEVER_ALLOW`）：中继页面上的跨站资源只有一条 https 的 `.webmcp/bridge.js`，被同源策略挡掉，无害。

## 与另外两个插件的关系

| 插件 | 装在哪 | 干什么 |
|---|---|---|
| `dsh-desktop-link` | 手机 | 侧栏按钮 + `/desktop-link/settings`；把手机送到电脑版门口（跳浏览器） |
| `dsh-desktop-embed` | 手机 | 侧栏按钮 + `/embed`；把电脑版界面嵌在 DSHA 里（不跳浏览器） |
| `dsh-mobile-boost` | 电脑 | 让电脑版界面在窄屏触摸下真的能用 |

装 `dsh-desktop-embed` 之后，仍然建议在**电脑** profile 里装 `dsh-mobile-boost`：嵌入的界面是电脑版页面，窄屏适配由它负责。

## License

MIT © 2026 lzlrt
