// ==UserScript==
// @name         研优课(ky.mfedu.cn) B站式播放控制
// @namespace    https://github.com/ZhuYiXuanNB/bettermfclass
// @version      1.1.1
// @description  给研优课的课程播放器加上 B 站风格的快捷键：← / → 快退快进、按住 → 倍速播放、↑ / ↓ 音量、空格播放暂停、F 全屏、W 网页全屏。已适配百家云(BPlayer/ffplayer 画布播放)与保利威。
// @author       ZhuYiXuanNB
// @match        https://ky.mfedu.cn/*
// @run-at       document-start
// @grant        none
// @noframes
// @license      GPL-3.0-or-later
// @supportURL   https://github.com/ZhuYiXuanNB/bettermfclass/issues
// @homepageURL  https://github.com/ZhuYiXuanNB/bettermfclass
// @downloadURL  https://raw.githubusercontent.com/ZhuYiXuanNB/bettermfclass/main/ky-bilibili-player.user.js
// @updateURL    https://raw.githubusercontent.com/ZhuYiXuanNB/bettermfclass/main/ky-bilibili-player.user.js
// ==/UserScript==

/*
 * 研优课 B 站式播放控制（ky-bilibili-player）
 * Copyright (C) 2026 ZhuYiXuanNB
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 本程序是自由软件：你可以依据自由软件基金会发布的 GNU 通用公共许可证
 * （第 3 版或你选择的任何更新版本）条款重新发布和/或修改它。
 * 本程序按“无任何担保”发布，详见 LICENSE 文件。
 */

/*
 * 说明（实现要点，方便以后维护）
 * ---------------------------------------------------------------------------
 * 研优课的课程视频走「百家云 BPlayer」：它用 ffmpeg 解码后画到 <canvas> 上，
 * 页面里根本没有 <video> 元素，所以不能直接改 video.currentTime。
 * BPlayer 实例只存在于 Vue 组件闭包里，因此本脚本在 document-start 阶段
 * 劫持 window.BPlayer 这个构造函数，把 new 出来的实例攒起来，
 * 之后用实例自带的 seek() / setSpeed() / setVolume() 等方法控制。
 * 如果某个课程用的是保利威/CC视频（原生 <video>），脚本会自动退回原生控制。
 */

