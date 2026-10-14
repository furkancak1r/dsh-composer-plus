// DSH browser half: a "Mobile connect" button at the sidebar foot (beside Settings) that opens the
// Tether admin page (pairing QR, devices, Tailscale status) in a popover. Plain JS, no build step.
window.__ModuleLoader__.load({
  id: 'dsh-mobile-bridge',
  factory: (require) => {
    const module = { exports: {} }
    Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const prim = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const ADMIN = 'http://127.0.0.1:19391/'
    const NS = 'dsh-mobile'
    const en = { label: 'Mobile connect', title: 'Mobile connect · Tether', open: 'Open in browser', down: 'Gateway is not running. Restart DeepSeek Harness.' }
    const zh = { label: '手机连接', title: '手机连接 · Tether', open: '在浏览器中打开', down: '网关未运行，请重启 DeepSeek Harness。' }

    const css = `
.dshm-layer{flex:none;align-items:center;width:100%;height:42px;margin:8px 0 0;display:flex;position:relative}
.dshm-layer.dshm-rail{width:36px;height:36px;margin:0}
.dshm-badge{width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;margin:0 -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}
.dshm-badge:hover,.dshm-badge[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dshm-rail .dshm-badge{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0}
.dshm-panel{isolation:isolate;z-index:30;width:400px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);box-shadow:var(--dsw-elevation-prominent);border-radius:12px;flex-direction:column;display:flex;position:fixed;overflow:hidden}
.dshm-panel:before{z-index:-1;border-radius:inherit;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);content:"";pointer-events:none;position:absolute;inset:0}
.dshm-head{min-height:36px;padding:8px 12px 4px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.dshm-title{font-size:14px;font-weight:500}
.dshm-head a{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshm-frame{flex:none;width:100%;border:0;background:transparent}
.dshm-down{padding:0 12px 12px;font-size:13px;color:var(--dsw-alias-state-warn-label)}`
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="dsh-mobile-bridge"]')) {
      const tag = document.createElement('style'); tag.dataset.pluginCss = 'dsh-mobile-bridge'; tag.textContent = css; document.head.appendChild(tag)
    }

    const Phone = ({ size }) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true },
      h('rect', { x: 6.5, y: 2.5, width: 11, height: 19, rx: 2.5 }), h('path', { d: 'M10.5 18.5h3' }))

    function MobileConnect({ wide, t }) {
      const [open, setOpen] = React.useState(false)
      const [down, setDown] = React.useState(false)
      const [anchor, setAnchor] = React.useState()
      const [frameH, setFrameH] = React.useState(300)
      const rootRef = React.useRef(null), frameRef = React.useRef(null)
      // The admin page posts its content height; size the iframe to it so the popover never scrolls.
      React.useEffect(() => {
        if (!open) return
        const on = e => { if (e.source === frameRef.current?.contentWindow && e.data?.type === 'dshm-height') setFrameH(Math.min(Number(e.data.h) || 300, 2000)) }
        window.addEventListener('message', on)
        return () => window.removeEventListener('message', on)
      }, [open])
      React.useLayoutEffect(() => {
        if (!open) return
        const place = () => { const r = rootRef.current?.getBoundingClientRect(); if (r) setAnchor({ left: r.left, bottom: window.innerHeight - r.top + 8 }) }
        place(); window.addEventListener('resize', place)
        return () => window.removeEventListener('resize', place)
      }, [open])
      // An iframe never reports a refused connection, so probe the admin page once per open (no-cors: we only need reachability).
      React.useEffect(() => {
        if (!open) return
        let live = true
        fetch(ADMIN + 'state', { mode: 'no-cors', cache: 'no-store' }).then(() => live && setDown(false), () => live && setDown(true))
        return () => { live = false }
      }, [open])
      prim.useDismissOnOutsidePointer?.(rootRef, open, setOpen)
      return h('div', { ref: rootRef, className: 'dshm-layer' + (wide ? '' : ' dshm-rail') },
        open && h('section', { className: 'dshm-panel', role: 'dialog', 'aria-label': t('title'), style: anchor },
          h('div', { className: 'dshm-head' }, h('span', { className: 'dshm-title' }, t('title')),
            h('a', { href: ADMIN, target: '_blank', rel: 'noopener' }, t('open'))),
          down ? h('p', { className: 'dshm-down' }, t('down'))
            : h('iframe', { ref: frameRef, className: 'dshm-frame', src: ADMIN + '?embed=1', title: t('title'), style: { height: frameH } })),
        h('button', { type: 'button', className: 'dshm-badge', 'aria-label': t('label'), 'aria-expanded': open, onClick: () => setOpen(v => !v) },
          h(Phone, { size: wide ? 16 : 18 }), wide && h('span', null, t('label'))))
    }

    module.exports.inject = ['slots', 'locale']
    module.exports.apply = (ctx) => {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-mobile: dictionaries')
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'mobile-connect', locale: NS }, MobileConnect))
    }
    return module.exports
  },
})
