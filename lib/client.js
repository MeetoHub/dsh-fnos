/**
 * dsh-fnos 客户端半边（Web UI）
 *
 * 三个落点：
 *   1. plugins.bundle.config（key = 包名）—— 插件详情页里填地址 + 授权（主入口）
 *   2. conversation.input.left —— 输入框左侧飞牛图标，点开文件夹选择浮层
 *   3. main —— 完整面板（供输入框图标跳转）
 *
 * 重要约束（踩过的坑）：
 *   - inject 必须含 'layout'（selectPanel 要用）与 'sessions'（取输入框插引用）
 *   - 组件在模块作用域，不能直接引用 apply 的 ctx —— 必须靠 inject(sessionId) 传参
 *   - 颜色一律用 --dsw-alias-* 主题变量，写死系统色会导致皮肤套不上
 */
window.__ModuleLoader__.load({
  id: 'dsh-fnos',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const PANEL_ID = 'dsh-fnos';
    const BASE = '/fnos/auth/';
    const CONFIG_KEY = 'dsh-fnos.config';
    // 实测：uid 1000 是个人目录；@team 目前为空
    const MY_FOLDER = '/vol1/1000';
    const TEAM_FOLDER = '/vol1/@team';

    const DEFAULT_CONFIG = { host: '<设备地址>', port: 5667, scheme: 'https', tlsInsecure: true };

    function loadConfig() {
      try {
        const raw = localStorage.getItem(CONFIG_KEY);
        if (!raw) return DEFAULT_CONFIG;
        return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
      } catch { return DEFAULT_CONFIG; }
    }
    function saveConfig(cfg) {
      try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch { /* 忽略 */ }
    }

    async function api(path, init) {
      const res = await fetch(BASE + path, init);
      let data = null;
      try { data = await res.json(); } catch { /* 忽略 */ }
      if (!res.ok && data && data.error) throw new Error(data.error);
      return data || {};
    }
    const post = (body) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });

    // ── 图标：用 package.json 声明的那张 icon.png（内嵌 base64，两处一致）──────
    var FNOS_ICON_PNG = 'data:image/png;base64,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';

    function FnosIcon(props) {
      const size = (props && props.size) || 20;
      return h('img', {
        src: FNOS_ICON_PNG, width: size, height: size, alt: 'fnOS',
        style: { display: 'block', borderRadius: 3 },
      });
    }

    // ── 主题变量：必须用 DSH 的 --dsw-alias-*，皮肤才能覆盖 ────────────────
    const C = {
      bgOverlay: 'var(--dsw-alias-bg-overlay)',
      bgLayer1: 'var(--dsw-alias-bg-layer-1)',
      bgLayer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      textDim: 'var(--dsw-alias-label-secondary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
    };

    const btn = {
      padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
      border: `1px solid ${C.border}`, background: 'transparent',
      color: C.text, fontSize: 13,
    };
    const input = {
      padding: '6px 10px', borderRadius: 6, border: `1px solid ${C.border}`,
      background: 'transparent', color: C.text, fontSize: 13,
    };
    const muted = { color: C.textDim, fontSize: 12, lineHeight: 1.65 };

    // ── 登录逻辑 ──────────────────────────────────────────────────────────
    function useFnosAuth(cfg) {
      const [state, setState] = useState('idle');
      const [url, setUrl] = useState('');
      const [code, setCode] = useState('');
      const [msg, setMsg] = useState('');
      const [left, setLeft] = useState(0);

      const refresh = useCallback(async () => {
        try {
          const s = await api('status');
          if (s.state === 'authorized') setState('authorized');
          else if (s.state === 'waiting-code') { setState('waiting'); setUrl(s.url || ''); }
          else setState((v) => (v === 'waiting' ? v : 'idle'));
        } catch { /* 忽略 */ }
      }, []);

      useEffect(() => { refresh(); }, [refresh]);

      useEffect(() => {
        if (state !== 'waiting') return;
        setLeft(300);
        const t = setInterval(() => setLeft((v) => (v <= 0 ? 0 : v - 1)), 1000);
        return () => clearInterval(t);
      }, [state]);

      const start = useCallback(async () => {
        setState('starting'); setMsg('');
        try {
          const r = await api('start', post(cfg));
          setUrl(r.url || '');
          setState('waiting');
          if (r.url) window.open(r.url, '_blank', 'noopener');
        } catch (e) { setState('failed'); setMsg(e.message || String(e)); }
      }, [cfg]);

      const submit = useCallback(async () => {
        const value = (code || '').trim();
        if (!value) { setMsg('请先粘贴浏览器里显示的授权码'); return; }
        setState('submitting'); setMsg('');
        try {
          const r = await api('submit', post({ code: value }));
          setCode('');
          if (r.ok) { setState('authorized'); setMsg(r.device || '授权成功'); }
          else { setState('failed'); setMsg(r.message || r.error || '授权失败'); }
        } catch (e) { setState('failed'); setMsg(e.message || String(e)); }
      }, [code]);

      return { state, url, code, setCode, msg, left, refresh, start, submit };
    }

    function LoginCard({ cfg }) {
      const a = useFnosAuth(cfg);
      let body;
      if (a.state === 'authorized') {
        body = h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('span', null, '✅ 已连接飞牛 NAS'),
          h('button', { style: btn, onClick: a.start }, '重新登录'),
        );
      } else if (a.state === 'waiting' || a.state === 'submitting') {
        body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { style: muted },
            '已打开飞牛授权页。登录后把页面显示的',
            h('strong', null, '一次性授权码'),
            '粘贴到下面，再点"完成登录"。'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('input', {
              style: { ...input, flex: '1 1 260px', minWidth: 200 },
              value: a.code, placeholder: '粘贴授权码',
              autoComplete: 'off', spellCheck: false,
              onChange: (e) => a.setCode(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') a.submit(); },
            }),
            h('button', { style: btn, onClick: a.submit, disabled: a.state === 'submitting' },
              a.state === 'submitting' ? '提交中…' : '完成登录'),
          ),
          h('div', { style: muted }, a.left > 0 ? `授权码 ${a.left} 秒后失效` : '授权码可能已失效，请重新获取'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            a.url ? h('a', { href: a.url, target: '_blank', rel: 'noopener', style: { fontSize: 12 } }, '重新打开授权页') : null,
            h('button', { style: btn, onClick: a.start }, '重新获取'),
          ),
        );
      } else if (a.state === 'starting') {
        body = h('div', { style: muted }, '正在启动登录…');
      } else if (a.state === 'failed') {
        body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', null, '❌ ' + (a.msg || '登录失败')),
          h('button', { style: btn, onClick: a.start }, '重试'),
        );
      } else {
        body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { style: muted }, '尚未连接。点下面的按钮，在浏览器里登录并授权即可。'),
          h('button', { style: btn, onClick: a.start }, '登录飞牛 NAS'),
        );
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        body,
        a.msg && a.state !== 'failed' ? h('div', { style: muted }, a.msg) : null,
      );
    }

    // ── 连接配置 ──────────────────────────────────────────────────────────
    function ConfigSection({ cfg, setCfg }) {
      const field = (label, node) => h('label', {
        style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 },
      }, h('span', { style: { color: C.textDim } }, label), node);

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: { fontSize: 13, fontWeight: 600 } }, '连接设置'),
        h('div', {
          style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 },
        },
          field('主机', h('input', {
            style: input, value: cfg.host,
            onChange: (e) => setCfg({ ...cfg, host: e.target.value }),
          })),
          field('端口', h('input', {
            style: input, type: 'number', value: String(cfg.port),
            onChange: (e) => setCfg({ ...cfg, port: Number(e.target.value) || 5667 }),
          })),
          field('协议', h('select', {
            style: input, value: cfg.scheme,
            onChange: (e) => setCfg({ ...cfg, scheme: e.target.value }),
          },
            h('option', { value: 'https' }, 'https'),
            h('option', { value: 'http' }, 'http'),
            h('option', { value: 'auto' }, 'auto'),
          )),
        ),
        h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 } },
          h('input', {
            type: 'checkbox', checked: !!cfg.tlsInsecure,
            onChange: (e) => setCfg({ ...cfg, tlsInsecure: e.target.checked }),
          }),
          h('span', null, '跳过证书校验（自签证书需要开启）'),
        ),
      );
    }

    // ── 完整面板 ──────────────────────────────────────────────────────────
    function FnosPanel() {
      const [cfg, setCfgRaw] = useState(loadConfig);
      const setCfg = useCallback((next) => { setCfgRaw(next); saveConfig(next); }, []);
      return h('div', {
        style: {
          padding: 24, maxWidth: 720, margin: '0 auto',
          display: 'flex', flexDirection: 'column', gap: 24,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h(FnosIcon, { size: 28 }),
          h('h2', { style: { margin: 0, fontSize: 18 } }, '飞牛 NAS'),
        ),
        h(ConfigSection, { cfg, setCfg }),
        h('hr', { style: { border: 0, borderTop: `1px solid ${C.border}`, margin: 0 } }),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, '授权登录'),
          h(LoginCard, { cfg }),
        ),
      );
    }

    // ── 插件详情页里的配置页 ──────────────────────────────────────────────
    function FnosConfigPage(props) {
      const [cfg, setCfgRaw] = useState(loadConfig);
      const setCfg = useCallback((next) => { setCfgRaw(next); saveConfig(next); }, []);
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 20 } },
        h(ConfigSection, { cfg, setCfg }),
        h('hr', { style: { border: 0, borderTop: `1px solid ${C.border}`, margin: 0 } }),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, '授权登录'),
          h(LoginCard, { cfg }),
        ),
      );
    }
    /**
     * 把选中的 NAS 路径作为**引用**插入输入框。
     *
     * 关键：**不需要先打 "/"**。
     * 查过 DSH 源码（ui-conversation 的 insertReference → $replaceDetectSpanWithNodes），
     * 底层支持**零宽 span** —— 官方自己的 insertFileReferences 就是
     * `{ start: at, end: at }` 插在光标处。所以直接在草稿末尾零宽插入即可。
     * 只有当用户已经打了 "/"、"/f"、"/fn" 时，才去覆盖那个 token。
     */
    function insertPathReference(ctx, sessionId, path, kind) {
      try {
        const actx = ctx && ctx.sessions ? ctx.sessions.scope(sessionId) : undefined;
        const input0 = actx && actx.get ? actx.get('conversation')?.input?.for(actx) : undefined;
        if (!input0) return { ok: false, reason: '拿不到当前会话的输入框' };

        const name = String(path).split('/').filter(Boolean).pop() || path;
        const value = {
          source: 'fnos-file',
          ref: JSON.stringify({ kind, path, semanticPath: path }),
          label: '@' + name + (kind === 'directory' ? '/' : ''),
          appearance: kind === 'directory' ? 'folder' : 'file',
          clipboardText: path,
        };

        const st = input0.state.getSnapshot();
        const draft = String(st.draft || '');
        const token = draft.endsWith('/fn') ? '/fn'
          : draft.endsWith('/f') ? '/f'
            : draft.endsWith('/') ? '/' : null;

        const attempt = (sp) => {
          try { return !!input0.insertReference(value, sp); } catch { return false; }
        };

        // ① 官方方式：光标处零宽插入（actions.captureInsertion 返回 { start, end, draftRev }）
        try {
          const cap = input0.actions && input0.actions.captureInsertion
            ? input0.actions.captureInsertion()
            : null;
          if (cap && typeof cap.start === 'number' && typeof cap.end === 'number'
            && cap.draftRev === st.draftRev) {
            if (attempt(cap)) return { ok: true };
          }
        } catch { /* 落回 ② */ }

        // ② 兜底：草稿末尾插入；若末尾正好是 "/" 之类的 token 就覆盖它
        const span = token
          ? { start: draft.length - token.length, end: draft.length, draftRev: st.draftRev }
          : { start: draft.length, end: draft.length, draftRev: st.draftRev };
        if (attempt(span)) return { ok: true };

        return { ok: false, reason: '插入被拒绝', hint: '输入框当前不接受插入（可能在提交中）' };
      } catch (e) {
        return { ok: false, reason: String((e && e.message) || e) };
      }
    }

    /**
     * 选择浮层的 CSS（集中定义，才能写伪类 / 滚动条 / 双声明 fallback）。
     *
     * 苹果味的三个要点：
     *   1. 毛玻璃不是"一层半透明"，而是 blur(30px) + saturate(190%) 把背后颜色"提亮"
     *   2. 顶部 1px 内阴影高光（inset 0 1px 0 rgba(255,255,255,.2)）—— iOS 面板的标志
     *   3. 多层阴影：近处硬、远处散，才有"浮起来"的体积感
     *
     * 动画用 cubic-bezier(.34,1.32,.5,1)：末段轻微过冲，就是"丝滑"的来源（近似 spring）。
     * background / border-color 都写两遍 —— 不支持 color-mix 的浏览器自动用前一条。
     */
    const PICKER_CSS = `
      .fnos-panel{
        position:absolute; bottom:calc(100% + 10px); left:0; z-index:1000;
        width:346px; overflow:hidden; padding:14px 14px 12px;
        border-radius:16px; font-size:12px;
        color:var(--dsw-alias-label-primary);
        transform-origin:bottom left;
        background:var(--dsw-alias-bg-overlay);
        background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 72%,transparent);
        -webkit-backdrop-filter:blur(30px) saturate(190%);
        backdrop-filter:blur(30px) saturate(190%);
        border:1px solid var(--dsw-alias-border-l1);
        border-color:color-mix(in srgb,currentColor 13%,transparent);
        box-shadow:
          0 10px 24px -10px rgba(0,0,0,.20),
          0 30px 70px -20px rgba(0,0,0,.30),
          inset 0 1px 0 0 rgba(255,255,255,.20);
        animation:fnosPopIn .36s cubic-bezier(.34,1.32,.5,1) both;
      }
      .fnos-panel[data-closing="1"]{ animation:fnosPopOut .16s cubic-bezier(.4,0,1,1) both; }
      @keyframes fnosPopIn{
        from{opacity:0;transform:translateY(14px) scale(.93)}
        to{opacity:1;transform:translateY(0) scale(1)}
      }
      @keyframes fnosPopOut{
        from{opacity:1;transform:translateY(0) scale(1)}
        to{opacity:0;transform:translateY(7px) scale(.97)}
      }

      .fnos-row{
        border-radius:7px;
        transition:background .16s cubic-bezier(.4,0,.2,1);
      }
      .fnos-row:hover{ background:var(--dsw-alias-bg-layer-2); }
      .fnos-row:active{ background:var(--dsw-alias-bg-layer-1); }

      .fnos-in{ animation:fnosRowIn .34s cubic-bezier(.22,1,.36,1) both; }
      @keyframes fnosRowIn{
        from{opacity:0;transform:translateX(-8px);filter:blur(3px)}
        to{opacity:1;transform:translateX(0);filter:blur(0)}
      }

      .fnos-scroll{ scrollbar-width:thin; scrollbar-color:rgba(128,128,128,.35) transparent; }
      .fnos-scroll::-webkit-scrollbar{ width:7px; }
      .fnos-scroll::-webkit-scrollbar-track{ background:transparent; }
      .fnos-scroll::-webkit-scrollbar-thumb{
        background:rgba(128,128,128,.28); border-radius:99px;
      }
      .fnos-scroll::-webkit-scrollbar-thumb:hover{ background:rgba(128,128,128,.45); }

      @keyframes fnosTrunk{ from{transform:scaleY(0)} to{transform:scaleY(1)} }
    `;

    // ── 文件夹选择浮层（分支列表 + 面包屑）────────────────────────────────
    function FnosFolderPicker({ ctx, sessionId, onClose }) {
      const [closing, setClosing] = useState(false);

      const [path, setPath] = useState(MY_FOLDER);
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(false);
      const [err, setErr] = useState('');
      const [q, setQ] = useState('');

      const load = useCallback(async (p) => {
        setLoading(true); setErr('');
        try {
          const r = await fetch('/fnos/files?path=' + encodeURIComponent(p)).then((x) => x.json());
          if (r && r.ok) { setData(r); setPath(r.path || p); setQ(''); }
          else { setErr((r && r.error) || '读取目录失败'); setData(null); }
        } catch (e) { setErr(String((e && e.message) || e)); setData(null); }
        setLoading(false);
      }, []);

      useEffect(() => { load(MY_FOLDER); }, [load]);

      const dirs = (data && data.dirs) || [];
      const files = (data && data.files) || [];
      const kw = q.trim().toLowerCase();
      const shownDirs = kw ? dirs.filter((d) => d.name.toLowerCase().includes(kw)) : dirs;
      const shownFiles = kw ? files.filter((f) => f.name.toLowerCase().includes(kw)) : files;

      // ── 局部样式（面板整体样式在 PICKER_CSS 里）─────────────────────────
      const trunk = {
        position: 'absolute', left: 12, top: 0, bottom: 0, width: 1,
        background: C.border,
      };
      const branchLine = () => ({
        position: 'absolute', left: 12, top: '50%', width: 10, height: 1,
        background: C.border, transformOrigin: 'left center',
      });
      const nodeDot = () => ({
        position: 'absolute', left: 8, top: '50%', marginTop: -3,
        width: 7, height: 7, borderRadius: '50%',
        background: C.bgLayer2, border: `1px solid ${C.borderStrong}`,
      });
      const crumb = (active) => ({
        border: 'none', background: 'transparent', cursor: 'pointer',
        color: active ? C.text : C.textDim,
        fontSize: 11, padding: '2px 5px', borderRadius: 5,
        maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', fontWeight: active ? 600 : 400,
        transition: 'color .15s ease, background .15s ease',
      });

      // 关闭：先播完收起动画再真正卸载，避免"啪一下消失"
      const requestClose = () => {
        setClosing(true);
        setTimeout(onClose, 170);
      };

      // ── 面包屑 ──────────────────────────────────────────────────────────
      const rootLabel = path.startsWith(MY_FOLDER) ? '我的文件夹'
        : path.startsWith(TEAM_FOLDER) ? '团队文件夹' : null;
      const rootPath = path.startsWith(MY_FOLDER) ? MY_FOLDER
        : path.startsWith(TEAM_FOLDER) ? TEAM_FOLDER : null;
      const rel = rootPath ? path.slice(rootPath.length).replace(/^\//, '') : '';
      const segs = rel ? rel.split('/') : [];

      return h('div', null,
        h('style', null, PICKER_CSS),
        h('div', { className: 'fnos-panel', 'data-closing': closing ? '1' : '0' },

          // ① 头部
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
            h(FnosIcon, { size: 18 }),
            h('strong', { style: { fontSize: 13, fontWeight: 600, flex: 1 } }, '选择文件或文件夹'),
            h('button', {
              style: {
                border: 'none', background: 'transparent', cursor: 'pointer',
                color: C.textDim, fontSize: 14, lineHeight: 1, padding: 2,
              },
              title: '关闭',
              onClick: requestClose,
            }, '✕'),
          ),

          // ② 搜索
          h('input', {
            style: {
              ...input, width: '100%', marginBottom: 8, fontSize: 12,
              boxSizing: 'border-box',
            },
            value: q,
            placeholder: '搜索当前目录…',
            autoComplete: 'off',
            spellCheck: false,
            onChange: (e) => setQ(e.target.value),
          }),

          // ③ 面包屑
          h('div', {
            style: {
              display: 'flex', alignItems: 'center', flexWrap: 'wrap',
              gap: 1, marginBottom: 8, minHeight: 20,
            },
          },
            rootPath
              ? h('button', { style: crumb(segs.length === 0), onClick: () => load(rootPath) }, rootLabel)
              : h('span', { style: { color: C.textDim, fontSize: 11 } }, path),
            segs.map((s, i) => {
              const sub = rootPath + '/' + segs.slice(0, i + 1).join('/');
              return h('span', {
                key: 'crumb' + i,
                style: { display: 'inline-flex', alignItems: 'center', gap: 1 },
              },
                h('span', { style: { color: C.textDim, fontSize: 10, opacity: 0.55 } }, '›'),
                h('button', { style: crumb(i === segs.length - 1), onClick: () => load(sub) }, s),
              );
            }),
          ),

          // ④ 分隔线
          h('div', { style: { height: 1, background: C.border, margin: '0 -14px 6px' } }),

          // ⑤ 列表主体
          h('div', {
            className: 'fnos-scroll',
            style: {
              position: 'relative', paddingLeft: 26,
              minHeight: 150, maxHeight: 250, overflowY: 'auto', overflowX: 'hidden',
            },
          },
            h('div', {
              style: {
                ...trunk,
                animation: 'fnosTrunk .28s cubic-bezier(.22,1,.36,1)',
                transformOrigin: 'top',
              },
            }),

            data && data.parent
              ? h('button', {
                className: 'fnos-row fnos-in',
                style: {
                  position: 'relative', display: 'flex', alignItems: 'center', gap: 6,
                  width: '100%', padding: '6px 8px', margin: '1px 0',
                  cursor: 'pointer', border: 'none',
                  background: 'transparent', color: C.textDim, fontSize: 12, textAlign: 'left',
                },
                onClick: () => load(data.parent),
              },
                h('span', { style: branchLine() }),
                h('span', { style: nodeDot() }),
                h('span', null, '⬆ 上级'),
              )
              : null,

            loading ? h('div', { style: { color: C.textDim, padding: '10px 4px' } }, '读取中…') : null,
            err ? h('div', { style: { color: C.error, padding: '10px 4px' } }, err) : null,
            shownDirs.length === 0 && shownFiles.length === 0 && !loading && !err
              ? h('div', { style: { color: C.textDim, padding: '10px 4px' } }, kw ? '没有匹配的项' : '（空文件夹）')
              : null,

            shownDirs.concat(shownFiles).map((entry, i) => {
              const isDir = !!entry.dir;
              const fullPath = path.replace(/\/$/, '') + '/' + entry.name;
              const pick = () => {
                const r = insertPathReference(ctx, sessionId, fullPath, isDir ? 'directory' : 'file');
                if (r.ok) requestClose();
                else setErr(r.hint || ('插入失败：' + (r.reason || '未知')));
              };
              // Ctrl / Cmd + 点击 = 直接选中，不管文件夹还是文件，也不用先进目录
              const onPickClick = (e) => {
                const forcePick = !!(e && (e.ctrlKey || e.metaKey));
                if (isDir && !forcePick) { load(fullPath); return; }
                pick();
              };
              return h('div', {
                key: (isDir ? 'd:' : 'f:') + entry.name,
                className: 'fnos-row fnos-in',
                style: {
                  position: 'relative', display: 'flex', alignItems: 'center',
                  width: '100%', margin: '1px 0',
                  animationDelay: `${(i + 1) * 30}ms`,
                },
              },
                h('span', { style: branchLine() }),
                h('span', { style: nodeDot() }),
                h('button', {
                  style: {
                    display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0,
                    padding: '6px 4px', border: 'none', background: 'transparent',
                    color: isDir ? C.text : C.textDim, fontSize: 12,
                    textAlign: 'left', cursor: 'pointer', borderRadius: 6,
                  },
                  title: (isDir ? 'Ctrl+点击 直接选中 · 点击进入：' : '点击选中：') + fullPath,
                  onClick: onPickClick,
                },
                  h('span', { style: { flexShrink: 0 } }, isDir ? '📁' : '📄'),
                  h('span', {
                    style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                  }, entry.name),
                ),
                isDir
                  ? h('button', {
                    style: {
                      padding: '4px 7px', border: 'none', background: 'transparent',
                      color: C.textDim, fontSize: 13, cursor: 'pointer',
                      borderRadius: 5, lineHeight: 1, flexShrink: 0,
                    },
                    title: '进入：' + fullPath,
                    onClick: (e) => { e.stopPropagation(); load(fullPath); },
                  }, '›')
                  : null,
              );
            }),
          ),

          // ⑥ 底部
          h('div', {
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 8, marginTop: 10, paddingTop: 10,
              borderTop: `1px solid ${C.border}`,
            },
          },
            h('span', {
              style: { color: C.textDim, fontSize: 10.5, lineHeight: 1.5, flex: 1 },
            }, 'Ctrl+点击 直接选中 · 点击文件夹进入'),
            h('button', {
              style: { ...btn, fontSize: 11.5, padding: '5px 11px', flexShrink: 0 },
              onClick: () => {
                const r = insertPathReference(ctx, sessionId, path, 'directory');
                if (r.ok) requestClose();
                else setErr(r.hint || ('插入失败：' + (r.reason || '未知')));
              },
            }, '选择当前文件夹'),
          ),
        ),
      );
    }

    // ── 输入框左侧图标 ────────────────────────────────────────────────────
    function FnosInputBadge(props) {
      const { ctx, sessionId } = props || {};
      const [state, setState] = useState('idle');
      const [open, setOpen] = useState(false);
      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const s = await api('status');
            if (alive) setState(s.state === 'authorized' ? 'authorized' : 'idle');
          } catch { /* 忽略 */ }
        })();
        return () => { alive = false; };
      }, []);
      return h('div', { style: { display: 'inline-flex', position: 'relative' } },
        h('button', {
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '3px 6px', borderRadius: 6, cursor: 'pointer',
            border: `1px solid ${C.border}`, background: 'transparent',
            color: C.text, fontSize: 12, lineHeight: 1,
          },
          title: state === 'authorized' ? '飞牛 NAS（已连接）· 点击选择文件' : '飞牛 NAS（未连接）',
          onClick: () => setOpen((v) => !v),
        },
          h('span', { style: { display: 'inline-flex', position: 'relative' } },
            h(FnosIcon, { size: 16 }),
            h('span', {
              style: {
                position: 'absolute', right: -1, bottom: -1,
                width: 6, height: 6, borderRadius: '50%',
                border: `1px solid ${C.bgLayer1}`,
                background: state === 'authorized' ? C.success : C.idle,
              },
            }),
          ),
          h('span', null, 'fn'),
        ),
        open ? h(FnosFolderPicker, { ctx, sessionId, onClose: () => setOpen(false) }) : null,
      );
    }

    return {
      // layout: selectPanel 需要；sessions: 取当前会话输入框插引用
      inject: ['slots', 'layout', 'locale', 'sessions'],
      apply(ctx) {
        // 插件详情页配置（key = npm 包名）—— 填地址 + 授权的主入口
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
          { name: 'plugins.bundle.config', key: 'dsh-fnos' },
          FnosConfigPage,
        ));

        // 完整面板（供图标跳转）
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: PANEL_ID, registrant: PANEL_ID },
          FnosPanel,
        ));

        // 输入框图标：点开文件/文件夹选择器
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'dsh-fnos-input-badge',
            order: 120,
            label: '飞牛 NAS',
            inject: (sessionId) => ({ ctx, sessionId }),
          },
          FnosInputBadge,
        ));
      },
    };
  },
});