(function () {
  'use strict';

  if (window.__mfcPlayerHooked) return;
  window.__mfcPlayerHooked = true;

  const VERSION = '1.1.1';
  const ACCENT = '#FB7299'; // B 站粉

  // ==========================================================================
  // 一、配置
  // ==========================================================================
  const DEFAULTS = {
    enabled: true,       // 总开关，Alt+P
    seekStep: 5,         // ← / → 每次快退、快进的秒数（B 站默认 5 秒）
    boostRate: 3,        // 按住 → 时的倍速
    holdDelay: 260,      // 按住多久（毫秒）进入「倍速 / 连续快退」
    volumeStep: 0.05,    // ↑ / ↓ 每次调节的音量
    rateStep: 0.25,      // Shift+, / Shift+. 每次调节的倍速
    minRate: 0.5,
    maxRate: 8,
    showOsd: true        // 是否显示屏幕提示
  };

  const STORE_KEY = 'mfc-player-config';
  const cfg = Object.assign({}, DEFAULTS, loadConfig());

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveConfig() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
    } catch (e) {}
  }

  // ==========================================================================
  // 二、小工具
  // ==========================================================================
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** 按键连发节流：同一个名字在 ms 内只放行一次 */
  const throttleAt = Object.create(null);
  function throttle(name, ms) {
    const now = Date.now();
    if (throttleAt[name] && now - throttleAt[name] < (ms || 140)) return false;
    throttleAt[name] = now;
    return true;
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    try {
      if (el.closest('[contenteditable="true"],.wangEditor-container,.el-textarea,.el-input')) return true;
    } catch (e) {}
    return false;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.height < 56) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0;
    } catch (e) {
      return false;
    }
  }

  // ==========================================================================
  // 三、播放器桥接：捕获百家云 BPlayer 实例 + 原生 video 兜底
  // ==========================================================================

  /** 已创建的 BPlayer 实例（新的在后面） */
  const bplayerInstances = [];

  function rememberBPlayer(inst) {
    if (!inst || typeof inst !== 'object') return;
    if (bplayerInstances.indexOf(inst) >= 0) return;
    bplayerInstances.push(inst);
    if (bplayerInstances.length > 12) bplayerInstances.shift();
  }

  /**
   * 劫持 window.xxx 上的构造函数/工厂函数，把创建出来的实例记下来。
   * 用 Proxy 而不是简单包一层，这样 new 和普通调用都能原样透传。
   */
  function hookGlobal(name) {
    const wrap = (fn) => {
      if (typeof fn !== 'function' || fn.__mfcWrapped) return fn;
      let proxy;
      try {
        proxy = new Proxy(fn, {
          apply(target, thisArg, args) {
            const ret = Reflect.apply(target, thisArg, args);
            try {
              rememberBPlayer(ret);
              if (ret && typeof ret.getPlayer === 'function') rememberBPlayer(ret.getPlayer());
            } catch (e) {}
            return ret;
          },
          construct(target, args, newTarget) {
            const ret = Reflect.construct(target, args, newTarget);
            try {
              rememberBPlayer(ret);
              if (ret && typeof ret.getPlayer === 'function') rememberBPlayer(ret.getPlayer());
            } catch (e) {}
            return ret;
          }
        });
      } catch (e) {
        return fn;
      }
      proxy.__mfcWrapped = true;
      return proxy;
    };

    let current = window[name];
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get() {
          return current;
        },
        set(v) {
          current = wrap(v);
        }
      });
    } catch (e) {
      // 不允许重定义时，至少把已经挂上的包一层
      if (current) window[name] = wrap(current);
    }
  }

  hookGlobal('BPlayer');

  function bplayerRoot(inst) {
    const opts = inst.options || {};
    let el = inst.container || opts.container || opts.wrap || null;
    if (typeof el === 'string') {
      try {
        el = document.querySelector(el);
      } catch (e) {
        el = null;
      }
    }
    if (el && el.nodeType === 1) return el;
    // 实在拿不到容器就用画布找
    return document.querySelector('.bplayer-wrap');
  }

  function activeBPlayer() {
    for (let i = bplayerInstances.length - 1; i >= 0; i--) {
      const inst = bplayerInstances[i];
      if (!inst || inst.__mfcDestroyed) continue;
      const el = bplayerRoot(inst);
      if (el && isVisible(el)) return inst;
    }
    return null;
  }

  // ---- 原生 video 兜底（保利威 / CC视频）------------------------------------
  const PLAYER_SELECTOR = '.pv-video-player,.pv-video-wrap,.ccH5playerBox,#player,#resource_player';

  function collectVideos(root, out, depth) {
    if (!root || depth > 2) return out;
    let list = [];
    try {
      list = root.querySelectorAll('video');
    } catch (e) {}
    for (let i = 0; i < list.length; i++) out.push(list[i]);
    let all = [];
    try {
      all = root.querySelectorAll('*');
    } catch (e) {}
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el.shadowRoot) collectVideos(el.shadowRoot, out, depth + 1);
    }
    return out;
  }

  let videoCacheAt = 0;
  let videoCache = null;

  function pickVideo() {
    const now = Date.now();
    if (videoCache && now - videoCacheAt < 400 && videoCache.isConnected) return videoCache;

    const all = collectVideos(document, [], 0);
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < all.length; i++) {
      const v = all[i];
      if (!isVisible(v)) continue;
      let score = 0;
      try {
        if (v.closest(PLAYER_SELECTOR)) score += 1000;
      } catch (e) {}
      if (!v.paused && v.readyState >= 2) score += 120;
      const r = v.getBoundingClientRect();
      score += Math.min((r.width * r.height) / 5000, 50);
      if (v.currentTime > 0.5) score += 20;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    videoCache = best;
    videoCacheAt = now;
    return best;
  }

  // ---- 适配器 --------------------------------------------------------------
  function bplayerAdapter(inst) {
    const root = bplayerRoot(inst);
    return {
      kind: 'bplayer',
      raw: inst,
      el: root,
      duration() {
        const d = Number(inst.duration);
        return isFinite(d) && d > 0 ? d : 0;
      },
      time() {
        const t = Number(inst.currentTime);
        return isFinite(t) ? t : 0;
      },
      seek(t) {
        const wasPaused = !!inst.paused;
        try {
          inst.seek(t);
        } catch (e) {
          return false;
        }
        // 百家云的 seek() 会自动 resume，暂停状态下要再按回去
        if (wasPaused) keepPaused(this);
        return true;
      },
      play() {
        try {
          inst.play();
        } catch (e) {}
      },
      pause() {
        try {
          inst.pause();
        } catch (e) {}
      },
      paused() {
        return !!inst.paused;
      },
      ended() {
        return !!inst.ended;
      },
      rate() {
        try {
          const v = inst.video;
          if (v && typeof v.playbackRate === 'number' && v.playbackRate > 0) return v.playbackRate;
          if (typeof inst.speed === 'number' && inst.speed > 0) return inst.speed;
        } catch (e) {}
        return 1;
      },
      setRate(r) {
        const opts = inst.options || {};
        try {
          // 百家云 playbackRate 的 setter 只认 rateList 里的值，
          // 而站点会根据课程设置把 rateList 清空（禁止倍速）。
          // 这里先把目标速率塞进白名单，它自己的 ratechange 监听就不会把速率改回去了。
          const list = opts.rateList;
          if (Array.isArray(list) && list.indexOf(r) === -1) list.push(r);

          // 0.5~2x 走官方接口：会同步倍速菜单的高亮和记忆
          if (r >= 0.5 && r <= 2 && typeof inst.setSpeed === 'function') {
            inst.setSpeed(r);
            if (inst.video && Math.abs(inst.video.playbackRate - r) > 0.001) inst.video.playbackRate = r;
            return true;
          }

          // 更高倍速官方接口写死上限 2，只能直接改底层
          if (inst.video) inst.video.playbackRate = r;
          if (opts.showAudioMode && inst.audio) inst.audio.playbackRate = r;
          inst.speed = r;
          try {
            if (inst.template && typeof inst.template.updateSpeedUI === 'function') inst.template.updateSpeedUI();
          } catch (e) {}
          return true;
        } catch (e) {
          try {
            inst.setSpeed(r);
            return true;
          } catch (e2) {
            return false;
          }
        }
      },
      volume() {
        const v = Number(inst.volume);
        return isFinite(v) ? clamp(v, 0, 1) : 0;
      },
      setVolume(v) {
        try {
          inst.setVolume(clamp(v, 0, 1), true, false); // 第三个参数 false = 不弹它自带的提示
        } catch (e) {}
      },
      /** 课程被后台设置成“禁止倍速 / 禁止拖动”时，站点会传 enableDrag:false 并把 rateList 清空 */
      restricted() {
        const opts = inst.options || {};
        if (opts.enableDrag === false) return true;
        if (Array.isArray(opts.rateList) && opts.rateList.length === 0) return true;
        return false;
      },
      toggleFullscreen() {
        try {
          const p = inst.setFullScreen();
          if (p && p.catch) p.catch(() => {});
        } catch (e) {}
      }
    };
  }

  function videoAdapter(v) {
    return {
      kind: 'video',
      raw: v,
      el: v,
      duration() {
        const d = Number(v.duration);
        return isFinite(d) && d > 0 ? d : 0;
      },
      time() {
        return isFinite(v.currentTime) ? v.currentTime : 0;
      },
      seek(t) {
        try {
          v.currentTime = t;
          return true;
        } catch (e) {
          return false;
        }
      },
      play() {
        try {
          const p = v.play();
          if (p && p.catch) p.catch(() => {});
        } catch (e) {}
      },
      pause() {
        try {
          v.pause();
        } catch (e) {}
      },
      paused() {
        return !!v.paused;
      },
      ended() {
        return !!v.ended;
      },
      rate() {
        return v.playbackRate || 1;
      },
      setRate(r) {
        try {
          v.playbackRate = r;
          return true;
        } catch (e) {
          return false;
        }
      },
      volume() {
        return v.muted ? 0 : clamp(v.volume, 0, 1);
      },
      setVolume(vol) {
        try {
          v.muted = false;
          v.volume = clamp(vol, 0, 1);
        } catch (e) {}
      },
      toggleFullscreen() {
        const el = v.closest('.pv-video-player,.pv-video-wrap,.ccH5playerBox,#player,#resource_player') || v.parentElement;
        if (!el) return;
        const fs = document.fullscreenElement || document.webkitFullscreenElement;
        try {
          if (fs) {
            (document.exitFullscreen || document.webkitExitFullscreen).call(document);
          } else {
            const req = el.requestFullscreen || el.webkitRequestFullscreen;
            const p = req.call(el);
            if (p && p.catch) p.catch(() => {});
          }
        } catch (e) {}
      },
      restricted() {
        return false;
      }
    };
  }

  let refreshHinted = false;

  function getPlayer() {
    const bp = activeBPlayer();
    if (bp) {
      lastPlayerRef = bplayerAdapter(bp);
      return lastPlayerRef;
    }
    const v = pickVideo();
    if (v) {
      lastPlayerRef = videoAdapter(v);
      return lastPlayerRef;
    }
    // 百家云播放器已经在页面上了，但没抓到实例 => 脚本是装好之后才生效的，需要刷新一次
    if (!refreshHinted && bplayerInstances.length === 0 && document.querySelector('.bplayer-wrap')) {
      refreshHinted = true;
      setTimeout(() => {
        showToast('refresh', `${ICON.play}<span>快捷键需要刷新一次页面才能接管播放器</span>`, { pos: 'top', duration: 4000 });
      }, 800);
    }
    return null;
  }

  // ==========================================================================
  // 四、屏幕提示（OSD）
  // ==========================================================================
  const OSD_ID = 'mfc-osd-root';
  const ICON = {
    left: '<svg viewBox="0 0 24 24"><path d="M11 6v12L2 12l9-6zm11 0v12l-9-6 9-6z"/></svg>',
    right: '<svg viewBox="0 0 24 24"><path d="M13 6v12l9-6-9-6zM2 6v12l9-6-9-6z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.54.84l11.5-7.5a1 1 0 0 0 0-1.68L8.54 3.66A1 1 0 0 0 7 4.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 4h3.2v16H7zm6.8 0H17v16h-3.2z"/></svg>',
    volume: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>',
    mute: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4zm15.3 3 2.2-2.2-1.4-1.4L18 10.6l-2.2-2.2-1.4 1.4L16.6 12l-2.2 2.2 1.4 1.4L18 13.4l2.2 2.2 1.4-1.4L19.3 12z"/></svg>',
    speed: '<svg viewBox="0 0 24 24"><path d="M12 4a9 9 0 1 0 8.94 10.1h-2.03A7 7 0 1 1 12 6v3l4-4-4-4v3zm1.4 5.6a1.8 1.8 0 1 0-2.55 2.55L12 18l1.4-1.4V9.6z"/></svg>',
    fs: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5v2H6v3H4zm11-5h5v5h-2V6h-3V4zM4 15h2v3h3v2H4v-5zm14 0h2v5h-5v-2h3v-3z"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><path d="M12 8.5A3.5 3.5 0 1 0 15.5 12 3.5 3.5 0 0 0 12 8.5zm9.2 3.5a7.6 7.6 0 0 0-.1-1.2l2-1.5-2-3.4-2.4 1a7.4 7.4 0 0 0-2-1.2L16.3 3h-4l-.4 2.7a7.4 7.4 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 2.4l-2 1.5 2 3.4 2.4-1a7.4 7.4 0 0 0 2 1.2l.4 2.7h4l.4-2.7a7.4 7.4 0 0 0 2-1.2l2.4 1 2-3.4-2-1.5a7.6 7.6 0 0 0 .1-1.2z"/></svg>'
  };

  const OSD_CSS = `
#${OSD_ID}{position:fixed;inset:0;z-index:2147483600;pointer-events:none;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;text-align:left;direction:ltr}
#${OSD_ID} .mfc-toast{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.94);
  display:flex;align-items:center;gap:10px;padding:12px 20px;border-radius:999px;
  background:rgba(20,20,24,.84);color:#fff;font-size:15px;font-weight:500;line-height:1;
  letter-spacing:.2px;white-space:nowrap;box-shadow:0 8px 28px rgba(0,0,0,.35);
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
  border:1px solid rgba(255,255,255,.08);opacity:0;transition:opacity .16s ease,transform .16s ease}
#${OSD_ID} .mfc-toast.mfc-show{opacity:1;transform:translate(-50%,-50%) scale(1)}
#${OSD_ID} .mfc-accent{color:${ACCENT}}
#${OSD_ID} .mfc-sub{font-size:13px;font-weight:400;color:rgba(255,255,255,.6);margin-left:2px}
#${OSD_ID} .mfc-big{font-size:21px;font-weight:600;font-variant-numeric:tabular-nums}
#${OSD_ID} .mfc-num{font-variant-numeric:tabular-nums}
#${OSD_ID} svg{width:18px;height:18px;display:block;fill:currentColor;flex:none}
#${OSD_ID} .mfc-icon-big svg{width:30px;height:30px}
#${OSD_ID} .mfc-bar{width:80px;height:4px;border-radius:2px;background:rgba(255,255,255,.24);overflow:hidden}
#${OSD_ID} .mfc-bar i{display:block;height:100%;background:#fff;border-radius:2px;transition:width .1s linear}
#${OSD_ID} .mfc-boost{background:rgba(251,114,153,.94);border-color:rgba(255,255,255,.25)}
#${OSD_ID} .mfc-panel{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  pointer-events:auto;min-width:328px;max-width:min(86vw,430px);padding:20px 22px 18px;border-radius:16px;
  background:rgba(22,22,26,.95);color:#fff;box-shadow:0 18px 48px rgba(0,0,0,.5);
  -webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);
  border:1px solid rgba(255,255,255,.1);font-size:14px;opacity:0;transition:opacity .18s ease}
#${OSD_ID} .mfc-panel.mfc-show{opacity:1}
#${OSD_ID} .mfc-panel h4{margin:0 0 14px;font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px}
#${OSD_ID} .mfc-panel h4 em{font-style:normal;font-size:11px;font-weight:500;color:rgba(255,255,255,.45);letter-spacing:.4px}
#${OSD_ID} .mfc-panel h4 .mfc-x{margin-left:auto;cursor:pointer;opacity:.55;padding:2px}
#${OSD_ID} .mfc-panel h4 .mfc-x:hover{opacity:1}
#${OSD_ID} .mfc-help-dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:9px 16px;align-items:center}
#${OSD_ID} .mfc-help-dl dt{margin:0;text-align:right;white-space:nowrap}
#${OSD_ID} .mfc-help-dl dd{margin:0;color:rgba(255,255,255,.78)}
#${OSD_ID} kbd{display:inline-block;min-width:20px;padding:3px 7px;margin-left:3px;border-radius:5px;
  background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);border-bottom-width:2px;
  font-family:inherit;font-size:12px;line-height:1.1;text-align:center;color:#fff}
#${OSD_ID} .mfc-row{display:flex;align-items:center;gap:10px;margin:0 0 12px}
#${OSD_ID} .mfc-row label{flex:1;color:rgba(255,255,255,.82);font-size:13px}
#${OSD_ID} .mfc-row input[type=number]{width:76px;padding:7px 9px;border-radius:8px;
  border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.08);color:#fff;font-size:13px;outline:none}
#${OSD_ID} .mfc-row input[type=number]:focus{border-color:${ACCENT}}
#${OSD_ID} .mfc-row .mfc-unit{font-size:12px;color:rgba(255,255,255,.42);width:22px}
#${OSD_ID} .mfc-switch{position:relative;width:40px;height:22px;border-radius:11px;background:rgba(255,255,255,.2);cursor:pointer;transition:background .15s}
#${OSD_ID} .mfc-switch.on{background:${ACCENT}}
#${OSD_ID} .mfc-switch i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
#${OSD_ID} .mfc-switch.on i{left:21px}
#${OSD_ID} .mfc-actions{display:flex;gap:10px;margin-top:16px}
#${OSD_ID} .mfc-btn{flex:1;padding:9px 0;border-radius:9px;border:none;cursor:pointer;font-size:13px;font-weight:500;
  font-family:inherit;background:rgba(255,255,255,.12);color:#fff;transition:background .15s}
#${OSD_ID} .mfc-btn:hover{background:rgba(255,255,255,.2)}
#${OSD_ID} .mfc-btn.primary{background:${ACCENT};color:#fff}
#${OSD_ID} .mfc-btn.primary:hover{background:#fc85a8}
#${OSD_ID} .mfc-hint{margin-top:12px;font-size:12px;color:rgba(255,255,255,.42);line-height:1.5}
`;

  let osdEl = null;

  function osd() {
    if (osdEl && osdEl.isConnected) return osdEl;
    osdEl = document.createElement('div');
    osdEl.id = OSD_ID;
    osdEl.setAttribute('aria-hidden', 'true');
    const style = document.createElement('style');
    style.textContent = OSD_CSS;
    osdEl.appendChild(style);
    (document.body || document.documentElement).appendChild(osdEl);

    const reparent = () => {
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      const target = fs || document.body || document.documentElement;
      if (osdEl && osdEl.parentNode !== target) {
        try {
          target.appendChild(osdEl);
        } catch (e) {}
      }
    };
    document.addEventListener('fullscreenchange', reparent, true);
    document.addEventListener('webkitfullscreenchange', reparent, true);
    return osdEl;
  }

  const toasts = Object.create(null);

  let lastPlayerRef = null;

  /** 提示浮层的定位基准：优先贴着播放器，找不到就用整个视口 */
  function anchorRect() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const p = lastPlayerRef;
    const el = p && p.el;
    if (el && el.isConnected) {
      const r = el.getBoundingClientRect();
      if (r.width > 200 && r.height > 110) return r;
    }
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  function placeToast(el, pos) {
    if (!el) return;
    const r = anchorRect();
    const pad = 70;
    let x = r.left + r.width / 2;
    let y = r.top + r.height / 2;
    if (pos === 'bottom') y = r.top + r.height - Math.min(96, Math.max(52, r.height * 0.13));
    else if (pos === 'top') y = r.top + Math.min(96, Math.max(52, r.height * 0.12));
    x = clamp(x, 90, Math.max(90, window.innerWidth - 90));
    y = clamp(y, pad, Math.max(pad, window.innerHeight - pad));
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
  }

  function showToast(id, html, opts) {
    if (!cfg.showOsd) return;
    const o = opts || {};
    let item = toasts[id];
    if (!item || !item.el || !item.el.isConnected) {
      const el = document.createElement('div');
      osd().appendChild(el);
      item = { el, timer: 0 };
      toasts[id] = item;
    }
    item.el.className = 'mfc-toast' + (o.cls ? ' ' + o.cls : '');
    item.el.innerHTML = html;
    placeToast(item.el, o.pos);
    item.el.classList.remove('mfc-show');
    void item.el.offsetWidth; // 强制重排，让连续按键时也能看到“弹一下”
    item.el.classList.add('mfc-show');

    clearTimeout(item.timer);
    if (o.sticky) return;
    item.timer = setTimeout(() => hideToast(id), o.duration || 700);
  }

  function hideToast(id) {
    const item = toasts[id];
    if (!item) return;
    clearTimeout(item.timer);
    item.el.classList.remove('mfc-show');
    const el = item.el;
    setTimeout(() => {
      if (el && el.isConnected) el.remove();
    }, 200);
    delete toasts[id];
  }

  // ==========================================================================
  // 五、播放动作
  // ==========================================================================
  let lastVolume = 0.7;

  // ---- 暂停守护：百家云 seek 后会自动续播，这里把它按回去 ---------------------
  let pauseGuard = { token: 0, timer: 0 };

  function keepPaused(p) {
    pauseGuard.token++;
    const token = pauseGuard.token;
    const until = Date.now() + 1200;
    clearInterval(pauseGuard.timer);
    pauseGuard.timer = setInterval(() => {
      if (token !== pauseGuard.token || Date.now() > until) {
        clearInterval(pauseGuard.timer);
        pauseGuard.timer = 0;
        return;
      }
      if (!p.paused()) p.pause();
    }, 120);
  }

  function cancelKeepPaused() {
    pauseGuard.token++;
    clearInterval(pauseGuard.timer);
    pauseGuard.timer = 0;
  }

  function seekBy(p, delta) {
    if (!p) return false;
    const dur = p.duration();
    const cur = p.time();
    let target = cur + delta;
    if (dur > 0) target = clamp(target, 0, Math.max(0, dur - 0.12));
    else target = Math.max(0, target);
    if (Math.abs(target - cur) < 0.02) return false;
    const ok = p.seek(target);
    if (ok) showSeekToast(p, delta, target);
    return ok;
  }

  function showSeekToast(p, delta, target) {
    const forward = delta > 0;
    const dur = p.duration();
    const at = typeof target === 'number' ? target : p.time();
    const timeHtml = `<span class="mfc-num">${fmtTime(at)}</span>` + (dur > 0 ? `<span class="mfc-sub"> / ${fmtTime(dur)}</span>` : '');
    showToast('seek', `${forward ? ICON.right : ICON.left}<span>${forward ? '快进' : '快退'} <b class="mfc-accent">${Math.abs(Math.round(delta))}</b> 秒</span><span class="mfc-sub">${timeHtml}</span>`, {
      duration: 620
    });
  }

  function togglePlay(p) {
    if (!p) return;
    cancelKeepPaused();
    if (p.paused()) {
      p.play();
      showToast('play', `${ICON.play}<span>播放</span>`, { duration: 420, cls: 'mfc-icon-big' });
    } else {
      p.pause();
      showToast('play', `${ICON.pause}<span>暂停</span>`, { duration: 420, cls: 'mfc-icon-big' });
    }
  }

  function showVolumeToast(p) {
    const v = p.volume();
    if (v > 0) lastVolume = v;
    const pct = Math.round(v * 100);
    showToast('volume', `${v > 0 ? ICON.volume : ICON.mute}<span class="mfc-num" style="min-width:34px;display:inline-block;text-align:right">${pct}%</span><span class="mfc-bar"><i style="width:${pct}%"></i></span>`, {
      pos: 'bottom',
      duration: 700
    });
  }

  function changeVolume(p, delta) {
    if (!p) return;
    p.setVolume(clamp(p.volume() + delta, 0, 1));
    showVolumeToast(p);
  }

  function toggleMute(p) {
    if (!p) return;
    if (p.volume() > 0) {
      lastVolume = p.volume();
      p.setVolume(0);
    } else {
      p.setVolume(lastVolume || 0.7);
    }
    showVolumeToast(p);
  }

  function setRate(p, rate, opts) {
    if (!p) return;
    const r = Math.round(clamp(rate, cfg.minRate, cfg.maxRate) * 100) / 100;
    if (!p.setRate(r)) return;
    if (!opts || !opts.silent) {
      showToast('rate', `${ICON.speed}<span class="mfc-big mfc-accent">${r.toFixed(2).replace(/0$/, '').replace(/\.$/, '')}x</span><span class="mfc-sub">倍速</span>`, {
        duration: 900
      });
    }
  }

  function nudge(p, dir) {
    if (!p) return;
    seekBy(p, dir);
  }

  // ---- 倍速快放（按住 →）-----------------------------------------------------
  const boost = { active: false, p: null, rate: 1, baseRate: 1, timer: 0, key: null };

  function startBoost(p, key) {
    if (!p || boost.active) return;
    if (p.paused() || p.ended()) return;
    boost.active = true;
    boost.p = p;
    boost.key = key || null;
    boost.rate = clamp(cfg.boostRate, 1.25, cfg.maxRate);
    boost.baseRate = p.rate() || 1;
    p.setRate(boost.rate);
    showToast('boost', `${ICON.right}<span class="mfc-big">${boost.rate}x</span><span class="mfc-sub">倍速播放中 · 松开恢复</span>`, {
      pos: 'bottom',
      sticky: true,
      cls: 'mfc-boost'
    });
    clearInterval(boost.timer);
    boost.timer = setInterval(() => {
      if (!boost.active) return;
      const cur = boost.p;
      if (!cur || (cur.el && !cur.el.isConnected)) return stopBoost();
      if (cur.paused() || cur.ended()) return stopBoost();
      // 播放器自己的速率监听可能把速率改回去，这里死死盯住
      if (Math.abs(cur.rate() - boost.rate) > 0.01) cur.setRate(boost.rate);
    }, 150);
  }

  function stopBoost() {
    if (!boost.active) return;
    const p = boost.p;
    boost.active = false;
    clearInterval(boost.timer);
    boost.timer = 0;
    boost.p = null;
    boost.key = null;
    hideToast('boost');
    if (p) p.setRate(boost.baseRate || 1, { silent: true });
  }

  // ---- 全屏 / 网页全屏 -------------------------------------------------------
  let webFsEl = null;
  let webFsSaved = null;

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function exitFullscreen() {
    try {
      if (document.exitFullscreen) {
        const r = document.exitFullscreen();
        if (r && r.catch) r.catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    } catch (e) {}
  }

  function toggleFullscreen(p) {
    if (!p) return;
    if (isFullscreen()) {
      exitFullscreen();
      return;
    }
    if (webFsEl) toggleWebFullscreen(p);
    p.toggleFullscreen();
  }

  function toggleWebFullscreen(p) {
    if (!p) return;
    if (isFullscreen()) return;
    if (webFsEl) {
      try {
        if (webFsSaved) webFsEl.style.cssText = webFsSaved.css;
        document.body.style.overflow = webFsSaved ? webFsSaved.bodyOverflow : '';
      } catch (e) {}
      webFsEl = null;
      webFsSaved = null;
      showToast('webfs', `${ICON.fs}<span class="mfc-sub">退出网页全屏</span>`, { duration: 600 });
      return;
    }
    const el = p.el;
    if (!el) return;
    webFsSaved = { css: el.style.cssText, bodyOverflow: document.body.style.overflow };
    el.style.cssText +=
      ';position:fixed!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;' +
      'margin:0!important;z-index:2147483000!important;background:#000!important;border-radius:0!important;';
    document.body.style.overflow = 'hidden';
    webFsEl = el;
    showToast('webfs', `${ICON.fs}<span class="mfc-sub">网页全屏 · 再按 W 退出</span>`, { duration: 900 });
  }

  // ==========================================================================
  // 六、键盘
  // ==========================================================================
  const hold = { key: null, timer: 0, repeat: 0, mode: null };

  // 这些键属于“快进 / 变速”，课程禁止时会被关掉
  const RESTRICTED_KEYS = { ArrowLeft: 1, ArrowRight: 1, Comma: 1, Period: 1 };
  const restrictedNoticedFor = new WeakSet();

  // 自己维护的“按键是否还按着”，不依赖 event.repeat
  const pressedKeys = Object.create(null);
  const REPEAT_TRACKED = { Space: 1, KeyK: 1, ArrowRight: 1, ArrowLeft: 1, KeyM: 1, KeyF: 1, KeyW: 1, KeyT: 1 };

  function isRepeatPress(code) {
    const wasDown = !!pressedKeys[code];
    pressedKeys[code] = 1;
    return wasDown;
  }

  function resetPressedKeys() {
    for (const k in pressedKeys) delete pressedKeys[k];
  }

  function noticeRestricted(p) {
    const inst = p && p.raw;
    if (inst && typeof inst === 'object') {
      if (restrictedNoticedFor.has(inst)) return;
      restrictedNoticedFor.add(inst);
    }
    showToast('restricted', `${ICON.speed}<span>本课程设置为<b class="mfc-accent">禁止快进 / 倍速</b></span>`, {
      pos: 'bottom',
      duration: 2600
    });
  }

  function clearHold() {
    clearTimeout(hold.timer);
    clearInterval(hold.repeat);
    hold.key = null;
    hold.timer = 0;
    hold.repeat = 0;
    hold.mode = null;
    stopBoost();
  }

  /**
   * 方向键的“短按 / 长按”判定：
   *   按下时先不跳转，只起一个定时器；
   *   到点还没松手 => 长按（→ 倍速、← 连续快退），全程不额外跳转；
   *   提前松手     => 短按，在松手那一刻跳 step 秒。
   * 这样“按住 → 只加速”才不会被开头那一下 +5 秒污染。
   */
  function beginHold(code) {
    const p = getPlayer();
    if (!p) return;
    // 另一个方向键正在倍速 -> 先把它停掉，避免两个键抢状态把倍速卡住
    if (boost.active) stopBoost();
    hold.key = code;
    hold.mode = null;
    clearTimeout(hold.timer);
    clearInterval(hold.repeat);
    hold.timer = setTimeout(() => {
      if (hold.key !== code) return;
      const cur = getPlayer();
      if (!cur) return;
      hold.mode = 'hold';
      const forward = code === 'ArrowRight';
      if (forward && !cur.paused() && !cur.ended()) startBoost(cur, code); // 播放中按住 →：只加速
      else startRepeatSeek(cur, forward ? cfg.seekStep : -cfg.seekStep); // ← 或暂停中：连续快进/快退
    }, cfg.holdDelay);
  }

  function startRepeatSeek(p, delta) {
    clearInterval(hold.repeat);
    let lastAt = 0;
    hold.repeat = setInterval(() => {
      const cur = getPlayer();
      if (!cur) return clearHold();
      const now = Date.now();
      if (now - lastAt < 190) return;
      lastAt = now;
      seekBy(cur, delta);
    }, 60);
  }

  function onKeyDown(e) {
    if (e.isComposing) return;

    const code = e.code;

    // ---- 脚本自己的组合键 ----
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      if (code === 'KeyH') {
        e.preventDefault();
        e.stopPropagation();
        openPanel('help');
        return;
      }
      if (code === 'KeyO') {
        e.preventDefault();
        e.stopPropagation();
        openPanel('settings');
        return;
      }
      if (code === 'KeyP') {
        e.preventDefault();
        e.stopPropagation();
        cfg.enabled = !cfg.enabled;
        saveConfig();
        if (!cfg.enabled) clearHold();
        showToast('toggle', cfg.enabled ? `${ICON.play}<span>快捷控制已开启</span>` : `${ICON.pause}<span class="mfc-sub">快捷控制已停用</span>`, {
          pos: 'top',
          duration: 1300
        });
        return;
      }
      return;
    }

    if (!cfg.enabled) return;
    if (e.ctrlKey || e.metaKey) return;
    if (isEditable(e.target) || isEditable(document.activeElement)) return;

    // 面板打开时只处理 Esc
    if (panelEl && panelEl.classList.contains('mfc-show')) {
      if (code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePanel();
      }
      return;
    }

    const p = getPlayer();
    if (!p) return;

    const eat = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    // 自己的连发判定：不信任 event.repeat —— 某些输入法/其他扩展吃掉 keyup 后，
    // 浏览器会给下一次真实按下也打上 repeat 标记，那就会导致方向键“按了没反应”。
    const repeat = REPEAT_TRACKED[code] ? isRepeatPress(code) : false;

    // 课程禁止快进 / 倍速时，尊重平台设置：这些键只提示、不执行
    if (RESTRICTED_KEYS[code] && typeof p.restricted === 'function' && p.restricted()) {
      eat();
      noticeRestricted(p);
      return;
    }

    switch (code) {
      case 'Space':
      case 'KeyK': {
        eat();
        if (repeat) return;
        togglePlay(p);
        return;
      }
      case 'ArrowRight': {
        eat();
        if (repeat) return;
        beginHold('ArrowRight');
        return;
      }
      case 'ArrowLeft': {
        eat();
        if (repeat) return;
        beginHold('ArrowLeft');
        return;
      }
      case 'ArrowUp': {
        eat();
        if (e.shiftKey) return;
        changeVolume(p, cfg.volumeStep);
        return;
      }
      case 'ArrowDown': {
        eat();
        if (e.shiftKey) return;
        changeVolume(p, -cfg.volumeStep);
        return;
      }
      case 'KeyM': {
        eat();
        if (repeat) return;
        toggleMute(p);
        return;
      }
      case 'KeyF': {
        eat();
        if (repeat) return;
        toggleFullscreen(p);
        return;
      }
      case 'KeyW':
      case 'KeyT': {
        eat();
        if (repeat) return;
        toggleWebFullscreen(p);
        return;
      }
      case 'Escape': {
        if (isFullscreen() || webFsEl) {
          eat();
          if (webFsEl) toggleWebFullscreen(p);
          else exitFullscreen();
        }
        return;
      }
      case 'Comma': {
        eat();
        if (e.shiftKey) {
          if (throttle('rate')) setRate(p, p.rate() - cfg.rateStep);
        } else if (throttle('nudge', 160)) {
          nudge(p, -1);
        }
        return;
      }
      case 'Period': {
        eat();
        if (e.shiftKey) {
          if (throttle('rate')) setRate(p, p.rate() + cfg.rateStep);
        } else if (throttle('nudge', 160)) {
          nudge(p, 1);
        }
        return;
      }
      default:
        return;
    }
  }

  function onKeyUp(e) {
    const code = e.code;
    delete pressedKeys[code];
    if (code !== 'ArrowRight' && code !== 'ArrowLeft') return;

    // 这个键开启的倍速：哪怕 hold 状态被另一个键顶掉，也要在它松开时停掉
    if (boost.active && boost.key === code) {
      clearHold();
      return;
    }
    if (hold.key !== code) return;

    const wasTap = hold.mode === null; // 没进入长按 => 短按
    const p = getPlayer();
    clearHold();
    if (!wasTap || !p) return;

    seekBy(p, code === 'ArrowRight' ? cfg.seekStep : -cfg.seekStep); // 里面带提示浮层
  }

  // ==========================================================================
  // 七、帮助 / 设置面板
  // ==========================================================================
  let panelEl = null;

  function ensurePanel() {
    if (panelEl && panelEl.isConnected) return panelEl;
    panelEl = document.createElement('div');
    panelEl.className = 'mfc-panel';
    osd().appendChild(panelEl);
    panelEl.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('.mfc-x')) return closePanel();
      const sw = t.closest('.mfc-switch');
      if (sw) {
        sw.classList.toggle('on');
        return;
      }
      const btn = t.closest('.mfc-btn');
      if (btn) {
        const act = btn.dataset.act;
        if (act === 'save') applySettings();
        else if (act === 'reset') resetSettings();
        else if (act === 'close') closePanel();
        else if (act === 'settings') openPanel('settings');
      }
    });
    return panelEl;
  }

  function closePanel() {
    if (panelEl) panelEl.classList.remove('mfc-show');
  }

  function openPanel(kind) {
    const el = ensurePanel();
    if (kind === 'help') {
      el.innerHTML = `
        <h4>${ICON.play} 播 放 快 捷 键 <em>研优课 · B站式 v${VERSION}</em>
          <span class="mfc-x" title="关闭">✕</span></h4>
        <dl class="mfc-help-dl">
          <dt><kbd>空格</kbd><kbd>K</kbd></dt><dd>播放 / 暂停</dd>
          <dt><kbd>←</kbd><kbd>→</kbd></dt><dd>轻按：快退 / 快进 ${cfg.seekStep} 秒</dd>
          <dt>按住 <kbd>→</kbd></dt><dd><b style="color:${ACCENT}">${cfg.boostRate}x</b> 倍速快放（不跳转），松开即恢复</dd>
          <dt>按住 <kbd>←</kbd></dt><dd>连续快退</dd>
          <dt><kbd>↑</kbd><kbd>↓</kbd></dt><dd>音量加减（每次 ${Math.round(cfg.volumeStep * 100)}%）</dd>
          <dt><kbd>M</kbd></dt><dd>静音 / 取消静音</dd>
          <dt><kbd>F</kbd></dt><dd>全屏 / 退出全屏</dd>
          <dt><kbd>W</kbd></dt><dd>网页全屏（沉浸模式）</dd>
          <dt><kbd>Shift</kbd>+<kbd>,</kbd><kbd>.</kbd></dt><dd>减速 / 加速（每次 ${cfg.rateStep}x）</dd>
          <dt><kbd>,</kbd><kbd>.</kbd></dt><dd>微调 1 秒（暂停时找位置很好用）</dd>
          <dt><kbd>Alt</kbd>+<kbd>O</kbd></dt><dd>设置</dd>
          <dt><kbd>Alt</kbd>+<kbd>H</kbd></dt><dd>显示 / 关闭本帮助</dd>
          <dt><kbd>Alt</kbd>+<kbd>P</kbd></dt><dd>临时停用 / 启用</dd>
        </dl>
        <div class="mfc-hint">课程被设置为「禁止快进 / 禁止倍速」时，快进和变速会自动关闭，只保留播放、音量、全屏。</div>
        <div class="mfc-actions">
          <button class="mfc-btn" data-act="settings">修改设置</button>
          <button class="mfc-btn primary" data-act="close">知道了</button>
        </div>`;
    } else {
      el.innerHTML = `
        <h4>${ICON.gear} 设 置 <em>v${VERSION}</em><span class="mfc-x" title="关闭">✕</span></h4>
        <div class="mfc-row"><label>快退 / 快进秒数</label>
          <input type="number" id="mfc-i-seek" min="1" max="120" step="1" value="${cfg.seekStep}"><span class="mfc-unit">秒</span></div>
        <div class="mfc-row"><label>按住 → 的倍速</label>
          <input type="number" id="mfc-i-boost" min="1.25" max="8" step="0.25" value="${cfg.boostRate}"><span class="mfc-unit">x</span></div>
        <div class="mfc-row"><label>长按触发时间</label>
          <input type="number" id="mfc-i-delay" min="80" max="1500" step="20" value="${cfg.holdDelay}"><span class="mfc-unit">ms</span></div>
        <div class="mfc-row"><label>音量步长</label>
          <input type="number" id="mfc-i-vol" min="1" max="50" step="1" value="${Math.round(cfg.volumeStep * 100)}"><span class="mfc-unit">%</span></div>
        <div class="mfc-row"><label>屏幕提示浮层</label>
          <div class="mfc-switch ${cfg.showOsd ? 'on' : ''}" id="mfc-i-osd"><i></i></div></div>
        <div class="mfc-actions">
          <button class="mfc-btn" data-act="reset">恢复默认</button>
          <button class="mfc-btn primary" data-act="save">保存</button>
        </div>
        <div class="mfc-hint">设置保存在本机浏览器里，改完立即生效，不影响课程本身。</div>`;
    }
    // 面板贴着播放器居中，同时保证整块面板不会跑出屏幕
    const r = anchorRect();
    const pw = el.offsetWidth || 360;
    const ph = el.offsetHeight || 420;
    const pad = 16;
    el.style.left = Math.round(clamp(r.left + r.width / 2, pad + pw / 2, Math.max(pad + pw / 2, window.innerWidth - pad - pw / 2))) + 'px';
    el.style.top = Math.round(clamp(r.top + r.height / 2, pad + ph / 2, Math.max(pad + ph / 2, window.innerHeight - pad - ph / 2))) + 'px';
    el.classList.add('mfc-show');
  }

  function applySettings() {
    const num = (id, lo, hi, dflt) => {
      const el = document.getElementById(id);
      const n = el ? parseFloat(el.value) : NaN;
      return isFinite(n) ? clamp(n, lo, hi) : dflt;
    };
    cfg.seekStep = Math.round(num('mfc-i-seek', 1, 120, DEFAULTS.seekStep));
    cfg.boostRate = num('mfc-i-boost', 1.25, 8, DEFAULTS.boostRate);
    cfg.holdDelay = Math.round(num('mfc-i-delay', 80, 1500, DEFAULTS.holdDelay));
    cfg.volumeStep = Math.round(num('mfc-i-vol', 1, 50, DEFAULTS.volumeStep * 100)) / 100;
    const sw = document.getElementById('mfc-i-osd');
    cfg.showOsd = !!(sw && sw.classList.contains('on'));
    saveConfig();
    closePanel();
    showToast('saved', `${ICON.play}<span>设置已保存</span>`, { pos: 'top', duration: 1200 });
  }

  function resetSettings() {
    Object.assign(cfg, DEFAULTS);
    saveConfig();
    openPanel('settings');
    showToast('saved', '<span>已恢复默认设置</span>', { pos: 'top', duration: 1200 });
  }

  // ==========================================================================
  // 八、安装
  // ==========================================================================
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  // 失焦 / 切走时把“按住”状态清干净，避免回来还停在倍速
  const releaseAll = () => {
    clearHold();
    resetPressedKeys();
  };
  window.addEventListener('blur', releaseAll, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAll();
  });

  // 播放器被销毁 / 换集时收尾
  setInterval(() => {
    if (boost.active) {
      const p = boost.p;
      if (!p || (p.el && !p.el.isConnected)) stopBoost();
    }
    // 清理已经不存在的实例，避免数组越来越长
    for (let i = bplayerInstances.length - 1; i >= 0; i--) {
      const inst = bplayerInstances[i];
      const el = inst && bplayerRoot(inst);
      if (!inst || (!el || !el.isConnected) && bplayerInstances.length > 1) {
        // 保留最近一个，其余丢弃
        if (i !== bplayerInstances.length - 1) bplayerInstances.splice(i, 1);
      }
    }
  }, 1500);

  // ---- 首次使用提示 ---------------------------------------------------------
  function firstRun() {
    const flag = 'mfc-player-tipped-' + VERSION;
    try {
      if (localStorage.getItem(flag)) return;
      localStorage.setItem(flag, '1');
    } catch (e) {}
    const run = () => {
      setTimeout(() => {
        showToast('tip', `已启用 <b class="mfc-accent">B 站式快捷键</b><span class="mfc-sub">← → 快退快进 · 按住 → ${cfg.boostRate}x · Alt+H 查看全部</span>`, {
          pos: 'top',
          duration: 4600
        });
      }, 1600);
    };
    if (document.readyState === 'complete') run();
    else window.addEventListener('load', run, { once: true });
  }
  firstRun();

  // 调试用：控制台里 mfcPlayer.cfg / mfcPlayer.player()
  try {
    window.mfcPlayer = {
      cfg,
      version: VERSION,
      player: getPlayer,
      instances: bplayerInstances,
      help: () => openPanel('help'),
      settings: () => openPanel('settings')
    };
  } catch (e) {}
})();
