# 两个「桌面版」插件，各管一件事

名字很像，职责分开。**先看这一页再装，装错不会坏，但会看到两个按钮。**

| | `dsh-desktop-link` | `dsh-desktop-embed` |
|---|---|---|
| 侧栏文案 | **桌面版 · 新窗口** | **桌面版 · 嵌在这里** |
| 点下去 | 交给系统浏览器（Chrome / 夸克 / 微信） | **留在 DSHA 里**，iframe 内嵌 |
| DSHA 的壳还在不在 | 不在了，等于用浏览器 | 还在，侧栏 / 返回都可用 |
| 地址从哪来 | 中继 `https://…dsh-market.com`，每次点会铸一次性配对码 | 自己起一个回环代理（默认 `127.0.0.1:8799`），由它去连中继 |
| 需要什么前置 | 桌面 `dsh web` 在跑 + 手机已配对 | 桌面 `bridge.py` 在跑（提供铸码）+ 填 `bridgeUrl` / `bridgeKey` |
| 状态文件 | `~/.dsh/desktop-url.txt`（第一行长期地址，第二行点按钮打开的地址） | `$DSH_HOME/dsh-embed.json`（bridgeUrl / bridgeKey / proxyPort） |
| 门禁 | 页面本身要求「已配对的浏览器」 | 自己发的 `dsh_embed` cookie |
| 什么时候选它 | 只想在手机上遥控一下，用完就关 | 想把手机当第二块屏，DSHA 常驻 |
| 版本 | `1.4.0` | `1.3.0` |

## 只有一件东西会碰配对码

`dsh-desktop-link` 每次点击都会向桌面 `/api/pair/issue` 要一枚新码，**每铸一次就在桌面登记一个设备**。`remote-web-ui` 的 `maxDevices` 默认是 **4**，铸满会把正在用的会话挤出去（表现为「配对已失效」）。

`dsh-desktop-embed` 不铸新码：它用你填的 `bridgeUrl` 让 `bridge.py` 去铸，然后**把 grant 存在服务器侧复用**（`lan-grant.json`，30 天），只有真失效才重铸。所以长期用建议用 embed。

## 另外两件不是插件的东西（电脑上跑的脚本）

| | `bridge.py` | `lan_app.py` |
|---|---|---|
| 端口 | `0.0.0.0:8791` | `0.0.0.0:8792` |
| 干什么 | 铸配对链接、早期跳板、发插件 tgz | 局域网直连桌面版，**完全绕开 Cloudflare** |
| 门禁 | `X-Pair-Key` 头或 `?k=<secret>` | `/app?k=<secret>` 换 `dsh_lan` cookie |
| 谁在用它 | `dsh-desktop-embed`（必装）、`dsh-desktop-link`（可选中转） | 只在同 Wi-Fi 下用；公网走不通时的备胎 |

密钥都是 `Z:\dsh\dsha-pair\bridge-secret.txt` 里那串 64 位 hex。

## 怎么只留一个

三件事状态互不共享，删哪个都不影响另一个。

**手机上（DSHA）** —— 只留嵌在这里的那个：

1. 插件页 → 找到 `dsh-desktop-link` → 卸载（或停用）
2. 侧栏就只剩「桌面版 · 嵌在这里」

**电脑上** —— 想停掉早期跳板：

```
# 只停 bridge（embed 也要它铸码，停了 embed 就没法开）
# 所以一般别停；要停就两个一起换成本地 lan_app 方案
```

**想两个都留、只是不想看见某个按钮**：把对应插件卸了再装回去最省事——没有隐藏开关，这是刻意的（少一个开关就少一处状态能不同步）。

## 出问题时看哪

```
python Z:\dsh\dsha-pair\remote_plugins.py     # 四件东西的现状：装了没、端口在跑没、状态文件在哪
curl http://127.0.0.1:8792/api/lan-app/status # 局域网代理：grant 有没有、失败几次
curl http://127.0.0.1:8799/api/dsh-embed/status # 内嵌代理（在手机上跑，不是电脑）
```

⚠ 排查**绝不要**用 `/api/pair/issue` 或 `/pair-accept` 探活——那两个会登记新设备，把正在用的会话挤掉。只读 `/api/pair/status`、`/health`、状态码就够。
