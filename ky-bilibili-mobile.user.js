// ==UserScript==
// @name         研优课手机版 B 站式手势
// @namespace    https://github.com/ZhuYiXuanNB/bettermfclass
// @version      1.1.0
// @description  给研优课手机版（/wap）的播放器加 B 站移动端风格手势：长按倍速、双击左右快退快进、左右拖动调进度、右半屏上下滑调音量，外加一个倍速角标。倍速严格限定在播放器白名单内（最高 2x），不会触发平台的外部倍速检测。
// @author       ZhuYiXuanNB
// @match        https://ky.mfedu.cn/*
// @run-at       document-start
// @grant        none
// @license      GPL-3.0-or-later
// @supportURL   https://github.com/ZhuYiXuanNB/bettermfclass/issues
// @homepageURL  https://github.com/ZhuYiXuanNB/bettermfclass
// @downloadURL  https://raw.githubusercontent.com/ZhuYiXuanNB/bettermfclass/main/ky-bilibili-mobile.user.js
// @updateURL    https://raw.githubusercontent.com/ZhuYiXuanNB/bettermfclass/main/ky-bilibili-mobile.user.js
// ==/UserScript==

/*
 * 研优课手机版手势（ky-bilibili-mobile）
 * Copyright (C) 2026 ZhuYiXuanNB
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 实现要点
 * ---------------------------------------------------------------------------
 * 手机端（UA 带 Mobile）服务器返回 /wap 下的 uni-app H5 应用，课程播放器仍然是
 * 百家云 BPlayer（手机 SDK 版本 1.10.68，用原生 <video> + MSE 播放）。
 *
 * ⚠️ 手机版 SDK 里有一段防篡改检查（PC 的 latest 版本没有）：
 *      handleRateChange() {
 *        const list = options.rateList || [];
 *        const rate = video.canvas?.playbackRate || video.playbackRate;
 *        if (!list.some(x => x == rate)) { player.pause(); 弹窗「检测到使用外部倍速插件…错误码 1000」 }
 *      }
 *   也就是：**倍速值必须在 options.rateList 白名单里**，否则播放器会被暂停并弹窗。
 *   所以本脚本把所有倍速（含长按倍速）都夹到白名单内（一般最高 2x），
 *   课程没开倍速（白名单为空或只有 1x）时直接禁用倍速功能，只保留手势快进/音量。
 *
 * 手势（模仿 B 站移动端，不做亮度）：
 *   长按画面            → 倍速播放（取白名单内最大档），松手恢复
 *   双击左 / 右三分之一 → 快退 / 快进 10 秒
 *   双击中间            → 播放 / 暂停
 *   横向拖动            → 调进度，松手生效
 *   右半屏纵向拖动      → 音量
 *   角标「1.0x」        → 点一下在白名单内循环切换
 * 单击不处理，交给播放器原本的控件；不铺全屏遮罩，所以底部控件条不会被挡。
 */

