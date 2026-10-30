/**
 * dsh小助手（dsh-xiaozhushou）· 客户端半（Client）
 *
 * M0 骨架：三块界面都注册上，数据来自宿主 4 条路由（同一 origin，直接 fetch）。
 *   1) sidebar.panellist —— 侧栏图标「dsh小助手」
 *   2) main（keyed: steward）—— 整页看板
 *   3) shell.overlay —— 鲸鱼娘浮层（收起只剩形象，点开是浮窗卡片）
 *
 * 纪律（官方插件规范）：
 *   - 工厂无副作用；定时器在 apply 里用 ctx.effect 注册并返回清理；
 *   - 不替换 app root、不向 body 追加应用、不读别的插件 DOM；
 *   - 样式随组件渲染，卸载即消失；一块坏了只坏一块（ErrorBoundary）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-xiaozhushou',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/api/dsh-xiaozhushou'
    // 换图片时只改这个版本号，浏览器就不会吃旧缓存（不用重启）
    const ASSET_V = 'r20261028b'
    let workspaceNavigation = null
    const PET_HIDDEN_KEY = 'steward-pet-hidden'
    const PET_VIS_EVENT = 'steward-pet-visibility'
    const BLINK_DEMO_KEY = 'steward-blink-demo'
    const BLINK_MS_KEY = 'steward-blink-ms'
    const BLINK_EVENT = 'steward-blink-change'

    function readBlinkDemo() {
      try {
        return window.localStorage.getItem(BLINK_DEMO_KEY) === '1'
      } catch {
        return false
      }
    }

    function readBlinkMs() {
      try {
        const value = Number(window.localStorage.getItem(BLINK_MS_KEY))
            return Number.isFinite(value) && value >= 200 ? value : 1300
      } catch {
        return 1300
      }
    }

    function writeBlink(demo, ms) {
      try {
        window.localStorage.setItem(BLINK_DEMO_KEY, demo ? '1' : '0')
        if (ms) window.localStorage.setItem(BLINK_MS_KEY, String(ms))
        if (typeof window.dispatchEvent === 'function') window.dispatchEvent(new window.CustomEvent(BLINK_EVENT))
      } catch {
        /* ignore */
      }
    }

    function readPetHidden() {
      try {
        return window.localStorage.getItem(PET_HIDDEN_KEY) === '1'
      } catch {
        return false
      }
    }

    function writePetHidden(hidden) {
      try {
        window.localStorage.setItem(PET_HIDDEN_KEY, hidden ? '1' : '0')
        if (typeof window.dispatchEvent === 'function') window.dispatchEvent(new window.CustomEvent(PET_VIS_EVENT))
      } catch {
        /* 存不了也不影响本次会话 */
      }
    }
    const PET_KEY = 'steward-pet-pos'
    const PANEL_KEY = 'steward'

    /* ── 样式（随组件渲染，卸载自动消失） ───────────────────── */
    const CSS = [
      '.ke{--bd:#e5e6eb;--t:#1f2329;--t2:#4e5969;--mu:#86909c;--bg:#fff;--soft:#f2f3f5;--brand:#4d6bfe;--red:#f53f3f;--warn:#ffb400;--ok:#00b42a;font-family:"Microsoft YaHei UI","Microsoft YaHei",sans-serif;color:var(--t)}',
      '.ke *{box-sizing:border-box}',
      '.ke-wrap{padding:8px 14px 10px 10px;font-size:13px;height:100%;overflow:hidden;display:flex;flex-direction:column;box-sizing:border-box}',
      '.ke-h1{font-size:16px;font-weight:700;margin:0 0 2px;flex:0 0 auto}',
      '.ke-sub{color:var(--mu);font-size:11px;margin-bottom:6px;flex:0 0 auto}',
      '.ke-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(520px,52%);gap:10px;align-items:stretch;flex:1 1 0;min-height:0;overflow:hidden}',
      '.ke-left2{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}',
      '.ke-left2-side{order:-1;margin-bottom:4px;flex:0 1 auto;max-height:45%;overflow-y:auto}',
      '.ke-left2-main{min-width:0;flex:1 1 0;min-height:240px;display:flex;flex-direction:column;overflow:hidden}',
      '.ke-left2-side{min-width:0}',
      '.ke-col{min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
      '.ke-blk{display:flex;align-items:baseline;gap:7px;margin:2px 0 7px}',
      '.ke-blk .h{font-size:12px;font-weight:700}.ke-blk .w{font-size:10px;color:var(--mu)}',
      '.ke-card{background:var(--bg);border:1px solid var(--bd);border-radius:10px;padding:7px 10px;margin-bottom:6px}',
      '.ke-card.hot{border-left:3px solid var(--red)}.ke-card.info{border-left:3px solid var(--brand)}',
      '.ke-four{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '.ke-q{background:var(--bg);border:1px solid var(--bd);border-radius:9px;padding:8px 11px}',
      '.ke-q .k{font-size:10px;color:var(--mu);margin-bottom:3px}.ke-q .v{font-size:11.5px;font-weight:600;line-height:1.45}',
      '.ke-kv{font-size:11px;line-height:1.62;color:var(--t2)}.ke-kv b{color:var(--t)}',
      '.ke-note{background:var(--soft);border-radius:8px;padding:5px 10px;font-size:10.5px;color:var(--t2);line-height:1.4;flex:0 0 auto}',
      '.ke-chat{background:var(--soft);border-radius:10px;padding:6px;margin:4px 0;display:flex;flex-direction:column;min-height:0;flex:1 1 0}',
      '.ke-left2-main .ke-chat{min-height:200px}',
      '.ke-left2-main .ke-chat-log{min-height:120px}',
      '.ke-chat-log{max-height:none;min-height:52px;flex:1 1 0;overflow-y:auto;display:flex;flex-direction:column;gap:4px;margin-bottom:0}',
      '.ke-chat-small .ke-chat-log{max-height:none;min-height:44px}',
      '.ke-chat-right .ke-chat-log{max-height:none}',
      '.ke-chat-small{margin-bottom:0;flex:1 1 0;min-height:0}',
      '.ke-chat{border:2px solid #b9c8ef;background:#f8faff;box-shadow:0 1px 3px rgba(31,35,41,.05)}',
      '.ke-task{margin-top:6px}',
      '.ke-panel{border:2px solid #b9c8ef;border-radius:10px;background:#fbfdff;padding:6px 8px;margin-bottom:6px;min-height:0}',
      '.ke-role-head{background:#edf3ff;border:2px solid #b9c8ef;border-bottom:none;border-radius:10px 10px 0 0;padding:3px 8px;margin:4px 0 0;align-items:center;flex-wrap:wrap;row-gap:1px;min-width:0;overflow:hidden;flex:0 0 auto}',
      '.ke-role-head .h{flex:0 0 auto}',
      '.ke-role-head .w{flex:1 1 160px;min-width:0;white-space:normal;overflow-wrap:anywhere;line-height:1.4}',
      '.ke-role-head + .ke-mini{overflow-wrap:anywhere}',
      '.ke-role-head + .ke-chat{border-top:none;border-radius:0 0 10px 10px;margin-top:0}',
      '.ke-role-frame{border:2px solid #b9c8ef;border-radius:12px;background:#f8faff;padding:6px;margin-bottom:4px;min-width:0;overflow:hidden;min-height:0;display:flex;flex-direction:column;flex:1 1 0}',
      '.ke-role-frame .ke-role-head{margin:-8px -8px 8px;border:none;border-bottom:2px solid #b9c8ef;border-radius:0;background:#edf3ff;padding:6px 10px}',
      '.ke-role-frame .ke-chat{border:1px solid #d7e2f7;border-radius:8px;margin:0}',
      '.ke-chat .ke-add input[type=text]{flex:1 1 0;min-width:0;height:30px;font-size:12px;border:1px solid #4d6bfe;border-radius:7px;padding:0 7px;background:#fff}',
      '.ke-chat .ke-add label{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#4e5969;white-space:nowrap;flex:0 0 auto}',
      '.ke-chat .ke-add input[type=checkbox]{width:14px;height:14px;margin:0;accent-color:#4d6bfe;flex:0 0 auto}',
      '.ke-chat .ke-add button{height:28px;padding:0 8px;font-size:11px;border-radius:6px;border:none;background:#4d6bfe;color:#fff;cursor:pointer;flex:0 0 auto;white-space:nowrap}',
      '.ke-chat .ke-add button:disabled{opacity:.5;cursor:not-allowed}',
      '.ke-scroll{overflow-y:auto}',
      '.ke-msg{font-size:12px;line-height:1.4;padding:4px 8px;border-radius:8px;max-width:92%;white-space:pre-wrap}',
      '.ke-msg.sys{background:#f2f3f5;color:#86909c;align-self:flex-start}',
      '.ke-msg.bot{background:#fff;border:1px solid #e5e6eb;color:#1d2129;align-self:flex-start}',
      '.ke-msg.me{background:#d6e7ff;color:#1f2329;align-self:flex-end;border:1px solid #b7d0f5}',
      '.ke-msg-row{display:flex;gap:4px;align-items:flex-start;margin:1px 0}',
      '.ke-msg-no{font-size:10px;color:#86909c;line-height:20px;min-width:16px;text-align:right;flex:0 0 16px}',
      '.ke-msg-col{display:flex;flex-direction:column;gap:4px;min-width:0;max-width:92%}',
      '.ke-msg-col .ke-msg{max-width:100%;box-shadow:0 1px 2px rgba(31,35,41,.05)}',
      '.ke-msg.bot,.ke-msg.sys{border:1px solid #e5e6eb}',
      '.ke-btn{border:1px solid #e5e6eb;background:#fff;border-radius:6px;padding:1px 8px;font-size:11px;line-height:16px;cursor:pointer;color:#4e5969}',
      '.ke-btn:hover{border-color:#c9cdd4;color:#1d2129}',
      '.ke-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.ke-mini{font-size:10.5px;color:var(--mu)}',
      '.ke-tag{display:inline-block;font-size:10px;line-height:17px;padding:0 7px;border:1px solid var(--bd);border-radius:999px;color:var(--t2)}',
      '.ke-err{background:#fff2f0;border:1px solid #ffd6d1;border-radius:8px;padding:8px 12px;font-size:11px;color:#b32b1f;line-height:1.55}',
      /* 鲸鱼娘浮层 */
      '.ke-pet{position:fixed;z-index:2147483000;right:18px;top:72px;width:84px;text-align:center;user-select:none;cursor:move;transition:width .16s ease}',
      '.ke-pet .art{display:block;margin:0 auto;filter:drop-shadow(0 4px 10px rgba(31,35,41,.22));transform-origin:50% 92%;animation:ke-breathe 3.6s ease-in-out infinite}',
      '.ke-pet .art svg{width:100%;height:100%;display:block}',
      '@keyframes ke-breathe{0%,100%{transform:translateY(0) scaleY(1)}50%{transform:translateY(-1.5px) scaleY(1.018)}}',
      '.ke-pet .art .eye{transform-origin:center;animation:ke-eyelid 5.2s steps(1,end) infinite}',
      '@keyframes ke-eyelid{0%,95%,100%{transform:scaleY(1)}95.4%,96.4%{transform:scaleY(.25)}}',
      '.ke-pet .art .tail{transform-origin:38% 22%;animation:ke-tail 3.2s ease-in-out infinite}',
      '@keyframes ke-tail{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(7deg)}}',
      // 设计要求：拖动时"被拎起来"；光标不要出现手指（用 move 四向箭头）
      '.ke-pet{margin:0;padding:0;background:transparent;border:none;box-shadow:none;backdrop-filter:none}',
      // 侧栏小鲸尾：缓慢摇一摇（22px 下幅度必须小，否则像抽搐）
      // 分层看板娘：眨眼（5.2s 一次，约 60ms）、干饭（碗抖动+米粒上飘）、摇尾
      '.pet-layer{position:relative;display:block}',
      '.pet-layer img{position:absolute;pointer-events:none;user-select:none}',
      '.pet-layer .j-eye-open{animation:j-eye-open 5.2s steps(1,end) infinite}',
      '.pet-layer .j-eye-closed{opacity:0;animation:j-eye-closed 5.2s steps(1,end) infinite}',
      '@keyframes j-eye-open{0%,94.6%,96.6%,100%{opacity:1}94.8%,96.4%{opacity:0}}',
      '@keyframes j-eye-closed{0%,94.6%,96.6%,100%{opacity:0}94.8%,96.4%{opacity:1}}',
      '.pet-layer .j-mouth-open{opacity:0}',
      '.pet-layer.eating .j-mouth-open{opacity:1}',
      '.pet-layer.eating .j-mouth-closed{opacity:0}',
      '.pet-layer .pet-tail{transform-origin:20% 20%;animation:j-tail 3.2s ease-in-out infinite}',
      '@keyframes j-tail{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(8deg)}}',
      '.pet-layer .pet-meal{animation:j-meal 1.6s ease-in-out infinite}',
      '@keyframes j-meal{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}',
      '.pet-layer .j-rice{position:absolute;bottom:46%;width:2px;height:2px;border-radius:50%;background:#fff;box-shadow:0 0 0 .6px rgba(0,0,0,.12);opacity:0;animation:j-rice 1.6s linear infinite}',
      '@keyframes j-rice{0%{opacity:0;transform:translate(0,0)}20%{opacity:1}100%{opacity:0;transform:translate(-6px,-14px)}}',
      '@media (prefers-reduced-motion: reduce){.pet-layer img,.pet-layer .pet-tail,.pet-layer .pet-meal,.pet-layer .j-rice{animation:none}}',
      '.ke-ico{display:block;transform-origin:50% 55%;animation:ke-ico-sway 3.2s ease-in-out infinite}',
      '@keyframes ke-ico-sway{0%,100%{transform:rotate(-7deg)}50%{transform:rotate(7deg)}}',
      '@media (prefers-reduced-motion: reduce){.ke-ico{animation:none}}',
      '.ke-pet.mode-idle,.ke-pet.mode-hover,.ke-pet.mode-grabbed,.ke-pet.mode-dropped{cursor:move}',
      '.ke-pet.mode-grabbed .art{animation:none;transform:translateY(-7px) scale(1.03);transition:transform .12s ease-out}',
      '.ke-pet.mode-grabbed .art .tail{animation:none;transform:rotate(38deg);transform-origin:38% 22%;transition:transform .12s ease-out}',
      '.ke-pet.mode-grabbed .art .eye{animation:none;transform:scaleY(1.12)}',
      '.ke-pet.mode-grabbed .sh{opacity:.45;transform:scaleX(.8)}',
      '.ke-pet.mode-dropped .art{animation:ke-drop 240ms ease-out}',
      '@keyframes ke-drop{0%{transform:translateY(-6px) scale(1.03)}55%{transform:translateY(0) scaleY(.94) scaleX(1.04)}100%{transform:translateY(0) scaleY(1) scaleX(1)}}',
      '.ke-pet.mode-hover .art{animation-duration:2.8s}',
      '.ke-pet.mode-hover .art .tail{animation-duration:2.2s}',
      // 图片皮肤：呼吸用整体 scale（没有分层眼睛，所以只做整体动效）
      '.ke-pet .art[src]{object-fit:contain;transform-origin:50% 92%;animation:ke-breathe-img 3.6s ease-in-out infinite}',
      '@keyframes ke-breathe-img{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-1.2px) scale(1.02)}}',
      '.ke-pet.mode-grabbed .art[src]{animation:none;transform:translateY(-7px) scale(1.04) rotate(-2deg)}',
      '.ke-pet.mode-sleepy .art[src]{animation-duration:5.2s;filter:saturate(.85) brightness(.97)}',
      // 困：静默时段自动出 zzz（三颗，错开飘起）
      '.ke-pet .zzz{position:absolute;right:2px;top:-2px;font-size:11px;font-weight:700;color:#4d6bfe;opacity:0;pointer-events:none}',
      '.ke-pet.mode-sleepy .zzz{animation:ke-zzz 3s ease-out infinite}',
      '.ke-pet.mode-sleepy .zzz:nth-child(2){animation-delay:1s}',
      '.ke-pet.mode-sleepy .zzz:nth-child(3){animation-delay:2s}',
      '@keyframes ke-zzz{0%{opacity:0;transform:translate(0,4px) scale(.8)}30%{opacity:.9}100%{opacity:0;transform:translate(6px,-16px) scale(1.25)}}',
      '.ke-pet.mode-sleepy .art{animation-duration:5.2s}',
      '.ke-pet.mode-sleepy .art .eye{animation:none;transform:scaleY(.18)}',
      '@media (prefers-reduced-motion: reduce){.ke-pet .art,.ke-pet .art .eye,.ke-pet .art .tail{animation:none}}',
      '.ke-pet .badge{position:absolute;right:2px;top:0;min-width:17px;height:17px;border-radius:9px;background:var(--red);color:#fff;font-size:10px;line-height:17px;text-align:center;box-shadow:0 0 0 2px #fff}',
      '.ke-pet .dot{position:absolute;right:8px;bottom:6px;width:9px;height:9px;border-radius:50%;box-shadow:0 0 0 3px rgba(255,255,255,.9)}',
      '.ke-pet .ke-lamp{position:absolute;right:5px;bottom:3px;width:11px;height:11px;min-width:11px;min-height:11px;aspect-ratio:1/1;box-sizing:border-box;border-radius:9999px;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,.98),0 1px 3px rgba(0,0,0,.18),inset 0 -1px 2px rgba(0,0,0,.14),inset 0 1px 1px rgba(255,255,255,.65)}',
      '.ke-pet .ke-lamp::after{content:"";position:absolute;left:2px;top:2px;width:3px;height:2px;border-radius:9999px;background:rgba(255,255,255,.65);transform:rotate(-25deg);pointer-events:none}',
      '.ke-blink{animation-name:ke-lamp-blink;animation-iteration-count:infinite;animation-timing-function:steps(1,end)}',
      '@keyframes ke-lamp-blink{0%,72%{opacity:1}73%,100%{opacity:0}}',
      '.ke-lv{display:inline-flex;align-items:center;gap:3px;font-size:9.5px;padding:0 5px;border-radius:8px;border:1px solid #e5e6eb;color:#4e5969}',
      '.ke-lv i{width:6px;height:6px;border-radius:50%;display:block}',
      '.ke-lv.l5{color:#b32b1f;border-color:#ffc9c9;background:#ffece8}',
      '.ke-lv.l4{color:#b32b1f;border-color:#ffd6d1;background:#fff5f3}',
      '.ke-lv.l3{color:#a86a00;border-color:#ffe0a3;background:#fff7e8}',
      '.ke-lv.l2{color:#c25a00;border-color:#ffd2ad;background:#fff4ec}',
      '.ke-lv.l1{color:#2b55c8;border-color:#c9d8ff;background:#eef3ff}',
      '.ke-add{display:flex;gap:4px;align-items:center;margin:4px 0 0;flex-wrap:nowrap;flex:0 0 auto;min-width:0}',
      '.ke-add input[type=text]{flex:1;min-width:160px;border:1px solid #e5e6eb;border-radius:7px;padding:5px 8px;font:inherit;font-size:11.5px}',
      '.ke-add label{font-size:10.5px;color:#4e5969;display:flex;align-items:center;gap:3px;cursor:pointer}',
      '.ke-add button{border:1px solid #b9c8ff;background:#eef3ff;color:#2b55c8;border-radius:7px;padding:5px 10px;font-size:11px;cursor:pointer}',
      '.ke-add button:disabled{opacity:.5;cursor:default}',
      '.ke-add .msg{font-size:10.5px;color:#86909c}',
      '.ke-pet.expanded{width:340px;cursor:default}',
      '.ke-pet .card{display:none;text-align:left;background:#fff;border:1px solid var(--bd);border-radius:12px;box-shadow:0 14px 36px rgba(31,35,41,.20);padding:10px 12px}',
      '.ke-pet.expanded .card{display:block}',
      '.ke-pet .hd{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:700;cursor:move;user-select:none;background:#f2f3f5;border-bottom:1px solid #e5e6eb;border-radius:11px 11px 0 0;padding:8px 11px;margin:-10px -12px 9px}',
      '.ke-pet .hd:active{cursor:move}',
      '.ke-pet .hd .x{margin-left:6px;width:18px;height:18px;line-height:16px;text-align:center;border:1px solid #e5e6eb;border-radius:5px;color:#4e5969;background:#fff;cursor:pointer;font-weight:400}',
      '.ke-pet .hd .x:hover{border-color:#4d6bfe;color:#4d6bfe}',
      '.ke-pet .hd .t{margin-left:auto;font-size:10px;color:var(--mu);font-weight:400}',
      '.ke-pet .row{display:flex;gap:8px;font-size:11px;padding:5px 0;border-bottom:1px dashed #f0f2f5;color:var(--t2)}',
      '.ke-pet .row:last-child{border-bottom:0}.ke-pet .row .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ke-pet .row .due{font-size:10px;color:var(--mu)}',
      '.ke-pet .ft{margin-top:8px;padding-top:7px;border-top:1px solid var(--bd);display:flex;align-items:center;gap:6px;font-size:10px;color:var(--mu)}',
      '.ke-pet .ft .go{margin-left:auto;color:var(--brand);font-weight:600}',
    ].join('\n')

    function Style() {
      return h('style', { dangerouslySetInnerHTML: { __html: CSS } })
    }

    /* ── 鲸鱼娘（自绘占位·幼儿形态；最终形象按 13 R-01 处理）
     * 自绘 SVG，零第三方素材；呼吸/眨眼/尾摆的动画类挂在内部元素上。
     * 换成 spritesheet 时只替换这个常量即可。
     * ─────────────────────────────────────────────────────── */
    const WHALE_SVG = [
      '<svg viewBox="0 0 100 112" aria-hidden="true">',
      '<defs>',
      '<linearGradient id="ke-hair" x1="0" y1="0" x2="0" y2="1">',
      '<stop offset="0" stop-color="#9ec9ff"/><stop offset="1" stop-color="#5b8ef0"/></linearGradient>',
      '<linearGradient id="ke-dress" x1="0" y1="0" x2="0" y2="1">',
      '<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dbe7ff"/></linearGradient>',
      '</defs>',
      // 地面阴影
      '<ellipse class="sh" cx="50" cy="105" rx="26" ry="5" fill="#3d4a63" opacity="0.10"/>',
      // 后发（大头，幼儿比例）
      '<path d="M50 10c20 0 30 13 30 29 0 10-3 18-6 24-2 5-7 7-10 5-2-1-3-4-2-8 1-6-3-11-12-11s-13 5-12 11c1 4 0 7-2 8-3 2-8 0-10-5-3-6-6-14-6-24C20 23 30 10 50 10z" fill="url(#ke-hair)"/>',
      // 左右侧发（鳍形）
      '<path d="M20 38c-4 9-4 19-1 28 1 4 6 5 8 1 2-4 0-8-1-13-1-6 0-12 2-17z" fill="#5b8ef0"/>',
      '<path d="M80 38c4 9 4 19 1 28-1 4-6 5-8 1-2-4 0-8 1-13 1-6 0-12-2-17z" fill="#5b8ef0"/>',
      // 脸
      '<ellipse cx="50" cy="47" rx="22" ry="21" fill="#fff5ee"/>',
      // 刘海
      '<path d="M28 36c5-13 13-18 22-18s17 5 22 18c-6-5-11-7-15-7-3 5-7 7-11 7-6 0-10-3-18-0z" fill="url(#ke-hair)"/>',
      // 眼睛（动画类 eye）
      '<g class="eye"><ellipse cx="41" cy="49" rx="3.9" ry="4.9" fill="#26303f"/>',
      '<ellipse cx="59" cy="49" rx="3.9" ry="4.9" fill="#26303f"/>',
      '<circle cx="42.4" cy="47.3" r="1.4" fill="#fff"/><circle cx="60.4" cy="47.3" r="1.4" fill="#fff"/>',
      '<circle cx="39.8" cy="51.2" r="0.8" fill="#8fb7ff"/><circle cx="57.8" cy="51.2" r="0.8" fill="#8fb7ff"/></g>',
      // 腮红
      '<ellipse cx="32.5" cy="55" rx="4.2" ry="2.4" fill="#ffc3c9" opacity="0.9"/>',
      '<ellipse cx="67.5" cy="55" rx="4.2" ry="2.4" fill="#ffc3c9" opacity="0.9"/>',
      // 小嘴（ω 形）
      '<path d="M46.6 58.2c1.2 1.7 2.3 1.7 3.4 0 1.1 1.7 2.2 1.7 3.4 0" stroke="#c0766a" stroke-width="1.3" stroke-linecap="round" fill="none"/>',
      // 小身体（白裙 + 蓝领）
      '<path d="M37 70h26c1 7 5 11 5 18 0 9-9 14-18 14s-18-5-18-14c0-7 4-11 5-18z" fill="url(#ke-dress)" stroke="#ccd9f2" stroke-width="1"/>',
      '<path d="M43 70c2 4 12 4 14 0" stroke="#b9c8ff" stroke-width="2" fill="none" stroke-linecap="round"/>',
      // 小手
      '<ellipse cx="31" cy="88" rx="4.4" ry="5" fill="#fff5ee" stroke="#e2d3c8" stroke-width="0.8"/>',
      '<ellipse cx="69" cy="88" rx="4.4" ry="5" fill="#fff5ee" stroke="#e2d3c8" stroke-width="0.8"/>',
      // 鲸尾（动画类 tail）
      '<path class="tail" d="M71 92c7-1.5 10 3 10.6 6 .3 1.6-1.3 2.2-2.5 1.2-1.8-1.4-3.6-2.6-5.6-3 1.6 2 2 4.2 1.6 6.2-.4 1.5-2 1.5-2.6-.1-.6-2.4-1.7-4.5-3.3-5.9z" fill="#4d6bfe" opacity="0.92"/>',
      // 头顶小水花
      '<circle cx="50" cy="7" r="2.4" fill="#9ec9ff" opacity="0.85"/>',
      '<circle cx="44" cy="10" r="1.6" fill="#9ec9ff" opacity="0.7"/>',
      '<circle cx="56" cy="10" r="1.6" fill="#9ec9ff" opacity="0.7"/>',
      '</svg>',
    ].join('')

    /* 分层拼装：头 / 身 / 眼(睁闭) / 嘴(闭张) / 尾 / 手拿碗筷 + 米粒
     * 设计决定（2026-10-26）：用豆包生成的分层素材拼一个"会眨眼、会干饭、会摇尾"的看板娘。
     * 素材为维护者自产（豆包生成），登记见 THIRD_PARTY_NOTICES.md。 */
    const MEAL_KEY = 'steward-pet-meal'

    function isMealTime(now) {
      const hour = (now || new Date()).getHours()
      return (hour >= 11 && hour < 13) || (hour >= 17 && hour < 19)
    }

    function readMealForce() {
      try {
        return window.localStorage.getItem(MEAL_KEY) === '1'
      } catch {
        return false
      }
    }

    function Skin(props) {
      const size = props && typeof props.size === 'number' ? props.size : 72
      const [failed, setFailed] = React.useState(false)
      if (failed) return h(WhaleGirl, { size })
      return h('img', {
        className: 'art',
        src: API + '/asset/pet?v=' + ASSET_V,
        alt: '',
        draggable: false,
        style: { width: size + 'px', height: 'auto' },
        onError: () => setFailed(true),
      })
    }

    function WhaleGirl(props) {
      const size = props && typeof props.size === 'number' ? props.size : 72
      const width = size
      const height = Math.round((size * 112) / 100)
      return h('span', {
        className: 'art',
        style: { width: width + 'px', height: height + 'px' },
        dangerouslySetInnerHTML: { __html: WHALE_SVG },
      })
    }
    /* ── 错误边界：一块坏了只坏一块（R-UI-09） ─────────────── */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'ke' },
            Style(),
            h('div', { className: 'ke-err' },
              '这块界面出了点错（不影响 DSH 其它功能）：',
              h('br'),
              String(this.state.error.message || this.state.error).slice(0, 200),
              h('br'),
              '可以先关掉面板再打开；还在的话把这句话告诉 CEO。'),
          )
        }
        return this.props.children
      }
    }

    /* ── 取数（同一 origin，直接 fetch；失败就显示上次/占位） ── */
    function useJson(path, intervalMs) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        let timer = null
        async function pull() {
          try {
            const res = await fetch(path, { headers: { accept: 'application/json' } })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            const json = await res.json()
            if (alive) {
              setData(json)
              setError(null)
            }
          } catch (e) {
            if (alive) setError(String(e && e.message ? e.message : e))
          }
        }
        pull()
        if (intervalMs > 0) timer = setInterval(pull, intervalMs)
        return () => {
          alive = false
          if (timer) clearInterval(timer)
        }
      }, [path, intervalMs, tick])
      return { data, error, reload: () => setTick((v) => v + 1) }
    }

    /* ── 1. 侧栏图标 ────────────────────────────────────────── */
    /* 侧栏缩略图：22~24px 下细节全糊，所以用**鲸尾**（形状最认得出），加载失败回退自绘 SVG。 */
    function PanelIcon() {
      const [failed, setFailed] = React.useState(false)
      const size = 22
      return h('span', { title: 'dsh小助手', 'aria-label': 'dsh小助手', style: { display: 'inline-flex', alignItems: 'center' } },
        failed
          ? WhaleGirl({ size: 18 })
          : h('img', {
              src: API + '/asset/tail?v=' + ASSET_V,
              className: 'ke-ico',
              alt: '',
              draggable: false,
              style: { width: size + 'px', height: 'auto', display: 'block' },
              onError: () => setFailed(true),
            }))
    }

    /* 2026-10-26：看板聊天记录持久化（localStorage，每角色最近 20 条） */
    const CHAT_KEY = (role) => 'ke-chat-' + role
    function readChatLog(role) {
      try {
        const raw = window.localStorage.getItem(CHAT_KEY(role))
        if (!raw) return []
        const arr = JSON.parse(raw)
        return Array.isArray(arr) ? arr.slice(-20) : []
      } catch {
        return []
      }
    }
    // 看板是给人看的：编号只留给会话/操作，不在气泡和事项标题里露出来
    function displayText(value) {
      const text = String(value == null ? '' : value).replace(/(?:^|[\s（(【])[KT]-\d{3,}(?=$|[\s）)】,，。:：])/g, ' ').replace(/\s{2,}/g, ' ').trim()
      return text || String(value == null ? '' : value)
    }

    function writeChatLog(role, lines) {
      try {
        window.localStorage.setItem(CHAT_KEY(role), JSON.stringify((lines || []).slice(-20)))
      } catch {
        /* 存不下不影响 */
      }
    }

    /* ── 2. 整页看板 ────────────────────────────────────────── */
    function BoardPage() {
      const { data, error, reload } = useJson(API + '/board', 30_000)
      const [draft, setDraft] = React.useState('')
      // 用户定：界面只给"紧急""重要"两个框（可同时勾）；"最紧急/最重要"只认用户口述。
      const [urgent, setUrgent] = React.useState(false)
      const [important, setImportant] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      // 2026-10-26：看板中间做成"和秘书对话"的样子（回复在上、输入在下）
      const [chatLog, setChatLog] = React.useState(() => readChatLog('secretary'))
      // 聊天窗口自动滚到最新一条
      const secLogRef = React.useRef(null)
      const ceoLogRef = React.useRef(null)
      const histLogRef = React.useRef(null)
      const [ceoBusy, setCeoBusy] = React.useState(false)
      const [ceoLog, setCeoLog] = React.useState(() => readChatLog('ceo'))
      const [ceoDraft, setCeoDraft] = React.useState('')
      // 2026-10-26：修改按钮改内联编辑（window.prompt 在 Electron 里不生效）
      const [editId, setEditId] = React.useState('')
      const [editText, setEditText] = React.useState('')
      const [histLog, setHistLog] = React.useState(() => readChatLog('historian'))
      const [histDraft, setHistDraft] = React.useState('')

      async function setTaskStatus(id, status, assignee) {
        try {
          // D-20 ①：硬动作可带 assignee；不带就只改状态
          const payload = assignee ? { id, status, assignee } : { id, status }
          const res = await fetch(API + '/task/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
          const json = await res.json()
          if (json && json.ok) {
            const label = status === '进行中' ? '已接下 ' + id + '（进行中）' : status === '完成' ? '已完成 ' + id : '已更新 ' + id + '：' + status
            setMsg(label)
            setCeoLog((prev) => prev.concat([{ role: 'sys', text: label }]).slice(-10))
            if (typeof reload === 'function') reload()
          } else {
            setMsg('改任务状态失败：' + String((json && json.message) || '未知原因'))
          }
        } catch (e) {
          setMsg('改任务状态失败：' + String(e && e.message ? e.message : e))
        }
      }

      async function taskAction(id, action) {
        try {
          const res = await fetch(API + '/task/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action }) })
          const json = await res.json()
          if (json && json.ok) {
            const label = action === 'archive' ? '已归档 ' + id + '（交秘书收尾）' : '已存为记忆 ' + id + (json.memoryPath ? '：' + json.memoryPath : '')
            setMsg(label)
            setCeoLog((prev) => prev.concat([{ role: 'sys', text: label }]).slice(-10))
            if (typeof reload === 'function') reload()
          } else {
            setMsg(String((json && json.message) || '操作没成功'))
          }
        } catch (e) {
          setMsg('操作失败：' + String(e && e.message ? e.message : e))
        }
      }

      // 看板聊天窗不只显示本地临时消息：首次打开时同步绑定会话里的真实明文
      React.useEffect(() => {
        let alive = true
        async function syncHistory(role, setter) {
          try {
            const res = await fetch(API + '/role/history?role=' + role)
            const json = await res.json()
            if (!alive || !json || !json.ok || !Array.isArray(json.lines) || !json.lines.length) return
            const incoming = json.lines.map((line) => ({ role: line.role === 'me' ? 'me' : 'bot', text: line.text }))
            setter((prev) => {
              const seen = new Set()
              const merged = []
              for (const line of prev.concat(incoming)) {
                const key = line.role + '\u0000' + line.text
                if (seen.has(key)) continue
                seen.add(key)
                merged.push(line)
              }
              return merged.slice(-10)
            })
          } catch {}
        }
        syncHistory('secretary', setChatLog)
        syncHistory('ceo', setCeoLog)
        syncHistory('historian', setHistLog)
        return () => { alive = false }
      }, [])

      React.useEffect(() => {
        writeChatLog('secretary', chatLog)
      }, [chatLog])

      React.useEffect(() => {
        writeChatLog('ceo', ceoLog)
      }, [ceoLog])

      React.useEffect(() => {
        writeChatLog('historian', histLog)
      }, [histLog])

      // 派给 CEO 的任务已自动接下：首次出现在看板时在 CEO 聊天框播报一次
      React.useEffect(() => {
        try {
          const tasks = (data && data.tasks) || []
          const fresh = tasks.filter((task) => task.autoAccepted && !window.localStorage.getItem('ke-auto-' + task.id))
          if (!fresh.length) return
          setCeoLog((prev) => prev.concat(fresh.map((task) => ({ role: 'sys', text: '已自动接下 ' + task.id + '：' + task.title }))).slice(-20))
          for (const task of fresh) window.localStorage.setItem('ke-auto-' + task.id, '1')
        } catch {
          /* 播报失败不影响看板 */
        }
      }, [data])

      React.useEffect(() => {
        const el = secLogRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [chatLog, msg])

      React.useEffect(() => {
        const el = ceoLogRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [ceoLog])

      React.useEffect(() => {
        const el = histLogRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [histLog])
      const [petHidden, setPetHidden] = React.useState(readPetHidden())
      const [blinkDemo, setBlinkDemo] = React.useState(readBlinkDemo())
      const [blinkMs, setBlinkMs] = React.useState(readBlinkMs())
      // 2026-10-26 修 B-01：界面以前只有"记一条"，候选不显示、没有确认/划掉/完成，
      // 普通用户永远走不到"确认 → 到点提醒"这一步。这里补上最小闭环。
      const [dueDraft, setDueDraft] = React.useState({})
      const [todoAction, setTodoAction] = React.useState('')
      const [adjustDraft, setAdjustDraft] = React.useState({ urgency: 1, importance: 1 })
      const [todoBusy, setTodoBusy] = React.useState(false)

      async function runCommand(text) {
        if (busy) return
        setBusy(true)
        setMsg('')
        try {
          const res = await fetch(API + '/command', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
          })
          const json = await res.json()
          setMsg(json && json.ok ? '已执行：' + text : ((json && json.message) || '没执行成功'))
          if (json && json.ok && typeof reload === 'function') reload()
        } catch (e) {
          setMsg('没执行成功：' + String(e && e.message ? e.message : e))
        }
        setBusy(false)
      }

      function confirmItem(id) {
        const due = String(dueDraft[id] || '').trim()
        // 只把用户真的填了的日期带上（修 R-01 之后，不带日期不会清空原日期）
        runCommand('确认 ' + id + (due ? ' ' + due : ''))
      }


      const [refreshing, setRefreshing] = React.useState(false)
      async function refreshNow() {
        if (refreshing) return
        setRefreshing(true)
        try {
          await fetch(API + '/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          if (typeof reload === 'function') reload()
        } catch (e) {
          setMsg('刷新失败：' + String(e && e.message ? e.message : e))
        }
        setRefreshing(false)
      }

      async function handoffTo(role, question) {
        try {
          const res = await fetch(API + '/handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role, question }) })
          const json = await res.json()
          const note = json && json.ok
            ? (json.notified === false ? '任务已挂上，但 CEO 会话没接住：' + String(json.message || '') : '已转给 CEO：' + json.taskId)
            : ((json && json.message) || '没转成')
          if (role === 'historian') setHistLog((prev) => prev.concat([{ role: 'sys', text: note }]).slice(-6))
          else setChatLog((prev) => prev.concat([{ role: 'sys', text: note }]).slice(-20))
        } catch (e) {
          if (role === 'historian') setHistLog((prev) => prev.concat([{ role: 'sys', text: '转给 CEO 失败：' + String(e && e.message ? e.message : e) }]).slice(-6))
        }
      }

      function looksLikeHandoff(text) {
        return /(交给|转给|发给|让)\s*CEO|超出.{0,6}职责|建议.{0,4}找 CEO|要让 CEO/.test(String(text || ''))
      }

      function handoffButtons(role, line, idx) {
        if (!line || line.role !== 'bot' || line.cancelled) return null
        // 规则优先交给会话；只有会话明确拿不准/建议转交时才出现按钮
        if (!/(拿不准|不确定|待核对|要不要|该不该|建议|需要你定|转给 ?CEO|交给 ?CEO)/.test(String(line.text || ''))) return null
        const ask = line.q || ''
        const payload = (ask ? '用户问：' + ask + '\n' : '') + '角色回答：' + String(line.text || '')
        const rerender = () => { if (role === 'historian') setHistLog([...histLog]); else setChatLog([...chatLog]) }
        return h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
          h('button', {
            className: 'ke-btn',
            title: '把这次问答连同上文转给 CEO 处理',
            onClick: async () => { line.cancelled = true; await handoffTo(role, payload); rerender() },
          }, '转交CEO'),
          h('button', { className: 'ke-btn', onClick: () => { line.cancelled = true; rerender() } }, '取消'))
      }

      async function chatSecretary() {
        const text = draft.trim()
        if (!text || busy) return
        setChatLog((prev) => prev.concat([{ role: 'me', text }]).slice(-10))
        setDraft('')
        setBusy(true)
        try {
          const res = await fetch(API + '/secretary/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: text }) })
          const json = await res.json()
          // D-01：失败时把服务端的显式错误（会话不可用/卡在哪）原样显示，不假装答上来
          if (json && json.ok) setChatLog((prev) => prev.concat([{ role: 'bot', text: String(json.text || ''), q: text }]).slice(-10))
          else setChatLog((prev) => prev.concat([{ role: 'sys', text: '秘书没答上来：' + String((json && json.message) || '会话不可用') }]).slice(-10))
        } catch (e) {
          setChatLog((prev) => prev.concat([{ role: 'sys', text: '秘书没回：' + String(e && e.message ? e.message : e) }]).slice(-10))
        }
        setBusy(false)
      }

      async function addTodo() {
        const title = draft.trim()
        if (!title || busy) return
        setBusy(true)
        setMsg('')
        try {
          const res = await fetch(API + '/todo', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title, urgent, important }),
          })
          const json = await res.json()
          if (json && json.ok) {
            setDraft('')
            setUrgent(false)
            setImportant(false)
            setMsg('记下了：' + String((json.item && json.item.title) || '') + '（' + (json.priority ? json.priority.label : '已记录') + '）')
            if (typeof reload === 'function') reload()
          } else {
            setMsg((json && json.message) || '没记上')
          }
        } catch (e) {
          setMsg('没记上：' + String(e && e.message ? e.message : e))
        }
        setBusy(false)
      }

      async function askCeo() {
        if (ceoBusy) return
        setCeoBusy(true)
        try {
          const res = await fetch(API + '/ceo/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          const json = await res.json()
          const label = json && json.source === 'model' ? 'CEO（模型版）' : 'CEO（规则版）'
          setChatLog((prev) => prev.concat([{ role: 'bot', text: label + '：' + String((json && json.text) || '没答上来') }]).slice(-8))
        } catch (e) {
          setChatLog((prev) => prev.concat([{ role: 'sys', text: '问 CEO 失败：' + String(e && e.message ? e.message : e) }]).slice(-8))
        }
        setCeoBusy(false)
      }

      async function sendCeo() {
        const q = ceoDraft.trim()
        if (!q || ceoBusy) return
        setCeoLog((prev) => prev.concat([{ role: 'me', text: q }]).slice(-10))
        setCeoDraft('')
        setCeoBusy(true)
        try {
          const res = await fetch(API + '/ceo/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q }) })
          const json = await res.json()
          // D-01：只走真实会话；失败显示"卡在哪"，不再假装"规则版"回答
          if (json && json.ok) {
            // D-20 ②：命中"开新会话执行"时服务端直接建会话，返回会话名/ID
            if (json.executed) {
              setCeoLog((prev) => prev.concat([{ role: 'sys', text: String(json.message || '已开好执行会话') }]).slice(-10))
            } else {
              // D-20 ①：回复里点到任务编号时，挂上「接下 / 完成 / 转交」硬动作按钮
              const ids = Array.from(new Set(String(json.text || '').match(/K-\d{3,}/g) || []))
              setCeoLog((prev) => prev.concat([{ role: 'bot', text: 'CEO：' + String(json.text || ''), actions: ids }]).slice(-10))
            }
          } else {
            setCeoLog((prev) => prev.concat([{ role: 'sys', text: 'CEO 没答上来：' + String((json && json.message) || '会话不可用') }]).slice(-10))
          }
        } catch (e) {
          setCeoLog((prev) => prev.concat([{ role: 'sys', text: '问 CEO 失败：' + String(e && e.message ? e.message : e) }]).slice(-10))
        }
        setCeoBusy(false)
      }

      async function handoffToCeo() {
        const q = histDraft.trim() || '把刚才这件事转给 CEO'
        try {
          const res = await fetch(API + '/historian/handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q }) })
          const json = await res.json()
          setHistLog((prev) => prev.concat([{ role: 'sys', text: json && json.ok ? (json.notified === false ? '任务已挂上，但 CEO 会话没接住：' + String(json.message || '') : '已转给 CEO：' + json.taskId) : ((json && json.message) || '没转成') }]).slice(-6))
          setHistDraft('')
        } catch (e) {
          setHistLog((prev) => prev.concat([{ role: 'sys', text: '转给 CEO 失败：' + String(e && e.message ? e.message : e) }]).slice(-6))
        }
      }

      async function sendHistorian() {
        const q = histDraft.trim()
        if (!q) return
        setHistLog((prev) => prev.concat([{ role: 'me', text: q }]).slice(-6))
        setHistDraft('')
        try {
          const res = await fetch(API + '/historian/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q }) })
          const json = await res.json()
          // D-01：失败显示服务端错误（会话不可用/卡在哪），不糊一句"没答上来"
          if (json && json.ok) setHistLog((prev) => prev.concat([{ role: 'bot', text: '史官：' + String(json.text || '').slice(0, 800), q }]).slice(-6))
          else setHistLog((prev) => prev.concat([{ role: 'sys', text: '史官没答上来：' + String((json && json.message) || '会话不可用') }]).slice(-6))
        } catch (e) {
          setHistLog((prev) => prev.concat([{ role: 'sys', text: '问史官失败：' + String(e && e.message ? e.message : e) }]).slice(-6))
        }
      }

      function startEdit(item) {
        setEditId(item.id)
        setEditText(item.title || '')
      }

      async function updateTodo(id, payload) {
        if (todoBusy) return
        setTodoBusy(true)
        setMsg('')
        try {
          const res = await fetch(API + '/todo/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...payload }) })
          const json = await res.json()
          if (json && json.ok) {
            setTodoAction('')
            setMsg(json.item && json.item.title ? '已更新：' + json.item.title : '已更新')
            if (typeof reload === 'function') reload()
          } else {
            setMsg((json && json.message) || '没改成')
          }
        } catch (e) {
          setMsg('没改成：' + String(e && e.message ? e.message : e))
        }
        setTodoBusy(false)
      }

      function beginAdjust(item) {
        setTodoAction('adjust:' + item.id)
        setAdjustDraft({ urgency: Number(item.urgency) || 1, importance: Number(item.importance) || 1 })
      }

      function beginDue(item) {
        setTodoAction('due:' + item.id)
        setDueDraft({ ...dueDraft, [item.id]: String(item.due || '') })
      }

      function saveDue(item) {
        const due = String(dueDraft[item.id] || '').trim()
        if (!due) {
          setMsg('先选个日期')
          return
        }
        updateTodo(item.id, { action: 'due', due })
      }

      function pauseTodo(item) {
        updateTodo(item.id, { action: 'pause' })
      }

      function jumpTodo(item) {
        if (!item.sessionId) {
          setMsg('这条事项没有关联会话')
          return
        }
        if (workspaceNavigation && typeof workspaceNavigation.openSession === 'function') {
          try {
            workspaceNavigation.openSession(item.sessionId)
            return
          } catch (e) {
            setMsg('跳转失败：' + String(e && e.message ? e.message : e))
            return
          }
        }
        setMsg('当前 DSH 没有提供会话跳转接口')
      }

      async function saveEdit() {
        const title = editText.trim()
        if (!editId || !title) return
        try {
          const res = await fetch(API + '/todo/edit', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: editId, title }),
          })
          const json = await res.json()
          setMsg(json && json.ok ? '已改：' + editId : ((json && json.message) || '没改成'))
          if (json && json.ok) {
            setEditId('')
            setEditText('')
            if (typeof reload === 'function') reload()
          }
        } catch (e) {
          setMsg('没改成：' + String(e && e.message ? e.message : e))
        }
      }

      async function runHistorian(dryRun) {
        try {
          const res = await fetch(API + '/historian/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dryRun }) })
          const json = await res.json()
          if (json && json.ok) {
            const scopeNote = json && json.filteredByScope ? '（跳过了 ' + json.filteredByScope + ' 个非测试会话）' : ''
            setMsg((dryRun ? '试跑完成：这次会记 ' : '真跑完成：已写 ') + (json.written || 0) + ' 条' + scopeNote)
            if (!dryRun && typeof reload === 'function') reload()
          } else {
            setMsg((json && json.message) || '史官没跑成')
          }
        } catch (e) {
          setMsg('史官没跑成：' + String(e && e.message ? e.message : e))
        }
      }

      async function openTaskSession() {
        const task = ceoDraft.trim()
        if (!task) {
          setCeoLog((prev) => prev.concat([{ role: 'sys', text: '先在输入框写清楚要开的任务，再点「开新会话（任务）」。' }]).slice(-10))
          return
        }
        if (ceoBusy) return
        setCeoBusy(true)
        try {
          const res = await fetch(API + '/ceo/open-task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task }) })
          const json = await res.json()
          if (json && json.ok) {
            setCeoLog((prev) => prev.concat([{ role: 'sys', text: String(json.message || '已开好 CEO 任务会话') }]).slice(-10))
            setCeoDraft('')
          } else {
            setCeoLog((prev) => prev.concat([{ role: 'sys', text: '没开成：' + String((json && json.message) || '未知错误') }]).slice(-10))
          }
        } catch (e) {
          setCeoLog((prev) => prev.concat([{ role: 'sys', text: '没开成：' + String(e && e.message ? e.message : e) }]).slice(-10))
        }
        setCeoBusy(false)
      }

      const b = data || {}
      const four = b.four || {}
      const analysis = b.analysis || {}
      const hist = b.historian || {}
      const diag = b.diagnostics || {}

      function taskButtons() {
        return null
      }

      return h('div', { className: 'ke ke-wrap' },
        Style(),
        h('div', { className: 'ke-h1' }, '看板'),
        h('div', { className: 'ke-sub' },
          localHm(b.generatedAt || '', true) + ' 更新' + (error ? ' · 取数失败：' + error : ''),
          h('span', { style: { marginLeft: 10 } }, '·'),
          h('button', {
            style: { marginLeft: 8, border: '1px solid #e5e6eb', background: '#fff', borderRadius: 6, padding: '1px 8px', fontSize: 11, cursor: 'pointer', color: '#4e5969' },
            onClick: () => {
              const next = !petHidden
              writePetHidden(next)
              setPetHidden(next)
            },
          }, petHidden ? '显示鲸鱼娘' : '隐藏鲸鱼娘'),
          h('button', {
            style: { marginLeft: 6, border: '1px solid #e5e6eb', background: '#fff', borderRadius: 6, padding: '1px 8px', fontSize: 11, cursor: 'pointer', color: '#4e5969' },
            onClick: refreshNow,
          }, refreshing ? '刷新中…' : '刷新'),
          h('span', { className: 'ke-mini', style: { marginLeft: 6 } }, petHidden ? '（现在隐藏着，点左边可找回）' : '')),
        error && h('div', { className: 'ke-err', style: { marginBottom: 12 } }, '读不到看板数据：' + error),

        h('div', { className: 'ke-grid' },
          h('div', { className: 'ke-col' },
            h('div', { className: 'ke-left2' },
              h('div', { className: 'ke-left2-side' },
            // 统一事项：待办 + CEO 任务共用同一套优先级（不再各排各的）
            h('div', { className: 'ke-panel' }, h('div', { className: 'ke-blk', style: { marginTop: 0 } }, h('span', { className: 'h' }, '优先级'),
              h('span', { className: 'w' }, '只看紧急/重要（4/5 级）；全部明细在下面待办卡')),
            h('div', { className: 'ke-card ke-kv ke-scroll', style: { maxHeight: 92 } },
              (function renderPriority() {
                const rows = (b.attention && b.attention.items ? b.attention.items : []).filter((item) => item.level >= 4)
                if (!rows.length) return h('span', { className: 'ke-mini' }, '暂无紧急/重要事项（4/5 级）')
                return rows.slice(0, 6).map((item) => h('div', { key: item.kind + '-' + item.id, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', minWidth: 0 } },
                  levelTag(item.level, item.label),
                  h('span', { className: 'ke-mini', style: { flex: '0 0 46px' } }, item.sourceLabel),
                  h('span', { className: 'nm', style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, displayText(item.title)),
                  h('span', { className: 'ke-mini' }, item.due ? '截止 ' + item.due.slice(5) : '无截止')))
              })(),
            ),
            ),
            ),
            h('div', { className: 'ke-panel ke-todo' }, h('div', { className: 'ke-blk', style: { marginTop: 0 } }, h('span', { className: 'h' }, '待办'),
              h('span', { className: 'w' }, '全部事项 ' + ((b.attention && b.attention.count) || 0) + ' · 待确认 ' + ((b.todos && b.todos.pendingCount) || 0))),
            h('div', { className: 'ke-card ke-kv ke-scroll', style: { maxHeight: 150, marginBottom: 6 } },
              (b.attention && b.attention.items && b.attention.items.length)
                ? b.attention.items.map((item) => h('div', { key: 'todo-' + item.kind + '-' + item.id, style: { padding: '4px 0', borderBottom: '1px dashed #eef0f3' } },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
                      levelTag(item.level, item.label),
                      h('span', { className: 'ke-mini', style: { flex: '0 0 46px' } }, item.sourceLabel),
                      h('span', { className: 'nm', style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, displayText(item.title)),
                      h('span', { className: 'ke-mini', style: { flex: '0 0 64px', textAlign: 'right' } }, item.due ? '截止 ' + item.due.slice(5) : '无截止'),
                      h('span', { className: 'ke-mini', style: { flex: '0 0 70px', textAlign: 'right' } }, item.durationLabel || '')),
                    h('div', { style: { display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap' } },
                      h('button', { className: 'ke-btn', disabled: todoBusy, onClick: () => beginAdjust(item) }, '调整'),
                      h('button', { className: 'ke-btn', disabled: todoBusy, title: '修改 deadline', onClick: () => beginDue(item) }, '📅'),
                      h('button', { className: 'ke-btn', disabled: todoBusy || !item.sessionId, title: item.sessionId ? '跳到对应会话' : '这条事项没有关联会话', onClick: () => jumpTodo(item) }, '跳转'),
                      h('button', { className: 'ke-btn', disabled: todoBusy, title: '暂停，不删除', onClick: () => pauseTodo(item) }, '划掉')),
                    todoAction === 'adjust:' + item.id
                      ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, marginTop: 3, flexWrap: 'wrap' } },
                          h('span', { className: 'ke-mini' }, '紧急'),
                          h('select', { value: adjustDraft.urgency, onChange: (e) => setAdjustDraft({ ...adjustDraft, urgency: Number(e.target.value) }) }, [1, 2, 3].map((n) => h('option', { key: n, value: n }, String(n)))),
                          h('span', { className: 'ke-mini' }, '重要'),
                          h('select', { value: adjustDraft.importance, onChange: (e) => setAdjustDraft({ ...adjustDraft, importance: Number(e.target.value) }) }, [1, 2, 3].map((n) => h('option', { key: n, value: n }, String(n)))),
                          h('button', { className: 'ke-btn', disabled: todoBusy, onClick: () => updateTodo(item.id, { action: 'adjust', urgency: adjustDraft.urgency, importance: adjustDraft.importance }) }, '保存'),
                          h('button', { className: 'ke-btn', onClick: () => setTodoAction('') }, '取消'))
                      : null,
                    todoAction === 'due:' + item.id
                      ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 } },
                          h('input', { type: 'date', value: dueDraft[item.id] || '', onChange: (e) => setDueDraft({ ...dueDraft, [item.id]: e.target.value }), style: { fontSize: 11 } }),
                          h('button', { className: 'ke-btn', disabled: todoBusy, onClick: () => saveDue(item) }, '保存'),
                          h('button', { className: 'ke-btn', onClick: () => setTodoAction('') }, '取消'))
                      : null))
                : h('span', { className: 'ke-mini' }, '没有待办或进行中的 CEO 任务')),
            // 2026-10-26 修 B-01：候选（待确认）也列出来，每条给「确认/划掉」，确认前可填日期
            (function renderPending() {
              const rows = (b.todos && b.todos.pending) || []
              if (!rows.length) return h('span', { className: 'ke-mini' }, '没有待确认的（记一条后在这里确认）')
              return h('div', { className: 'ke-card ke-kv ke-scroll', style: { marginBottom: 6, maxHeight: 120 } },
                rows.map((t) => h('div', { key: t.id, style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' } },
                  editId === t.id
                    ? h('input', { type: 'text', value: editText, onChange: (ev) => setEditText(ev.target.value), style: { flex: '1 1 160px', fontSize: 13, padding: '2px 6px' } })
                    : h('span', { style: { flex: '1 1 120px' } }, displayText(t.title)),
                  h('input', {
                    type: 'date',
                    value: dueDraft[t.id] || '',
                    onChange: (ev) => setDueDraft({ ...dueDraft, [t.id]: ev.target.value }),
                    style: { fontSize: 11, padding: '1px 3px' },
                    title: '哪天提醒（可不填）',
                  }),
                  h('button', { className: 'ke-btn', disabled: busy, onClick: () => confirmItem(t.id) }, '确认'),
                    editId === t.id
                      ? h('button', { className: 'ke-btn', onClick: saveEdit }, '保存')
                      : h('button', { className: 'ke-btn', disabled: busy, onClick: () => startEdit(t) }, '修改'),
                    editId === t.id ? h('button', { className: 'ke-btn', onClick: () => setEditId('') }, '取消') : null,
                  h('button', { className: 'ke-btn', disabled: todoBusy, title: '暂停，不删除', onClick: () => updateTodo(t.id, { action: 'pause' }) }, '划掉'))))
            })(),
            (b.todos && b.todos.pendingHidden ? h('div', { className: 'ke-mini' }, '还有 ' + b.todos.pendingHidden + ' 条未显示（按日期排序，处理完上面的就会露出来）') : null),
            msg ? h('div', { className: 'ke-mini', style: { marginTop: 4 } }, displayText(msg)) : null,
            ),
            ),
              h('div', { className: 'ke-left2-main' },
            h('div', { className: 'ke-blk ke-role-head' }, h('span', { className: 'h' }, '秘书 · dsh小助手'), h('span', { className: 'w' }, '对话中')),
            h('div', { className: 'ke-chat' },
              h('div', { className: 'ke-chat-log', ref: secLogRef },
                (chatLog.length ? chatLog : [{ role: 'sys', text: '跟秘书说一句：记待办、问什么都可以；点「问 CEO」让它给判断。' }]).map((line, i) =>
                  h('div', { key: i, className: 'ke-msg-row' },
                    h('span', { className: 'ke-msg-no' }, (i + 1) + '.'),
                    h('div', { className: 'ke-msg-col' },
                      h('div', { className: 'ke-msg ' + (line.role === 'bot' ? 'bot' : (line.role === 'me' || line.role === 'user') ? 'me' : 'sys') }, displayText(line.text)),
                      handoffButtons('secretary', line, i)))),
                msg ? h('div', { className: 'ke-msg sys' }, msg) : null),
            h('div', { className: 'ke-add' },
              h('input', {
                type: 'text',
                placeholder: '跟秘书说一句（记待办，回车就记下）',
                value: draft,
                onChange: (e) => setDraft(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') chatSecretary() },
              }),
              h('label', { title: '同时勾=又急又重要；"最"只认你口述（这里不提供）' },
                h('input', { type: 'checkbox', checked: urgent, onChange: (e) => setUrgent(e.target.checked) }),
                '紧急'),
              h('label', { title: '同时勾=又急又重要；"最"只认你口述（这里不提供）' },
                h('input', { type: 'checkbox', checked: important, onChange: (e) => setImportant(e.target.checked) }),
                '重要'),
              h('button', { onClick: addTodo, disabled: busy || !draft.trim(), title: '把这句记成待办' }, '记下'),
              h('button', { onClick: () => handoffTo('secretary', draft.trim() || (chatLog.filter((x) => x.role === 'me').slice(-1)[0] || {}).text || '把这件事交给CEO'), disabled: busy, title: '把这句/这件事硬转给 CEO' }, '问 CEO'))),

              ),



          ),

          h('div', { className: 'ke-col' },
            // 2026-10-26：右侧改成 CEO 聊天入口（大），史官挪到下面（小）
            h('div', { className: 'ke-blk ke-role-head' }, h('span', { className: 'h' }, 'CEO · dsh小助手'),
              h('span', { className: 'w' }, '对话中'), h('button', { className: 'ke-btn', style: { marginLeft: 6 }, onClick: refreshNow }, refreshing ? '…' : '刷新')),
            h('div', { className: 'ke-chat ke-chat-right' },
              h('div', { className: 'ke-chat-log', ref: ceoLogRef },
                (ceoLog.length ? ceoLog : [{ role: 'sys', text: '直接说：查任务 / 接下 K-001 / 完成 / 归档 / 存为记忆（不用点按钮）' }]).map((line, i) =>
                  h('div', { key: i, className: 'ke-msg-row' },
                    h('span', { className: 'ke-msg-no' }, (i + 1) + '.'),
                    h('div', { className: 'ke-msg-col' },
                      h('div', { className: 'ke-msg ' + (line.role === 'bot' ? 'bot' : (line.role === 'me' || line.role === 'user') ? 'me' : 'sys') }, displayText(line.text)))))),
              h('div', { className: 'ke-add' },
                h('input', {
                  type: 'text',
                  placeholder: '问 CEO（回车发送）',
                  value: ceoDraft,
                  onChange: (e) => setCeoDraft(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') sendCeo() },
                }),
                h('button', { onClick: sendCeo, disabled: ceoBusy || !ceoDraft.trim() }, ceoBusy ? '想…' : '发送'),
                h('button', { className: 'ke-btn', onClick: openTaskSession, disabled: ceoBusy, title: '用输入框里的任务开一个 CEO 执行会话（点击=你同意；一小时最多 4 个）' }, '开新会话（任务）')),
            ),

            h('div', { className: 'ke-role-frame' },
            h('div', { className: 'ke-blk ke-role-head' }, h('span', { className: 'h' }, '史官'), h('span', { className: 'w', style: hist.enabled !== false && hist.scope === 'all' ? { color: '#b32b1f', fontWeight: 600 } : undefined }, (hist.enabled === false ? '已关闭' : '已打开') + (hist.scope === 'all' ? ' · 默认读全部真实会话（含工作内容）' : ' · 只读 [实验] 与角色会话'))),
            (hist.enabled !== false && hist.scope === 'all')
              ? h('div', { className: 'ke-mini', style: { color: '#b32b1f', margin: '0 0 6px' } }, '隐私提醒：史官默认会读全部会话正文；不想让它读真实内容，就把配置里的 historian.scope.mode 改成 sandbox（见 README「开发 / 测试模式」）。')
              : null,
            h('div', { className: 'ke-add', style: { margin: '2px 0 6px' } },
              h('button', { className: 'ke-btn', onClick: () => runHistorian(true), title: '只查不写，看看会记多少条' }, '试跑（只查）'),
              h('button', { className: 'ke-btn', onClick: () => runHistorian(false), title: '真的写进言行录' }, '真跑一次（写盘）')),
            h('div', { className: 'ke-card ke-kv', style: { marginBottom: 6 } },
              h('div', null, (hist.today && hist.today.summary) || '—')),
            h('div', { className: 'ke-chat ke-chat-small' },
              h('div', { className: 'ke-chat-log', ref: histLogRef },
                (histLog.length ? histLog : [{ role: 'sys', text: '问我：最近记了什么？上周你交代过什么？' }]).map((line, i) =>
                  h('div', { key: i, className: 'ke-msg-row' },
                    h('span', { className: 'ke-msg-no' }, (i + 1) + '.'),
                    h('div', { className: 'ke-msg-col' },
                      h('div', { className: 'ke-msg ' + (line.role === 'bot' ? 'bot' : (line.role === 'me' || line.role === 'user') ? 'me' : 'sys') }, displayText(line.text)),
                      handoffButtons('historian', line, i))))),
              h('div', { className: 'ke-add' },
                h('input', {
                  type: 'text',
                  placeholder: '问史官（回车发送）',
                  value: histDraft,
                  onChange: (e) => setHistDraft(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') sendHistorian() },
                }),
                h('button', { onClick: sendHistorian, disabled: !histDraft.trim() }, '发送'),
                h('button', { className: 'ke-btn', onClick: handoffToCeo, title: '把这句连同史实转给 CEO' }, '转给 CEO'))),
            ),




            h('div', { className: 'ke-note' },
              '诊断：跳过 ' + (diag.skipped || 0) + ' 条' +
              (diag.sessions && diag.sessions.truncated ? '；会话仅显示前 ' + (diag.sessions.shown || diag.sessions.total) + ' / 共 ' + diag.sessions.total + ' 个' : '') +
              (diag.degraded && diag.degraded.length ? '；降级 ' + diag.degraded.join('、') : '') +
              (diag.note ? '。' + diag.note : '')),
          ),
        ),
      )
    }

    /* ── 提醒灯：1 个＝普通，2 个＝急，3 个＝最急（并闪烁） ── */
    const DOT_COLORS = { red: '#f53f3f', warn: '#ffb400', orange: '#ff8a00', blue: '#4d6bfe', green: '#00b42a' }

    const DOT_DARK = { red: '#a8071a', warn: '#ad6800', orange: '#ad4e00', blue: '#2b4acb', green: '#087f23' }

    function renderDots(state, blinkMs) {
      const lamp = state.lamp || {
        color: state.dot || 'green',
        mode: state.blink ? 'blink' : 'steady',
        interval: state.blink ? 1300 : 0,
        reason: '',
      }
      const color = DOT_COLORS[lamp.color] || DOT_COLORS.green
      const dark = DOT_DARK[lamp.color] || DOT_DARK.green
      const blinking = lamp.mode === 'blink'
      const interval = Number(lamp.interval) || Number(blinkMs) || 800
      const style = {
        background: 'radial-gradient(circle at 32% 26%, #fff 0%, ' + color + ' 38%, ' + dark + ' 100%)',
        display: 'block',
        width: '11px',
        height: '11px',
        minWidth: '11px',
        minHeight: '11px',
        aspectRatio: '1 / 1',
        borderRadius: '50%',
        boxSizing: 'border-box',
        flex: '0 0 auto',
      }
      if (blinking) style.animationDuration = interval + 'ms'
      return h('span', { className: 'ke-lamp' + (blinking ? ' ke-blink' : ''), title: lamp.reason || '', style })
    }

    function levelTag(level, label) {
      if (!level) return null
      return h('span', { className: 'ke-lv l' + level },
        h('i', { style: { background: DOT_COLORS[level === 3 ? 'warn' : level === 1 ? 'blue' : 'red'] } }),
        label || ('L' + level))
    }

    /* ── 3. 鲸鱼娘浮层（shell.overlay） ─────────────────────── */
    const PET_COLLAPSED = { width: 84, height: 100 }
    const PET_EXPANDED = { width: 340, height: 420 }
    const EDGE = 10

    /**
     * 本地时间显示：后端给的是 ISO（UTC），以前直接 slice(11,19) 显示会差 8 小时。
     * 2026-10-26 修 B-11。
     */
    function localHm(iso, withSeconds) {
      if (!iso) return withSeconds ? '--:--:--' : '--:--'
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return String(iso).slice(11, withSeconds ? 19 : 16)
      const text = d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) })
      return text
    }

    /** 把位置夹进视口：保证无论展开/收起，都不会被挤出屏幕 */
    function clampPos(x, y, size) {
      const maxX = Math.max(EDGE, window.innerWidth - size.width - EDGE)
      const maxY = Math.max(EDGE, window.innerHeight - size.height - EDGE)
      return {
        x: Math.min(Math.max(EDGE, Math.round(x)), maxX),
        y: Math.min(Math.max(EDGE, Math.round(y)), maxY),
      }
    }

    // 双击收起后的 350ms 内忽略鲸鱼娘单击，避免"收起又被弹开"
    let petCollapseGuardUntil = 0

    function PetOverlay() {
      const [hidden, setHidden] = React.useState(readPetHidden())
      const [demo, setDemo] = React.useState(readBlinkDemo())
      const [blinkMs, setBlinkMs] = React.useState(readBlinkMs())
      // 动作状态：idle 待机 / hover 悬停 / grabbed 被拎起 / dropped 放下回弹 / sleepy 困
      const [mode, setMode] = React.useState('idle')
      const [zzzTick, setZzzTick] = React.useState(0)
      // 2026-10-26：浮窗展开后能直接跟秘书说话
      const [petDraft, setPetDraft] = React.useState('')
      const [petReply, setPetReply] = React.useState('')
      const [petMenu, setPetMenu] = React.useState(null)
      const [petBusy, setPetBusy] = React.useState(false)

      async function petSend() {
        const text = petDraft.trim()
        if (!text || petBusy) return
        setPetBusy(true)
        setPetReply('')
        try {
          const res = await fetch(API + '/secretary/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: text }) })
          const json = await res.json()
          if (json && json.ok) {
            setPetDraft('')
            setPetReply(String(json.text || '（秘书没说话）'))
          } else {
            setPetReply('秘书没答上来：' + String((json && json.message) || '会话不可用'))
          }
        } catch (e) {
          setPetReply('没发出去：' + String(e && e.message ? e.message : e))
        }
        setPetBusy(false)
      }
      const { data, error } = useJson(API + '/state', 5_000)

      React.useEffect(() => {
        function onVisibility() {
          setHidden(readPetHidden())
        }
        window.addEventListener(PET_VIS_EVENT, onVisibility)
        return () => window.removeEventListener(PET_VIS_EVENT, onVisibility)
      }, [])

      React.useEffect(() => {
        function onBlink() {
          setDemo(readBlinkDemo())
          setBlinkMs(readBlinkMs())
        }
        window.addEventListener(BLINK_EVENT, onBlink)
        return () => window.removeEventListener(BLINK_EVENT, onBlink)
      }, [])

      const [open, setOpen] = React.useState(false)
      const [pos, setPos] = React.useState(null)

      React.useEffect(() => {
        try {
          const raw = window.localStorage.getItem(PET_KEY)
          if (raw) {
            const saved = JSON.parse(raw)
            setPos(clampPos(saved.x, saved.y, PET_COLLAPSED))
          }
        } catch {
          /* ignore */
        }
      }, [])

      // Esc 收起：注册在 effect 里，卸载时清掉
      React.useEffect(() => {
        function onKey(ev) {
          if (ev.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])

      function savePos(next) {
        setPos(next)
        try {
          window.localStorage.setItem(PET_KEY, JSON.stringify(next))
        } catch {
          /* ignore */
        }
      }

      /**
       * 右边缘锚定：从 sizeFrom 换到 sizeTo 时，保持"右边不移动"。
       * 用户要求：收起时鲸鱼娘要回到浮窗的右边，而不是停在展开卡片的左上角；
       * 反过来，展开时卡片从鲸鱼娘的位置往左长，也不会把鲸鱼娘甩到右边去。
       */
      function rightAnchored(pos, sizeFrom, sizeTo) {
        const x = pos.x + sizeFrom.width - sizeTo.width
        return clampPos(x, pos.y, sizeTo)
      }

      function toggle(nextOpen) {
        const target = typeof nextOpen === 'boolean' ? nextOpen : !open
        const fromSize = open ? PET_EXPANDED : PET_COLLAPSED
        const toSize = target ? PET_EXPANDED : PET_COLLAPSED
        const current = pos || clampPos(window.innerWidth - fromSize.width - 18, 72, fromSize)
        savePos(rightAnchored(current, fromSize, toSize))
        setOpen(target)
        petCollapseGuardUntil = target ? 0 : Date.now() + 350
      }

      /** 拖拽：collapsed 时整只可拖；expanded 时拖标题栏 */
      function startDrag(ev) {
        ev.preventDefault()
        const size = open ? PET_EXPANDED : PET_COLLAPSED
        const origin = pos || clampPos(window.innerWidth - size.width - EDGE, 72, size)
        const startX = ev.clientX
        const startY = ev.clientY
        let moved = 0
        setMode('grabbed')
        function onMove(e) {
          const dx = e.clientX - startX
          const dy = e.clientY - startY
          if (Math.abs(dx) + Math.abs(dy) > 3) moved += 1
          savePos(clampPos(origin.x + dx, origin.y + dy, size))
        }
        function onUp() {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          setMode('dropped')
          window.setTimeout(() => setMode('idle'), 260)
          // 收起态：没拖动就是"单击"，切换展开
          if (!moved && !open && Date.now() >= petCollapseGuardUntil) toggle(true)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      const rawData = data || {}
      // hooks 全部声明完之后再根据 hidden 早返回（2026-10-26 修：原来早返回写在 useState 之前，
      // 一隐藏就报 "Rendered fewer hooks than expected"，浮层变红框）
      if (hidden) return null
      const s = demo ? { ...rawData, dot: 'red', dots: 1, blink: true, count: 0, top: [], note: '灯闪预览 ' + blinkMs + 'ms' } : rawData
      const lampColor = (s.lamp && s.lamp.color) || s.dot
      const dotColor = lampColor === 'red' ? '#f53f3f' : lampColor === 'warn' ? '#ffb400' : lampColor === 'blue' ? '#4d6bfe' : '#00b42a'
      const size = open ? PET_EXPANDED : PET_COLLAPSED
      const placed = pos ? clampPos(pos.x, pos.y, size) : null
      const style = placed ? { left: placed.x + 'px', top: placed.y + 'px', right: 'auto' } : { right: '18px', top: '72px' }

      return h('div', {
        className: 'ke ke-pet' + (open ? ' expanded' : '') + ' mode-' + ((mode === 'idle' && s.quiet) ? 'sleepy' : mode),
        style,
        title: open ? '' : '单击展开，按住可拖动（像拎起一只小鲸鱼）',
        onContextMenu: (ev) => {
          ev.preventDefault()
          ev.stopPropagation()
          setPetMenu({ x: ev.clientX, y: ev.clientY })
        },
        onMouseEnter: () => { if (mode === 'idle') setMode('hover') },
        onMouseLeave: () => { if (mode === 'hover') setMode('idle') },
      },
        Style(),
        petMenu
          ? h('div', {
              style: { position: 'fixed', left: petMenu.x + 'px', top: petMenu.y + 'px', zIndex: 2147483600, background: '#fff', border: '1px solid #e5e6eb', borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,.12)', padding: 4, minWidth: 120 },
              onMouseLeave: () => setPetMenu(null),
            },
              h('div', { style: { padding: '6px 10px', cursor: 'pointer', fontSize: 12 }, onClick: async () => { try { await fetch(API + '/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }) } catch {} if (typeof reload === 'function') reload(); setPetMenu(null) } }, '刷新鲸鱼娘'),
              h('div', { style: { padding: '6px 10px', cursor: 'pointer', fontSize: 12 }, onClick: () => { writePetHidden(false); setHidden(false); setPetMenu(null); toggle(false) } }, '唤出鲸鱼娘'),
              h('div', { style: { padding: '6px 10px', cursor: 'pointer', fontSize: 12, color: '#b32b1f' }, onClick: () => { writePetHidden(true); setHidden(true); setPetMenu(null) } }, '隐藏鲸鱼娘'))
          : null,
        open
          ? h('div', { className: 'card' },
              // 标题栏：拖动把手 + 双击收起（不再放小图标）
              h('div', {
                className: 'hd',
                onPointerDown: startDrag,
                onDoubleClick: () => toggle(false),
                title: '按住可拖动；双击这里收起（Esc 也可以）',
              },
                h('span', null, 'dsh小助手'),
                s.level ? levelTag(s.level, s.levelLabel) : null,
                h('span', { className: 't' }, localHm(s.at, true) + ' 更新'),
              ),
              (s.attention && s.attention.items && s.attention.items.length)
                ? s.attention.items.slice(0, 3).map((item, i) => h('div', { className: 'row', key: 'att-' + i },
                    levelTag(item.level, item.label),
                    h('span', { className: 'nm' }, item.sourceLabel + ' · ' + displayText(item.title)),
                    h('span', { className: 'due' }, item.due || item.status || '')))
                : null,
              (!s.attention || !s.attention.items || !s.attention.items.length)
                ? h('div', { className: 'row' }, h('span', { className: 'nm ke-mini' }, s.note || '今天没有要提醒你的'))
                : null,
              error ? h('div', { className: 'row' }, h('span', { className: 'nm ke-err' }, '读不到：' + error)) : null,
              h('div', { className: 'ke-add', style: { margin: '6px 0 0' } },
                h('input', {
                  type: 'text',
                  placeholder: '跟秘书说一句（回车发送）',
                  value: petDraft,
                  onChange: (e) => setPetDraft(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') petSend() },
                }),
                h('button', { onClick: petSend, disabled: petBusy || !petDraft.trim() }, petBusy ? '…' : '发送')),
              petReply
                ? h('div', { style: { marginTop: 6, padding: '6px 8px', background: '#f2f3f5', borderRadius: 6, fontSize: 12, lineHeight: 1.45, color: '#1f2329', whiteSpace: 'pre-wrap', maxHeight: 132, overflowY: 'auto' } }, petReply)
                : null,
              h('div', { className: 'ft' },
                h('span', { className: 'dot', style: { position: 'static', boxShadow: 'none', background: dotColor } }),
                '数据 ' + localHm(s.at, false),
                h('span', { className: 'go', onClick: () => toggle(false) }, '收起 ↑')),
            )
          : h('span', { onPointerDown: startDrag, style: { position: 'relative', display: 'inline-block' } },
              h('span', { className: 'zzz' }, 'z'),
              h('span', { className: 'zzz' }, 'Z'),
              h('span', { className: 'zzz' }, 'z'),
              h(Skin, { size: 72 }),
              renderDots(s, blinkMs)),
      )
    }
    function safe(Component, label) {
      return function Safe(props) {
        return h(Boundary, { label }, h(Component, props))
      }
    }

    return {
      inject: ['slots', 'uiWorkspace'],
      apply(ctx) {
        workspaceNavigation = ctx.uiWorkspace || (typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null) || null
        // 插槽注册随插件 fiber 一起卸载；这里不额外包 ctx.effect（照官方模板写法）。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_KEY, order: 40, label: () => 'dsh小助手' },
            safe(PanelIcon, 'icon'),
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_KEY }, safe(BoardPage, 'board')),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'steward-pet', order: 100, label: () => '鲸鱼娘' },
            safe(PetOverlay, 'pet'),
          ),
        )
      },
    }
  },
})
