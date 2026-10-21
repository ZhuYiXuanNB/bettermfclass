// ==UserScript==
// @name         研优课手机版 B 站式手势
// @namespace    https://github.com/ZhuYiXuanNB/bettermfclass
// @version      1.0.0
// @description  给研优课手机版（/wap）的播放器加 B 站移动端风格手势：长按倍速、双击左右快退快进、左右拖动调进度、右半屏上下滑调音量，外加一个倍速角标。仅对触摸设备生效。
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
 * 手机端（UA 带 Mobile 时）服务器返回的是 /wap 下的 uni-app H5 应用，
 * 播放器是 uni-app 的 <video> 组件 —— DOM 里就是一个原生 <video>，
 * 所以直接操作 video.currentTime / playbackRate 就行，比 PC 端简单得多。
 *
 * 注意：uni-app 组件自己的倍速菜单白名单是 [0.5,0.8,1,1.25,1.5,2]，
 * 走组件 API 传 3 会被改回 1；这里直接写 video.playbackRate 绕过。
 *
 * 手势（模仿 B 站移动端，不做亮度）：
 *   长按画面            → 倍速播放，松手恢复
 *   双击左 / 右三分之一 → 快退 / 快进 10 秒
 *   双击中间            → 播放 / 暂停
 *   横向拖动            → 调进度，松手生效
 *   右半屏纵向拖动      → 音量
 *   角标「1.0x」        → 点一下切换倍速
 * 单击不处理，交给 uni-app 原本的控件。
 */

