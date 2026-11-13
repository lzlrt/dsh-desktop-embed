window.__ModuleLoader__.load({
  id: 'dsh-desktop-embed',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-embed'
    /** 同源页面，宿主半区提供。顶层导航仍在 127.0.0.1 上，DSHA 不会把它交给浏览器。 */
    const EMBED_PATH = '/embed'

    const zh = {
      'action': '桌面版（嵌在这里）',
      'action.short': '桌面版',
      'hint': '在 DSHA 里打开电脑版界面，不跳浏览器',
      'crash.fallback': '内嵌按钮出错了，界面其余部分不受影响。也可以直接在地址栏打开 /embed。',
    }
    const en = {
      'action': 'Desktop DSH (embedded)',
      'action.short': 'Desktop',
      'hint': 'Open the desktop UI inside DSHA, not in the browser',
      'crash.fallback': 'The embed button failed; the rest of the UI is fine. You can also open /embed directly.',
    }

    /** 一台显示器 + 里面一个内嵌框：和 dsh-desktop-link 的图标区分开。 */
    function Mark() {
      return h('svg', {
        viewBox: '0 0 64 64', width: 18, height: 18, 'aria-hidden': true, focusable: false,
        style: { display: 'block', flex: 'none' },
      },
      h('rect', {
        x: 7, y: 9, width: 50, height: 32, rx: 5,
        fill: 'none', stroke: 'currentColor', strokeWidth: 4,
      }),
      h('rect', {
        x: 17, y: 18, width: 30, height: 14, rx: 2.5,
        fill: 'none', stroke: 'currentColor', strokeWidth: 3, strokeDasharray: '5 4',
      }),
      h('path', {
        d: 'M26 55h12M32 42v13', fill: 'none', stroke: 'currentColor',
        strokeWidth: 4, strokeLinecap: 'round',
      }))
    }

    /**
     * 把子树包进 error boundary。
     *
     * 侧栏是每次渲染都要跑的公共路径，这里任何一次抛错都会把整页带下去
     * （DSHA 上表现为只剩基础界面）。兜住它，最坏情况只是少一个按钮。
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        try {
          console.error('dsh-desktop-embed: render failed', error)
        } catch {}
      }

      render() {
        if (this.state.failed) {
          const t = this.props.t || ((key) => zh[key] || en[key] || key)
          return h('span', {
            style: { fontSize: 12, opacity: .7, padding: '0 6px' },
            title: t('crash.fallback'),
          }, t('crash.fallback'))
        }
        return this.props.children
      }
    }

    const baseButtonStyle = (wide) => ({
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: wide ? 'flex-start' : 'center',
      flex: 'none',
      height: 28,
      minWidth: 28,
      padding: wide ? '0 8px' : 0,
      boxSizing: 'border-box',
      borderRadius: 'var(--dsw-radius-sm, 6px)',
      color: 'var(--dsw-alias-label-secondary)',
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      fontSize: 13,
      fontFamily: 'inherit',
      textDecoration: 'none',
      whiteSpace: 'nowrap',
    })

    const hoverIn = (e) => {
      e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))'
    }
    const hoverOut = (e) => { e.currentTarget.style.background = 'transparent' }

    function EmbedButton(props) {
      const wide = props.wide !== false
      const t = props.t || ((key) => zh[key] || en[key] || key)

      const onClick = (event) => {
        // 同源、同服务：DSHA 的 shouldOverrideUrlLoading 只在顶层离开本机服务时
        // 才调 openExternal，所以这一次跳转留在 WebView 里。
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        window.location.assign(EMBED_PATH)
      }

      return h(Boundary, { t }, h('a', {
        href: EMBED_PATH,
        style: baseButtonStyle(wide),
        title: t('hint'),
        'aria-label': t('action'),
        onClick,
        onMouseEnter: hoverIn,
        onMouseLeave: hoverOut,
      },
      h(Mark),
      wide
        ? h('span', {
          style: { marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 13 },
        }, t('action.short'))
        : null))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const offZh = ctx.locale.register(NS, 'zh', zh)
          const offEn = ctx.locale.register(NS, 'en', en)
          return () => { offZh(); offEn() }
        }, 'dsh-desktop-embed: dictionaries')

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-desktop-embed',
          order: 12,
          label: () => ctx.locale.bind(NS)('action'),
          locale: NS,
        }, EmbedButton))
      },
    }
  },
})