(function () {
  'use strict';

  // 只在触摸设备上启用；横屏全屏、竖屏内联都走同一套
  if (!('ontouchstart' in window) && !(navigator.maxTouchPoints > 0)) return;
  if (window.__mfcMobileHooked) return;
  window.__mfcMobileHooked = true;

  const VERSION = '1.1.0';
  const ACCENT = '#FB7299';

  // ==========================================================================
  // 一、配置
  // ==========================================================================
  const DEFAULTS = {
    enabled: true,
    boostRate: 2,          // 长按倍速目标值（最终仍会夹到播放器白名单内）
    longPressMs: 420,      // 长按判定
    seekStep: 10,          // 双击快退/快进秒数
    doubleTapMs: 300,      // 双击判定窗口
    dragFullWidthSeek: 0,  // 0 = 自动（长视频 300s / 短视频 30% 时长）
    showOsd: true
  };

  const STORE_KEY = 'mfc-mobile-config';
  const cfg = Object.assign({}, DEFAULTS, loadCfg());

  function loadCfg() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveCfg() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
    } catch (e) {}
  }

  // ==========================================================================
  // 二、小工具
  // ==========================================================================
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 45) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0;
    } catch (e) {
      return false;
    }
  }

  // ==========================================================================
  // 三、播放器桥接：百家云 BPlayer（手机端也是它）+ 原生 video 兜底
  // ==========================================================================
  const bplayerInstances = [];

  function hookGlobal(name) {
    const wrap = (fn) => {
      if (typeof fn !== 'function' || fn.__mfcWrapped) return fn;
      let proxy;
      try {
        proxy = new Proxy(fn, {
          apply(target, thisArg, args) {
            const ret = Reflect.apply(target, thisArg, args);
            try { remember(ret); } catch (e) {}
            return ret;
          },
          construct(target, args, newTarget) {
            const ret = Reflect.construct(target, args, newTarget);
            try { remember(ret); } catch (e) {}
            return ret;
          }
        });
      } catch (e) {
        return fn;
      }
      proxy.__mfcWrapped = true;
      return proxy;
    };
    const remember = (inst) => {
      if (!inst || typeof inst !== 'object') return;
      if (bplayerInstances.indexOf(inst) === -1) bplayerInstances.push(inst);
      if (bplayerInstances.length > 8) bplayerInstances.shift();
    };
    let current = window[name];
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get() { return current; },
        set(v) { current = wrap(v); }
      });
    } catch (e) {
      if (current) window[name] = wrap(current);
    }
  }

  hookGlobal('BPlayer');

  function bplayerRoot(inst) {
    const opts = inst.options || {};
    let el = inst.container || opts.container || opts.wrap || null;
    if (typeof el === 'string') {
      try { el = document.querySelector(el); } catch (e) { el = null; }
    }
    if (el && el.nodeType === 1) return el;
    return document.querySelector('.bplayer-wrap');
  }

  function activeBPlayer() {
    for (let i = bplayerInstances.length - 1; i >= 0; i--) {
      const inst = bplayerInstances[i];
      if (!inst) continue;
      const el = bplayerRoot(inst);
      if (el && isVisible(el)) return inst;
    }
    return null;
  }

  let videoCache = { v: null, at: 0 };

  function pickVideo() {
    const now = Date.now();
    if (videoCache.v && now - videoCache.at < 400 && videoCache.v.isConnected && isVisible(videoCache.v)) return videoCache.v;
    let best = null;
    let bestScore = -Infinity;
    const list = document.querySelectorAll('video');
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (!isVisible(v)) continue;
      // 百家云 SDK 内部会留一个没有时长的 video，别把它当成播放目标
      const hasDur = isFinite(v.duration) && v.duration > 0;
      if (!hasDur && v.readyState < 2) continue;
      let score = 0;
      if (!v.paused && v.readyState >= 2) score += 100;
      if (hasDur) score += 30;
      score += Math.min((v.clientWidth * v.clientHeight) / 5000, 40);
      if (score > bestScore) { bestScore = score; best = v; }
    }
    videoCache = { v: best, at: now };
    return best;
  }

  // ---- 适配器 --------------------------------------------------------------
  function bplayerAdapter(inst) {
    return {
      kind: 'bplayer',
      raw: inst,
      el: bplayerRoot(inst),
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
        try { inst.seek(t); } catch (e) { return false; }
        if (wasPaused) keepPaused(this);
        return true;
      },
      play() { try { inst.play(); } catch (e) {} },
      pause() { try { inst.pause(); } catch (e) {} },
      paused() { return !!inst.paused; },
      ended() { return !!inst.ended; },
      rate() {
        try {
          const v = inst.video;
          if (v && typeof v.playbackRate === 'number' && v.playbackRate > 0) return v.playbackRate;
          if (typeof inst.speed === 'number' && inst.speed > 0) return inst.speed;
        } catch (e) {}
        return 1;
      },
      /** 播放器允许的倍速集合（课程没开倍速时可能只有 1 或为空） */
      speedOptions() {
        let list = [];
        try {
          list = (inst.options && inst.options.rateList) || [];
        } catch (e) {}
        const clean = Array.isArray(list) ? list.filter((x) => typeof x === 'number' && x > 0) : [];
        const uniq = [...new Set(clean)].sort((a, b) => a - b);
        return uniq.length ? uniq : [1];
      },
      /** 把目标倍速夹到白名单内，返回实际生效值；失败返回 null */
      setRate(rate) {
        const opts = this.speedOptions();
        const le = opts.filter((x) => x <= rate + 1e-6);
        const target = le.length ? le[le.length - 1] : opts[0];
        try {
          if (typeof inst.setSpeed === 'function') inst.setSpeed(target);
          if (inst.video) inst.video.playbackRate = target;
          inst.speed = target;
          return target;
        } catch (e) {
          return null;
        }
      },
      volume() {
        const v = Number(inst.volume);
        return isFinite(v) ? clamp(v, 0, 1) : 0;
      },
      setVolume(v) {
        try { inst.setVolume(clamp(v, 0, 1), true, false); } catch (e) {}
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
      time() { return isFinite(v.currentTime) ? v.currentTime : 0; },
      seek(t) {
        try { v.currentTime = t; return true; } catch (e) { return false; }
      },
      play() { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} },
      pause() { try { v.pause(); } catch (e) {} },
      paused() { return !!v.paused; },
      ended() { return !!v.ended; },
      rate() { return v.playbackRate || 1; },
      speedOptions() { return [0.5, 0.75, 1, 1.25, 1.5, 2]; },
      setRate(rate) {
        const opts = this.speedOptions();
        const le = opts.filter((x) => x <= rate + 1e-6);
        const target = le.length ? le[le.length - 1] : opts[0];
        try { v.playbackRate = target; return target; } catch (e) { return null; }
      },
      volume() { return v.muted ? 0 : clamp(v.volume, 0, 1); },
      setVolume(vol) {
        try { v.muted = false; v.volume = clamp(vol, 0, 1); } catch (e) {}
      }
    };
  }

  let lastPlayerRef = null;

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
    return null;
  }

  function videoRect() {
    const p = lastPlayerRef && lastPlayerRef.el && lastPlayerRef.el.isConnected ? lastPlayerRef : getPlayer();
    if (!p || !p.el) return null;
    const r = p.el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return null;
    return r;
  }

  // ---- 暂停守护：BPlayer 的 seek 会自动续播 --------------------------------
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

  // ==========================================================================
  // 四、屏幕提示
  // ==========================================================================
  const OSD_ID = 'mfc-m-osd';
  const ICON = {
    left: '<svg viewBox="0 0 24 24"><path d="M11 6v12L2 12l9-6zm11 0v12l-9-6 9-6z"/></svg>',
    right: '<svg viewBox="0 0 24 24"><path d="M13 6v12l9-6-9-6zM2 6v12l9-6-9-6z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.54.84l11.5-7.5a1 1 0 0 0 0-1.68L8.54 3.66A1 1 0 0 0 7 4.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 4h3.2v16H7zm6.8 0H17v16h-3.2z"/></svg>',
    volume: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>',
    mute: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4zm15.3 3 2.2-2.2-1.4-1.4L18 10.6l-2.2-2.2-1.4 1.4L16.6 12l-2.2 2.2 1.4 1.4L18 13.4l2.2 2.2 1.4-1.4L19.3 12z"/></svg>',
    speed: '<svg viewBox="0 0 24 24"><path d="M12 4a9 9 0 1 0 8.94 10.1h-2.03A7 7 0 1 1 12 6v3l4-4-4-4v3zm1.4 5.6a1.8 1.8 0 1 0-2.55 2.55L12 18l1.4-1.4V9.6z"/></svg>',
    lock: '<svg viewBox="0 0 24 24"><path d="M12 2a5 5 0 0 0-5 5v3H5v12h14V10h-2V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 0 1 6 0v3H9z"/></svg>'
  };

  const CSS = `
#${OSD_ID}{position:fixed;inset:0;z-index:2147483600;pointer-events:none;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;text-align:left;direction:ltr}
#${OSD_ID} .mfc-toast{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.94);
  display:flex;align-items:center;gap:8px;padding:10px 16px;border-radius:999px;
  background:rgba(20,20,24,.86);color:#fff;font-size:14px;font-weight:500;line-height:1;
  white-space:nowrap;box-shadow:0 6px 22px rgba(0,0,0,.4);
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
  border:1px solid rgba(255,255,255,.08);opacity:0;transition:opacity .14s ease,transform .14s ease}
#${OSD_ID} .mfc-toast.mfc-show{opacity:1;transform:translate(-50%,-50%) scale(1)}
#${OSD_ID} .mfc-toast.mfc-boost{background:rgba(251,114,153,.95);border-color:rgba(255,255,255,.28)}
#${OSD_ID} svg{width:16px;height:16px;display:block;fill:currentColor;flex:none}
#${OSD_ID} .mfc-accent{color:${ACCENT}}
#${OSD_ID} .mfc-boost .mfc-accent{color:#fff}
#${OSD_ID} .mfc-sub{font-size:12px;font-weight:400;color:rgba(255,255,255,.62);margin-left:2px}
#${OSD_ID} .mfc-big{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
#${OSD_ID} .mfc-num{font-variant-numeric:tabular-nums}
#${OSD_ID} .mfc-bar{display:inline-block;width:70px;height:3px;border-radius:2px;background:rgba(255,255,255,.24);vertical-align:middle}
#${OSD_ID} .mfc-bar i{display:block;height:100%;background:#fff;border-radius:2px}

#${OSD_ID} .mfc-chip{position:absolute;pointer-events:auto;display:flex;align-items:center;gap:5px;
  padding:5px 10px;border-radius:999px;background:rgba(20,20,24,.5);color:#fff;
  font-size:12px;font-weight:600;line-height:1;letter-spacing:.3px;
  border:1px solid rgba(255,255,255,.14);opacity:.5;transition:opacity .2s ease,background .2s ease}
#${OSD_ID} .mfc-chip.mfc-chip-on{opacity:.95;background:rgba(251,114,153,.92)}
#${OSD_ID} .mfc-chip.mfc-chip-lock{opacity:.45;background:rgba(20,20,24,.5)}
#${OSD_ID} .mfc-chip svg{width:12px;height:12px}
`;

  let osdEl = null;
  let chipEl = null;

  function osd() {
    if (osdEl && osdEl.isConnected) {
      reparent();
      return osdEl;
    }
    osdEl = document.createElement('div');
    osdEl.id = OSD_ID;
    osdEl.setAttribute('aria-hidden', 'true');
    const style = document.createElement('style');
    style.textContent = CSS;
    osdEl.appendChild(style);
    (document.body || document.documentElement).appendChild(osdEl);

    chipEl = document.createElement('div');
    chipEl.className = 'mfc-chip';
    chipEl.innerHTML = `${ICON.speed}<span class="mfc-chip-text">1.0x</span>`;
    osdEl.appendChild(chipEl);
    chipEl.addEventListener(
      'click',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        cycleSpeed();
      },
      true
    );

    document.addEventListener('fullscreenchange', reparent, true);
    document.addEventListener('webkitfullscreenchange', reparent, true);
    window.addEventListener('resize', placeChip, true);
    window.addEventListener('orientationchange', () => setTimeout(placeChip, 200), true);
    setTimeout(placeChip, 30);
    return osdEl;
  }

  function reparent() {
    if (!osdEl) return;
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    const target = fs || document.body || document.documentElement;
    if (osdEl.parentNode !== target) {
      try { target.appendChild(osdEl); } catch (e) {}
    }
    placeChip();
  }

  function maxAllowed() {
    const p = getPlayer();
    if (!p) return 1;
    const opts = p.speedOptions();
    return opts[opts.length - 1] || 1;
  }

  function speedAllowed() {
    return maxAllowed() > 1.001;
  }

  function placeChip() {
    if (!chipEl || !chipEl.isConnected) return;
    const r = videoRect();
    if (!r) {
      chipEl.style.display = 'none';
      return;
    }
    chipEl.style.display = 'flex';
    const top = Math.max(6, r.top + 6);
    const left = Math.max(6, Math.min(window.innerWidth - 64, r.right - 58));
    chipEl.style.top = Math.round(top) + 'px';
    chipEl.style.left = Math.round(left) + 'px';

    const p = getPlayer();
    const rate = p ? p.rate() : 1;
    const allowed = speedAllowed();
    chipEl.classList.toggle('mfc-chip-on', allowed && Math.abs(rate - 1) > 0.001);
    chipEl.classList.toggle('mfc-chip-lock', !allowed);
    const txt = chipEl.querySelector('.mfc-chip-text');
    if (txt) {
      txt.textContent = allowed ? rate.toFixed(2).replace(/0$/, '').replace(/\.$/, '') + 'x' : '1x';
    }
    chipEl.title = allowed ? '点一下切换倍速' : '本课程未开放倍速';
    if (!allowed) chipEl.innerHTML = `${ICON.lock}<span class="mfc-chip-text">1x</span>`;
    else if (!chipEl.querySelector('.mfc-chip-text')) chipEl.innerHTML = `${ICON.speed}<span class="mfc-chip-text">${rate.toFixed(2)}x</span>`;
  }

  const toasts = Object.create(null);

  function showToast(id, html, opts) {
    if (!cfg.showOsd) return;
    const o = opts || {};
    const root = osd();
    let item = toasts[id];
    if (!item || !item.el || !item.el.isConnected) {
      const el = document.createElement('div');
      root.appendChild(el);
      item = { el, timer: 0 };
      toasts[id] = item;
    }
    item.el.className = 'mfc-toast' + (o.cls ? ' ' + o.cls : '');
    item.el.innerHTML = html;

    const r = videoRect() || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const x = clamp(r.left + r.width / 2, 80, Math.max(80, window.innerWidth - 80));
    const y = clamp(r.top + r.height / 2, 60, Math.max(60, window.innerHeight - 60));
    item.el.style.left = Math.round(x) + 'px';
    item.el.style.top = Math.round(y) + 'px';

    item.el.classList.remove('mfc-show');
    void item.el.offsetWidth;
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
    setTimeout(() => { if (el && el.isConnected) el.remove(); }, 200);
    delete toasts[id];
  }

  // ==========================================================================
  // 五、播放控制（全部走适配器 / 白名单）
  // ==========================================================================
  function showRateToast(rate, note) {
    showToast('rate', `${ICON.speed}<span class="mfc-big">${rate.toFixed(2).replace(/0$/, '').replace(/\.$/, '')}x</span><span class="mfc-sub">${note || '倍速'}</span>`, {
      duration: 1000
    });
  }

  function applyRate(target) {
    const p = getPlayer();
    if (!p) return null;
    if (!speedAllowed()) {
      showToast('rate', `${ICON.lock}<span>本课程未开放倍速</span>`, { duration: 1600 });
      return null;
    }
    const got = p.setRate(target);
    placeChip();
    if (got != null) showRateToast(got);
    return got;
  }

  function cycleSpeed() {
    // 触摸路径和合成的 click 可能都会触发，做 350ms 防抖，避免一次点击跳两档
    const now = Date.now();
    if (now - cycleSpeed.__last < 350) return;
    cycleSpeed.__last = now;
    const p = getPlayer();
    if (!p) return;
    if (!speedAllowed()) {
      showToast('rate', `${ICON.lock}<span>本课程未开放倍速</span>`, { duration: 1600 });
      return;
    }
    const opts = p.speedOptions();
    const cur = p.rate();
    let idx = opts.findIndex((x) => Math.abs(x - cur) < 0.01);
    idx = (idx + 1) % opts.length;
    p.setRate(opts[idx]);
    placeChip();
    showRateToast(opts[idx]);
    try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) {}
  }

  // 长按倍速
  const boost = { active: false, p: null, rate: 1, baseRate: 1, timer: 0 };

  function startBoost() {
    const p = getPlayer();
    if (!p || boost.active || p.paused()) return;
    if (!speedAllowed()) {
      showToast('rate', `${ICON.lock}<span>本课程未开放倍速</span>`, { duration: 1600 });
      return;
    }
    const target = p.setRate(cfg.boostRate);
    if (target == null || Math.abs(target - 1) < 0.001) return; // 白名单里没有可用倍速
    boost.active = true;
    boost.p = p;
    boost.rate = target;
    boost.baseRate = 1;
    showToast('boost', `${ICON.right}<span class="mfc-big">${target.toFixed(2).replace(/0$/, '').replace(/\.$/, '')}x</span><span class="mfc-sub">倍速播放中 · 松手恢复</span>`, {
      sticky: true,
      cls: 'mfc-boost'
    });
    placeChip();
    clearInterval(boost.timer);
    boost.timer = setInterval(() => {
      if (!boost.active) return;
      const cur = boost.p;
      if (!cur || !cur.el || !cur.el.isConnected || cur.paused()) return stopBoost();
      if (Math.abs(cur.rate() - boost.rate) > 0.01) cur.setRate(boost.rate);
    }, 150);
    try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) {}
  }

  function stopBoost() {
    if (!boost.active) return;
    const p = boost.p;
    boost.active = false;
    clearInterval(boost.timer);
    boost.timer = 0;
    boost.p = null;
    hideToast('boost');
    if (p) p.setRate(1);
    placeChip();
  }

  function seekBy(delta, opts) {
    const p = getPlayer();
    if (!p) return false;
    const dur = p.duration();
    const cur = p.time();
    let target = cur + delta;
    if (dur > 0) target = clamp(target, 0, Math.max(0, dur - 0.2));
    else target = Math.max(0, target);
    if (Math.abs(target - cur) < 0.05) return false;
    if (!p.seek(target)) return false;
    if (!opts || !opts.silent) {
      const forward = delta > 0;
      showToast('seek', `${forward ? ICON.right : ICON.left}<span>${forward ? '快进' : '快退'} <b class="mfc-accent">${Math.abs(Math.round(delta))}</b> 秒</span><span class="mfc-sub">${fmtTime(target)}${dur > 0 ? ' / ' + fmtTime(dur) : ''}</span>`, {
        duration: 640
      });
    }
    return true;
  }

  function togglePlay() {
    const p = getPlayer();
    if (!p) return;
    cancelKeepPaused();
    if (p.paused()) {
      p.play();
      showToast('play', `${ICON.play}<span>播放</span>`, { duration: 520 });
    } else {
      p.pause();
      showToast('play', `${ICON.pause}<span>暂停</span>`, { duration: 520 });
    }
  }

  function showVolumeHud(vol, sticky) {
    const pct = Math.round(clamp(vol, 0, 1) * 100);
    showToast('volume', `${pct > 0 ? ICON.volume : ICON.mute}<span class="mfc-num" style="min-width:34px;display:inline-block;text-align:right">${pct}%</span><span class="mfc-bar"><i style="width:${pct}%"></i></span>`, {
      duration: 700,
      sticky: !!sticky
    });
  }

  function setVolumeTo(vol) {
    const p = getPlayer();
    if (!p) return;
    p.setVolume(vol);
  }

  function volumeNow() {
    const p = getPlayer();
    return p ? p.volume() : 0;
  }

  // ==========================================================================
  // 六、手势引擎
  // ==========================================================================
  const G = {
    active: false, id: null,
    x0: 0, y0: 0, t0: 0, x: 0, y: 0,
    mode: null, moved: false,
    holdTimer: 0, longPressed: false,
    seekFrom: 0, seekDelta: 0, volFrom: 0,
    lastTapAt: 0, lastTapX: 0, lastTapY: 0,
    chipTap: false
  };

  function reset() {
    clearTimeout(G.holdTimer);
    G.holdTimer = 0;
    if (G.mode === 'hold' || G.longPressed) stopBoost();
    if (G.mode === 'volume') hideToast('volume');
    G.active = false;
    G.mode = null;
    G.moved = false;
    G.longPressed = false;
    G.seekDelta = 0;
    G.chipTap = false;
  }

  function pointOf(e) {
    const t = e.touches && e.touches[0] ? e.touches[0] : e.changedTouches && e.changedTouches[0];
    if (!t) return null;
    return { x: t.clientX, y: t.clientY, id: t.identifier };
  }

  function insideChip(x, y) {
    if (!chipEl || !chipEl.isConnected || chipEl.style.display === 'none') return false;
    const r = chipEl.getBoundingClientRect();
    return x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 8 && y <= r.bottom + 8;
  }

  function insideVideo(x, y) {
    const r = videoRect();
    if (!r) return false;
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function onTouchStart(e) {
    if (!cfg.enabled) return;
    osd();
    if (e.touches && e.touches.length > 1) return reset();

    const pt = pointOf(e);
    if (!pt) return;
    if (insideChip(pt.x, pt.y)) {
      // 角标自己的点击：WebView 里合成的 click 不稳定，这里自己处理触摸
      reset();
      G.active = true;
      G.chipTap = true;
      G.x0 = G.x = pt.x;
      G.y0 = G.y = pt.y;
      G.t0 = Date.now();
      return;
    }
    if (!insideVideo(pt.x, pt.y)) return;

    reset();
    G.active = true;
    G.id = pt.id;
    G.x0 = G.x = pt.x;
    G.y0 = G.y = pt.y;
    G.t0 = Date.now();
    G.mode = null;

    G.holdTimer = setTimeout(() => {
      if (!G.active || G.moved) return;
      const p = getPlayer();
      if (!p || p.paused()) return;
      G.longPressed = true;
      G.mode = 'hold';
      startBoost();
    }, cfg.longPressMs);
  }

  function onTouchMove(e) {
    if (!G.active) return;
    const pt = pointOf(e);
    if (!pt) return;
    G.x = pt.x;
    G.y = pt.y;
    const dx = G.x - G.x0;
    const dy = G.y - G.y0;

    if (!G.moved && Math.hypot(dx, dy) > 12) {
      G.moved = true;
      clearTimeout(G.holdTimer);
      if (G.longPressed) {
        stopBoost();
        G.longPressed = false;
      }
      const r = videoRect();
      if (r) {
        if (Math.abs(dx) > Math.abs(dy)) {
          G.mode = 'seek';
          const p = getPlayer();
          G.seekFrom = p ? p.time() : 0;
          G.seekDelta = 0;
        } else if (G.x0 > r.left + r.width * 0.45) {
          G.mode = 'volume';
          G.volFrom = volumeNow();
        } else {
          G.mode = 'none';
        }
      }
    }

    if (G.mode === 'seek') {
      e.preventDefault();
      const r = videoRect();
      const p = getPlayer();
      if (!r || !p) return;
      const dur = p.duration() || 300;
      const full = cfg.dragFullWidthSeek > 0 ? cfg.dragFullWidthSeek : Math.min(300, Math.max(20, dur * 0.3));
      G.seekDelta = (dx / r.width) * full;
      const target = clamp(G.seekFrom + G.seekDelta, 0, Math.max(0, dur - 0.2));
      const sign = G.seekDelta >= 0 ? '+' : '−';
      showToast('seekdrag', `${G.seekDelta >= 0 ? ICON.right : ICON.left}<span>${sign}${Math.abs(Math.round(G.seekDelta))} 秒</span><span class="mfc-sub">${fmtTime(target)} / ${fmtTime(dur)}</span>`, {
        sticky: true
      });
      return;
    }

    if (G.mode === 'volume') {
      e.preventDefault();
      const r = videoRect();
      if (!r) return;
      setVolumeTo(G.volFrom + -dy / (r.height * 0.9));
      showVolumeHud(volumeNow(), true);
      return;
    }
  }

  function onTouchEnd(e) {
    if (!G.active) return;
    if (G.chipTap) {
      const wasTap = !G.moved && Date.now() - G.t0 < 350;
      reset();
      if (wasTap) cycleSpeed();
      return;
    }
    const pt = pointOf(e);
    if (pt) { G.x = pt.x; G.y = pt.y; }
    const dt = Date.now() - G.t0;
    const moved = G.moved;
    const mode = G.mode;
    const longPressed = G.longPressed;

    if (mode === 'seek') {
      hideToast('seekdrag');
      const delta = G.seekDelta;
      reset();
      if (Math.abs(delta) >= 1) seekBy(delta);
      return;
    }
    if (mode === 'volume') {
      hideToast('volume');
      reset();
      return;
    }
    if (longPressed) {
      reset();
      return;
    }

    clearTimeout(G.holdTimer);
    const x = G.x0;
    const y = G.y0;
    const wasTap = !moved && dt < 320;
    reset();
    if (!wasTap) return;

    const now = Date.now();
    if (now - G.lastTapAt < cfg.doubleTapMs && Math.hypot(x - G.lastTapX, y - G.lastTapY) < 60) {
      G.lastTapAt = 0;
      const r = videoRect();
      if (!r) return;
      const rel = (x - r.left) / r.width;
      if (rel < 0.34) seekBy(-cfg.seekStep);
      else if (rel > 0.66) seekBy(cfg.seekStep);
      else togglePlay();
      return;
    }
    G.lastTapAt = now;
    G.lastTapX = x;
    G.lastTapY = y;
  }

  // ==========================================================================
  // 七、安装
  // ==========================================================================
  document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  document.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
  document.addEventListener('touchcancel', () => reset(), { capture: true, passive: true });

  const releaseAll = () => {
    reset();
    cancelKeepPaused();
  };
  window.addEventListener('blur', releaseAll, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  setInterval(() => {
    if (!osdEl) {
      if (getPlayer()) osd();
      return;
    }
    placeChip();
  }, 800);

  document.addEventListener('ratechange', (ev) => {
    const v = ev.target;
    if (v && v.tagName === 'VIDEO') placeChip();
  }, true);

  function firstRun() {
    const flag = 'mfc-mobile-tipped-' + VERSION;
    try {
      if (localStorage.getItem(flag)) return;
      localStorage.setItem(flag, '1');
    } catch (e) {}
    setTimeout(() => {
      showToast('tip', `手势已启用<span class="mfc-sub">长按倍速 · 双击左右 ±${cfg.seekStep}s · 右半屏上下滑音量</span>`, {
        duration: 4200
      });
    }, 2200);
  }
  firstRun();

  try {
    window.mfcMobile = {
      cfg,
      version: VERSION,
      player: getPlayer,
      instances: bplayerInstances,
      seek: (n) => seekBy(n),
      rate: (r) => applyRate(r),
      speedOptions: () => { const p = getPlayer(); return p ? p.speedOptions() : []; },
      toast: (t) => showToast('x', t, { duration: 2000 })
    };
  } catch (e) {}
})();