(function () {
  'use strict';

  // 只在触摸设备上启用；横屏全屏、竖屏内联都走同一套
  if (!('ontouchstart' in window) && !(navigator.maxTouchPoints > 0)) return;
  if (window.__mfcMobileHooked) return;
  window.__mfcMobileHooked = true;

  const VERSION = '1.0.0';
  const ACCENT = '#FB7299';

  // ==========================================================================
  // 一、配置
  // ==========================================================================
  const DEFAULTS = {
    enabled: true,
    boostRate: 3,          // 长按时的倍速
    longPressMs: 420,      // 长按判定
    seekStep: 10,          // 双击快退/快进秒数
    doubleTapMs: 300,      // 双击判定窗口
    dragFullWidthSeek: 0,  // 0 = 自动（长视频 300s / 短视频 30% 时长）
    speedCycle: [1, 1.25, 1.5, 2, 3, 0.75],
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
    if (el.duration && el.duration > 0 && el.readyState === 0) {
      // 还没加载到元数据，先当作可见，避免刚进页面抓不到
    }
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
  // 三、找视频
  // ==========================================================================
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
      let score = 0;
      if (!v.paused && v.readyState >= 2) score += 100;
      if (v.duration > 0 && isFinite(v.duration)) score += 30;
      score += Math.min((v.clientWidth * v.clientHeight) / 5000, 40);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    videoCache = { v: best, at: now };
    return best;
  }

  function videoRect() {
    const v = pickVideo();
    if (!v) return null;
    const r = v.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return null;
    return r;
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
    speed: '<svg viewBox="0 0 24 24"><path d="M12 4a9 9 0 1 0 8.94 10.1h-2.03A7 7 0 1 1 12 6v3l4-4-4-4v3zm1.4 5.6a1.8 1.8 0 1 0-2.55 2.55L12 18l1.4-1.4V9.6z"/></svg>'
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

#${OSD_ID} .mfc-chip{position:absolute;pointer-events:auto;display:flex;align-items:center;gap:5px;
  padding:5px 10px;border-radius:999px;background:rgba(20,20,24,.5);color:#fff;
  font-size:12px;font-weight:600;line-height:1;letter-spacing:.3px;
  border:1px solid rgba(255,255,255,.14);opacity:.5;transition:opacity .2s ease,background .2s ease}
#${OSD_ID} .mfc-chip.mfc-chip-on{opacity:.95;background:rgba(251,114,153,.92)}
#${OSD_ID} .mfc-chip svg{width:12px;height:12px}
`;

  let osdEl = null;
  let chipEl = null;
  let chipTap = 0;

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
      try {
        target.appendChild(osdEl);
      } catch (e) {}
    }
    placeChip();
  }

  /** 倍速角标贴在视频右上角（全屏时贴屏幕右上角） */
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
    const rate = currentRate();
    chipEl.classList.toggle('mfc-chip-on', Math.abs(rate - 1) > 0.001);
    const txt = chipEl.querySelector('.mfc-chip-text');
    if (txt) txt.textContent = rate.toFixed(2).replace(/0$/, '').replace(/\.$/, '') + 'x';
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

    // 位置：视频区域中心（全屏时就是屏幕中心）
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
    setTimeout(() => {
      if (el && el.isConnected) el.remove();
    }, 200);
    delete toasts[id];
  }

  // ==========================================================================
  // 五、播放控制
  // ==========================================================================
  function currentRate() {
    const v = pickVideo();
    return v ? v.playbackRate || 1 : 1;
  }

  function setRate(rate, silent) {
    const v = pickVideo();
    if (!v) return;
    const r = Math.round(clamp(rate, 0.25, 4) * 100) / 100;
    try {
      v.playbackRate = r;
    } catch (e) {
      return;
    }
    placeChip();
    if (!silent) showRateToast(r);
  }

  function showRateToast(r) {
    showToast('rate', `${ICON.speed}<span class="mfc-big">${r.toFixed(2).replace(/0$/, '').replace(/\.$/, '')}x</span><span class="mfc-sub">倍速</span>`, {
      duration: 900
    });
  }

  function cycleSpeed() {
    const v = pickVideo();
    if (!v) return;
    const cur = v.playbackRate || 1;
    const list = cfg.speedCycle || DEFAULTS.speedCycle;
    let idx = list.findIndex((x) => Math.abs(x - cur) < 0.01);
    idx = (idx + 1) % list.length;
    setRate(list[idx]);
    try {
      if (navigator.vibrate) navigator.vibrate(8);
    } catch (e) {}
  }

  // 长按倍速
  const boost = { active: false, v: null, rate: 1, baseRate: 1, timer: 0 };

  function startBoost() {
    const v = pickVideo();
    if (!v || boost.active || v.paused) return;
    boost.active = true;
    boost.v = v;
    boost.rate = clamp(cfg.boostRate, 1.25, 4);
    boost.baseRate = v.playbackRate || 1;
    try {
      v.playbackRate = boost.rate;
    } catch (e) {}
    showToast('boost', `${ICON.right}<span class="mfc-big">${boost.rate}x</span><span class="mfc-sub">倍速播放中 · 松手恢复</span>`, {
      sticky: true,
      cls: 'mfc-boost'
    });
    placeChip();
    clearInterval(boost.timer);
    boost.timer = setInterval(() => {
      if (!boost.active) return;
      const cur = boost.v;
      if (!cur || !cur.isConnected || cur.paused) return stopBoost();
      if (Math.abs((cur.playbackRate || 1) - boost.rate) > 0.01) cur.playbackRate = boost.rate;
    }, 150);
    try {
      if (navigator.vibrate) navigator.vibrate(10);
    } catch (e) {}
  }

  function stopBoost() {
    if (!boost.active) return;
    const v = boost.v;
    boost.active = false;
    clearInterval(boost.timer);
    boost.timer = 0;
    boost.v = null;
    hideToast('boost');
    if (v && v.isConnected) {
      try {
        v.playbackRate = boost.baseRate || 1;
      } catch (e) {}
    }
    placeChip();
  }

  function seekBy(delta, opts) {
    const v = pickVideo();
    if (!v) return false;
    const dur = v.duration;
    const cur = v.currentTime || 0;
    let target = cur + delta;
    if (isFinite(dur) && dur > 0) target = clamp(target, 0, Math.max(0, dur - 0.2));
    else target = Math.max(0, target);
    if (Math.abs(target - cur) < 0.05) return false;
    try {
      v.currentTime = target;
    } catch (e) {
      return false;
    }
    if (!opts || !opts.silent) {
      const forward = delta > 0;
      showToast('seek', `${forward ? ICON.right : ICON.left}<span>${forward ? '快进' : '快退'} <b class="mfc-accent">${Math.abs(Math.round(delta))}</b> 秒</span><span class="mfc-sub">${fmtTime(target)}${isFinite(dur) && dur > 0 ? ' / ' + fmtTime(dur) : ''}</span>`, {
        duration: 640
      });
    }
    return true;
  }

  function togglePlay() {
    const v = pickVideo();
    if (!v) return;
    if (v.paused) {
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
      showToast('play', `${ICON.play}<span>播放</span>`, { duration: 520 });
    } else {
      v.pause();
      showToast('play', `${ICON.pause}<span>暂停</span>`, { duration: 520 });
    }
  }

  function changeVolume(delta) {
    const v = pickVideo();
    if (!v) return;
    const cur = v.muted ? 0 : v.volume;
    const next = clamp(cur + delta, 0, 1);
    try {
      v.muted = false;
      v.volume = next;
    } catch (e) {}
    const pct = Math.round(next * 100);
    showToast('volume', `${next > 0 ? ICON.volume : ICON.mute}<span class="mfc-num" style="min-width:34px;display:inline-block;text-align:right">${pct}%</span><span style="display:inline-block;width:70px;height:3px;border-radius:2px;background:rgba(255,255,255,.24);vertical-align:middle"><i style="display:block;height:100%;width:${pct}%;background:#fff;border-radius:2px"></i></span>`, {
      duration: 700
    });
  }

  function setVolumeTo(vol) {
    const v = pickVideo();
    if (!v) return;
    try {
      v.muted = false;
      v.volume = clamp(vol, 0, 1);
    } catch (e) {}
  }

  function volumeNow() {
    const v = pickVideo();
    if (!v) return 0;
    return v.muted ? 0 : v.volume;
  }

  function showVolumeHud(vol) {
    const pct = Math.round(clamp(vol, 0, 1) * 100);
    showToast('volume', `${pct > 0 ? ICON.volume : ICON.mute}<span class="mfc-num" style="min-width:34px;display:inline-block;text-align:right">${pct}%</span><span style="display:inline-block;width:70px;height:3px;border-radius:2px;background:rgba(255,255,255,.24);vertical-align:middle"><i style="display:block;height:100%;width:${pct}%;background:#fff;border-radius:2px"></i></span>`, {
      duration: 700,
      sticky: true
    });
  }

  // ==========================================================================
  // 六、手势引擎
  // ==========================================================================
  const G = {
    active: false,
    id: null,
    x0: 0, y0: 0, t0: 0,
    x: 0, y: 0,
    mode: null,        // 'seek' | 'volume' | 'hold'
    moved: false,
    holdTimer: 0,
    longPressed: false,
    seekFrom: 0,
    seekDelta: 0,
    volFrom: 0,
    ignore: false,
    lastTapAt: 0,
    lastTapX: 0,
    lastTapY: 0
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
    G.ignore = false;
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
    osd(); // 顺便把角标挂上
    if (e.touches && e.touches.length > 1) return reset(); // 双指（缩放）不管

    const p = pointOf(e);
    if (!p) return;
    if (insideChip(p.x, p.y)) return; // 角标自己的点击

    const r = videoRect();
    if (!r) return;
    if (!insideVideo(p.x, p.y)) return;

    reset();
    G.active = true;
    G.id = p.id;
    G.x0 = G.x = p.x;
    G.y0 = G.y = p.y;
    G.t0 = Date.now();
    G.mode = null;

    // 长按倍速
    G.holdTimer = setTimeout(() => {
      if (!G.active || G.moved) return;
      G.longPressed = true;
      G.mode = 'hold';
      startBoost();
    }, cfg.longPressMs);
  }

  function onTouchMove(e) {
    if (!G.active) return;
    const p = pointOf(e);
    if (!p) return;
    G.x = p.x;
    G.y = p.y;
    const dx = G.x - G.x0;
    const dy = G.y - G.y0;

    if (!G.moved && Math.hypot(dx, dy) > 12) {
      G.moved = true;
      clearTimeout(G.holdTimer);
      if (G.longPressed) {
        // 长按之后又滑动了：结束倍速，当普通操作
        stopBoost();
        G.longPressed = false;
      }
      const r = videoRect();
      if (r) {
        if (Math.abs(dx) > Math.abs(dy)) {
          G.mode = 'seek';
          const v = pickVideo();
          G.seekFrom = v ? v.currentTime || 0 : 0;
          G.seekDelta = 0;
        } else if (G.x0 > r.left + r.width * 0.45) {
          // 右半屏纵向 => 音量（左半屏不做亮度）
          G.mode = 'volume';
          G.volFrom = volumeNow();
        } else {
          G.mode = 'none'; // 左半屏纵向：不接管，交给页面
        }
      }
    }

    if (G.mode === 'seek') {
      e.preventDefault();
      const r = videoRect();
      const v = pickVideo();
      if (!r || !v) return;
      const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 300;
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
      const delta = (-dy / (r.height * 0.9)) * 1;
      setVolumeTo(G.volFrom + delta);
      showVolumeHud(volumeNow());
      return;
    }
  }

  function onTouchEnd(e) {
    if (!G.active) return;
    const p = pointOf(e);
    if (p) {
      G.x = p.x;
      G.y = p.y;
    }
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

    // 双击判定
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

  // 角标跟随视频/滚动
  setInterval(() => {
    if (!osdEl) {
      if (pickVideo()) osd();
      return;
    }
    placeChip();
  }, 800);

  // 播放状态变化时同步角标（uni-app 自己改倍速时也能跟上）
  document.addEventListener(
    'ratechange',
    (ev) => {
      const v = ev.target;
      if (v && v.tagName === 'VIDEO') placeChip();
    },
    true
  );

  // 首次提示
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

  // 调试入口
  try {
    window.mfcMobile = {
      cfg,
      version: VERSION,
      video: pickVideo,
      seek: (n) => seekBy(n),
      rate: (r) => setRate(r),
      toast: (t) => showToast('x', t, { duration: 2000 })
    };
  } catch (e) {}
})();
