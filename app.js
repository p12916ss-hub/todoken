/* トドケン — アプリ本体 v1.1
   学習設計:
   - 想起（思い出す）を毎問1回必ず発生させる
   - 誤答は「なぜ」を1行返し、同じ項目を3問後に再出題（即時再学習）
   - 正答は間隔をあけて再出題（1→3→7→16→35日）
   - 誤答した項目は「まちがいノート」に残す

   地図操作:
   - 1本指ドラッグ＝移動、2本指ピンチ＝拡大縮小、＋/− ボタン＝段階ズーム
   - viewBox を動かす方式なので、拡大しても文字と当たり判定が一緒に拡大する
*/
(function () {
  "use strict";

  function reportErr(m) {
    try { fetch("/__err?m=" + encodeURIComponent(String(m).slice(0, 300))); } catch (e) {}
    var d = document.createElement("div");
    d.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99;background:#b2433a;color:#fff;font:12px/1.5 sans-serif;padding:10px 14px";
    d.textContent = "起動エラー: " + m;
    document.body.appendChild(d);
  }
  window.addEventListener("error", function (e) {
    reportErr((e.message || "unknown") + " @" + (e.filename || "").split("/").pop() + ":" + e.lineno);
  });

  /* ---------------- storage ---------------- */
  var KEY = "todoken.v3";
  var DAY = 86400000;
  var INTERVALS = [0, 1, 3, 7, 16, 35];
  var SESSION_SIZE = 10;

  var S = {
    items: {},
    streak: { last: null, count: 0 },
    today: { d: null, n: 0 },
    settings: { sound: true, zoom: "auto" }
  };

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && typeof o === "object") {
        S.items = o.items || {};
        S.streak = o.streak || S.streak;
        S.today = o.today || S.today;
        S.settings = Object.assign(S.settings, o.settings || {});
      }
    } catch (e) {}
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
  }
  function todayIndex() {
    var d = new Date();
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
  }
  function getItem(mode, id) {
    var k = mode + ":" + id;
    if (!S.items[k]) S.items[k] = { b: 0, d: 0, n: 0, seen: 0 };
    return S.items[k];
  }
  function touchPlay() {
    var t = todayIndex();
    if (S.today.d !== t) { S.today.d = t; S.today.n = 0; }
  }
  function bumpToday() { touchPlay(); S.today.n += 1; save(); }

  /* ---------------- prefecture helpers ---------------- */
  var BY_ID = {};
  PREF.forEach(function (p) { BY_ID[p.id] = p; });
  var MODE_LABEL = { map: "地図", capital: "県庁所在地", keyword: "名物" };
  var MODES = ["map", "capital", "keyword"];

  function shortName(p) { return p.name.replace(/[県府都]$/, ""); }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function levelOf(p) {
    var s = 0;
    for (var i = 0; i < MODES.length; i++) s += getItem(MODES[i], p.id).b;
    s = s / MODES.length;
    return s >= 3.6 ? 3 : s >= 2.1 ? 2 : s >= 0.8 ? 1 : 0;
  }
  function masteredCount() {
    return PREF.filter(function (p) { return levelOf(p) === 3; }).length;
  }
  function dueCount() {
    var t = todayIndex(), n = 0;
    PREF.forEach(function (p) {
      MODES.forEach(function (m) {
        var it = getItem(m, p.id);
        if (it.seen > 0 && it.d <= t) n++;
      });
    });
    return n;
  }
  function modeMastery(mode) {
    var n = 0;
    PREF.forEach(function (p) { if (getItem(mode, p.id).b >= 4) n++; });
    return n;
  }

  /* ---------------- sound ---------------- */
  var actx = null;
  function beep(freq, dur, type) {
    if (!S.settings.sound) return;
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = type || "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.06, actx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
      o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + dur + 0.02);
    } catch (e) {}
  }
  function sndOk() { beep(660, 0.09); setTimeout(function () { beep(990, 0.09); }, 70); }
  function sndNg() { beep(200, 0.16, "triangle"); }

  /* ---------------- dom ---------------- */
  function el(id) { return document.getElementById(id); }
  function show(name) {
    var list = document.querySelectorAll(".screen");
    for (var i = 0; i < list.length; i++) list[i].classList.remove("active");
    el("screen-" + name).classList.add("active");
    if (name === "home") renderHome();
    if (name === "book") renderBook();
    if (name === "settings") renderSettings();
  }

  /* =========================================================
     地図エンジン
     ========================================================= */
  var NS = "http://www.w3.org/2000/svg";
  var ZONES = {};
  PREF.forEach(function (p) { (ZONES[p.region] = ZONES[p.region] || []).push(p.id); });

  var MIN_SCALE = 1;
  var MAX_SCALE = 14;

  function buildMap() {
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("class", "jp");
    var g = document.createElementNS(NS, "g");
    g.setAttribute("class", "zoom");
    PREF.forEach(function (pf) {
      var path = document.createElementNS(NS, "path");
      path.setAttribute("d", MAP_PATHS[pf.id]);
      path.setAttribute("class", "pref");
      path.setAttribute("data-id", pf.id);
      g.appendChild(path);
    });
    svg.appendChild(g);
    svg._zoom = g;
    svg._paths = g.querySelectorAll(".pref");
    return svg;
  }

  function bboxOf(svg, ids) {
    var g = svg._zoom;
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, any = false;
    (ids || Object.keys(MAP_PATHS)).forEach(function (id) {
      var p = g.querySelector('.pref[data-id="' + id + '"]');
      if (!p) return;
      var b = p.getBBox();
      if (!b.width && !b.height) return;
      any = true;
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
    });
    if (!any) return { x: 0, y: 0, w: 438, h: 516 };
    return { x: x0, y: y0, w: Math.max(x1 - x0, 1), h: Math.max(y1 - y0, 1) };
  }

  function applyVB(svg) {
    var vb = svg._vb;
    svg.setAttribute("viewBox", vb.x + " " + vb.y + " " + vb.w + " " + vb.h);
  }

  /* 47県全体が枠に収まる基準ビュー */
  function baseView(svg) {
    var r = bboxOf(svg);
    var pad = Math.max(r.w, r.h) * 0.015;
    svg._base = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
    svg._vb = { x: svg._base.x, y: svg._base.y, w: svg._base.w, h: svg._base.h };
    applyVB(svg);
  }

  /* 指定した範囲が枠いっぱいに来るビュー */
  function viewFor(svg, r, margin) {
    margin = margin == null ? 0.06 : margin;
    var rect = svg.getBoundingClientRect();
    var ar = (rect.width && rect.height) ? rect.width / rect.height : 0.85;
    var w = r.w * (1 + margin * 2), h = r.h * (1 + margin * 2);
    if (w / h > ar) h = w / ar; else w = h * ar;
    return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w: w, h: h };
  }

  function clampVB(svg) {
    var b = svg._base, v = svg._vb;
    if (!b) return;
    var sc = b.w / v.w;
    if (sc <= MIN_SCALE * 1.001) {
      v.x = b.x; v.y = b.y; v.w = b.w; v.h = b.h;
      return;
    }
    if (sc > MAX_SCALE) {
      var k = MAX_SCALE / sc, cx = v.x + v.w / 2, cy = v.y + v.h / 2;
      v.w *= 1 / k; v.h *= 1 / k;
      v.x = cx - v.w / 2; v.y = cy - v.h / 2;
    }
    var mx = b.w * 0.25, my = b.h * 0.25;
    if (v.x + v.w < b.x + v.w * 0.5) v.x = b.x - mx;
    if (v.x > b.x + b.w - v.w * 0.5) v.x = b.x + b.w - v.w + mx;
    if (v.y + v.h < b.y + v.h * 0.5) v.y = b.y - my;
    if (v.y > b.y + b.h - v.h * 0.5) v.y = b.y + b.h - v.h + my;
  }

  function gotoVB(svg, target, dur) {
    var from = { x: svg._vb.x, y: svg._vb.y, w: svg._vb.w, h: svg._vb.h };
    if (!dur) { svg._vb = target; clampVB(svg); applyVB(svg); return; }
    var t0 = performance.now();
    var id = svg._anim = (svg._anim || 0) + 1;
    function step(now) {
      if (svg._anim !== id) return;
      var t = Math.min(1, (now - t0) / dur);
      var e = 1 - Math.pow(1 - t, 3);
      svg._vb = {
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        w: from.w + (target.w - from.w) * e,
        h: from.h + (target.h - from.h) * e
      };
      applyVB(svg);
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function toUser(svg, cx, cy) {
    var m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    var pt = svg.createSVGPoint();
    pt.x = cx; pt.y = cy;
    var p = pt.matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }

  /* タップ位置から県を1つ決める。
     ・透明な当たり判定パスは使わない（縁取りで判定が膨らむため）
     ・各県の実ポリゴンに点が入っているかを直接判定する
     ・重なっている場所（県境の隙間やトレース誤差）は面積が小さい県を優先
     ・どの県にも入っていない場合は、画面上14px以内なら最寄りの代表点を返す */
  function hitTest(svg, clientX, clientY) {
    var m = svg.getScreenCTM();
    if (!m) return null;
    var pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    var u = pt.matrixTransform(m.inverse());

    var paths = svg._paths || svg.querySelectorAll(".pref");
    var best = null, bestA = Infinity;
    for (var i = 0; i < paths.length; i++) {
      var node = paths[i];
      if (!node.isPointInFill) continue;
      if (!node.isPointInFill(u)) continue;
      var id = node.getAttribute("data-id");
      var a = (typeof MAP_AREAS !== "undefined" && MAP_AREAS[id]) || 1e9;
      if (a < bestA) { bestA = a; best = id; }
    }
    if (best) return best;

    var pxPerUnit = Math.abs(m.a) || 1;
    var tol = 14 / pxPerUnit;
    var nd = Infinity, nid = null;
    if (typeof MAP_ANCHORS !== "undefined") {
      for (var k in MAP_ANCHORS) {
        var q = MAP_ANCHORS[k];
        var dx = q[0] - u.x, dy = q[1] - u.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d < nd) { nd = d; nid = k; }
      }
    }
    return nd <= tol ? nid : null;
  }

  function zoomAtClient(svg, cx, cy, factor, dur) {
    var v = svg._vb, b = svg._base;
    var want = b.w / (v.w / factor);
    if (want < MIN_SCALE) factor = b.w / v.w / MIN_SCALE;
    if (want > MAX_SCALE) factor = b.w / (v.w / MAX_SCALE);
    var p = toUser(svg, cx, cy);
    var nw = v.w / factor, nh = v.h / factor;
    var t = {
      x: p.x - (p.x - v.x) * (nw / v.w),
      y: p.y - (p.y - v.y) * (nh / v.h),
      w: nw, h: nh
    };
    var tmp = svg._vb; svg._vb = t; clampVB(svg); t = svg._vb; svg._vb = tmp;
    gotoVB(svg, t, dur === undefined ? 0 : dur);
  }

  function panByUser(svg, dux, duy) {
    svg._vb.x -= dux;
    svg._vb.y -= duy;
    clampVB(svg);
    applyVB(svg);
  }

  function fitRegion(svg, region, dur) {
    if (!region) { gotoVB(svg, svg._base, dur); return; }
    var ids = ZONES[region] || [];
    gotoVB(svg, viewFor(svg, bboxOf(svg, ids), 0.05), dur);
  }

  function fitIds(svg, ids, margin, dur) {
    gotoVB(svg, viewFor(svg, bboxOf(svg, ids), margin || 0.7), dur);
  }

  function scaleOf(svg) { return svg._base.w / svg._vb.w; }

  /* 指の操作 */
  function attachGestures(svg, opts) {
    opts = opts || {};
    var ptrs = {};
    var n = 0;
    var start = null;
    var pinchD = 0;
    var locked = false;

    function dist2() {
      var a = [], k;
      for (k in ptrs) a.push(ptrs[k]);
      if (a.length < 2) return 0;
      var dx = a[0].x - a[1].x, dy = a[0].y - a[1].y;
      return Math.sqrt(dx * dx + dy * dy);
    }
    function mid() {
      var a = [], k;
      for (k in ptrs) a.push(ptrs[k]);
      return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 };
    }

    svg.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (svg._anim) svg._anim++;
      try { svg.setPointerCapture(e.pointerId); } catch (err) {}
      ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      n++;
      if (n === 1) {
        start = { x: e.clientX, y: e.clientY, t: Date.now(), moved: 0, target: e.target };
      } else {
        if (start) start.moved = 999;
        pinchD = dist2();
      }
      if (opts.onFirstTouch) opts.onFirstTouch();
    });

    svg.addEventListener("pointermove", function (e) {
      var p = ptrs[e.pointerId];
      if (!p) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (n === 1 && start) {
        start.moved += Math.abs(dx) + Math.abs(dy);
        if (start.moved > 4 && !locked) {
          var a = toUser(svg, p.x - dx, p.y - dy);
          var b = toUser(svg, p.x, p.y);
          panByUser(svg, b.x - a.x, b.y - a.y);
        }
      } else if (n >= 2 && pinchD > 0) {
        var d = dist2();
        if (d > 0) {
          var m = mid();
          zoomAtClient(svg, m.x, m.y, d / pinchD, 0);
          pinchD = d;
        }
        if (start) start.moved = 999;
      }
    });

    function up(e) {
      if (!ptrs[e.pointerId]) return;
      delete ptrs[e.pointerId];
      n--;
      if (n <= 0) {
        n = 0; ptrs = {}; pinchD = 0;
        if (start && start.moved < 8 && Date.now() - start.t < 800) {
          var id = hitTest(svg, e.clientX, e.clientY);
          if (id && opts.onTap && !locked) opts.onTap(id);
        }
        start = null;
      } else if (n === 1) {
        pinchD = 0;
        start = null;
      }
    }
    svg.addEventListener("pointerup", up);
    svg.addEventListener("pointercancel", up);

    svg.addEventListener("wheel", function (e) {
      if (svg._anim) svg._anim++;
      e.preventDefault();
      zoomAtClient(svg, e.clientX, e.clientY, e.deltaY < 0 ? 1.18 : 1 / 1.18, 90);
    }, { passive: false });

    return {
      lock: function () { locked = true; },
      unlock: function () { locked = false; }
    };
  }

  /* ズームボタンを地図枠に付ける */
  function addZoomControls(svg, frame) {
    var bar = document.createElement("div");
    bar.className = "zoombar";
    bar.innerHTML =
      '<button data-z="in" aria-label="拡大">＋</button>' +
      '<button data-z="out" aria-label="縮小">−</button>' +
      '<button data-z="all" aria-label="全体表示" class="wide">全体</button>';
    frame.appendChild(bar);
    bar.addEventListener("click", function (e) {
      var z = e.target.getAttribute && e.target.getAttribute("data-z");
      if (!z) return;
      e.stopPropagation();
      var r = svg.getBoundingClientRect();
      if (z === "in") zoomAtClient(svg, r.left + r.width / 2, r.top + r.height / 2, 1.7, 160);
      if (z === "out") zoomAtClient(svg, r.left + r.width / 2, r.top + r.height / 2, 1 / 1.7, 160);
      if (z === "all") gotoVB(svg, svg._base, 220);
    });

    var tag = document.createElement("div");
    tag.className = "zoom-tag";
    frame.appendChild(tag);
    svg._tag = tag;
    function sync() {
      var sc = scaleOf(svg);
      tag.textContent = sc < 1.15 ? "全国" : "拡大 " + sc.toFixed(1) + "倍";
      tag.classList.toggle("on", sc >= 1.15);
    }
    var ro = function () { requestAnimationFrame(sync); };
    svg.addEventListener("pointerup", ro);
    svg.addEventListener("wheel", ro);
    bar.addEventListener("click", ro);
    svg._syncTag = sync;
    sync();
  }

  function paint(svg, fn) {
    var paths = svg.querySelectorAll(".pref");
    for (var i = 0; i < paths.length; i++) {
      var cls = fn(paths[i].getAttribute("data-id"));
      paths[i].setAttribute("class", "pref" + (cls ? " " + cls : ""));
    }
  }

  function addLabel(svg, id, text) {
    var g = svg._zoom;
    var p = g.querySelector('.pref[data-id="' + id + '"]');
    if (!p) return;
    var b = p.getBBox();
    var t = document.createElementNS(NS, "text");
    t.setAttribute("x", b.x + b.width / 2);
    t.setAttribute("y", b.y + b.height / 2 + 4);
    t.setAttribute("class", "lbl");
    t.textContent = text;
    g.appendChild(t);
  }

  /* =========================================================
     ホーム
     ========================================================= */
  function renderHome() {
    var m = masteredCount();
    el("masterNum").textContent = m;

    var due = dueCount();
    touchPlay();
    var doneToday = S.today.n;
    el("dueLabel").textContent = due > 0 ? due + "問たまっています"
      : (doneToday > 0 ? "今日は " + doneToday + "問 解きました" : "まずは10問から");
    el("dueTitle").textContent = due > 0 ? "今日の復習" : (doneToday > 0 ? "もう少しやる" : "はじめる");

    var pct = Math.min(1, doneToday / 10);
    var circ = 2 * Math.PI * 26;
    var ring = el("ringFill");
    ring.setAttribute("stroke-dasharray", circ.toFixed(1));
    ring.setAttribute("stroke-dashoffset", (circ * (1 - pct)).toFixed(1));
    el("ringNum").innerHTML = doneToday + "<small>問</small>";
    el("streakNum").textContent = S.streak.count || 0;

    MODES.forEach(function (mode) {
      el("cnt-" + mode).innerHTML = "<b>" + modeMastery(mode) + "</b>/47";
    });

    var slot = el("homeMap");
    slot.innerHTML = "";
    var svg = buildMap();
    slot.appendChild(svg);
    baseView(svg);
    var paths = svg.querySelectorAll(".pref");
    for (var i = 0; i < paths.length; i++) {
      var lv = levelOf(BY_ID[paths[i].getAttribute("data-id")]);
      paths[i].style.fill = ["#dccfae", "#b9bda0", "#7ba487", "#2f7d5c"][lv];
    }
  }

  /* =========================================================
     セッション
     ========================================================= */
  var ses = null;

  function candidates(mode) {
    var t = todayIndex();
    var list = PREF.map(function (p) {
      var it = getItem(mode, p.id);
      var pr;
      if (it.seen > 0 && it.d <= t) pr = 0 + (t - it.d) * 0.01;
      else if (it.seen === 0) pr = 1;
      else pr = 2 + it.b * 0.1 + it.d * 0.0001;
      return { p: p, it: it, pr: pr };
    });
    list.sort(function (a, b) { return a.pr - b.pr; });
    return list;
  }

  function buildQueue(mode, n) {
    var pool = [];
    if (mode === "mixed") {
      var per = {};
      MODES.forEach(function (m) { per[m] = candidates(m); });
      var i = 0;
      while (pool.length < n && i < 60) {
        MODES.forEach(function (m) {
          if (pool.length < n && per[m][i]) pool.push({ mode: m, p: per[m][i].p });
        });
        i++;
      }
    } else {
      var c = candidates(mode);
      for (var j = 0; j < c.length && pool.length < n; j++) pool.push({ mode: mode, p: c[j].p });
    }
    return shuffle(pool).slice(0, n);
  }

  function startSession(mode) {
    var q = buildQueue(mode, SESSION_SIZE);
    if (!q.length) return;
    ses = { mode: mode, q: q, i: 0, right: 0, wrong: [], answered: false, tries: 0 };
    el("modeName").textContent = mode === "mixed" ? "今日の復習" : MODE_LABEL[mode] + "モード";
    el("screen-quiz").className = "screen mode-" + mode;
    show("quiz");
    renderQ();
  }

  function renderQ() {
    var cur = ses.q[ses.i];
    var p = cur.p, mode = cur.mode;
    var it = getItem(mode, p.id);
    ses.answered = false;
    ses.tries = 0;

    var dots = "";
    for (var i = 0; i < ses.q.length; i++) {
      dots += '<i class="' + (i < ses.i ? "done" : i === ses.i ? "now" : "") + '"></i>';
    }
    el("dots").innerHTML = dots;
    el("qCount").innerHTML = "<b>" + (ses.i + 1) + "</b>/" + ses.q.length;

    var body = el("qBody");
    body.innerHTML = "";
    var sheet = el("sheet");
    sheet.hidden = true;
    sheet.className = "sheet";

    if (mode === "map") {
      el("promptSub").textContent = "地図の上でタップ";
      el("promptMain").textContent = p.name;
      renderMapQ(body, p, it);
    } else if (mode === "capital") {
      el("promptSub").textContent = p.same ? "県名と同名の県庁所在地" : "県名と違う名前の県庁所在地";
      el("promptMain").innerHTML = p.name + '<span class="tag">' + p.region + "</span>";
      renderCapitalQ(body, p);
    } else {
      el("promptSub").textContent = "5つの手がかりから";
      el("promptMain").innerHTML = 'この県は？<span class="tag">' + p.region + "</span>";
      renderKeywordQ(body, p);
    }
  }

  function renderMapQ(body, p, it) {
    var area = document.createElement("div");
    area.className = "map-area";
    var frame = document.createElement("div");
    frame.className = "map-frame";
    var svg = buildMap();
    frame.appendChild(svg);
    area.appendChild(frame);
    body.appendChild(area);

    baseView(svg);
    addZoomControls(svg, frame);

    var gs = attachGestures(svg, { onTap: function (id) { onMapTap(svg, id, p); } });
    ses.svg = svg;
    ses.gs = gs;

    // 初期表示
    var zone = null;
    if (S.settings.zoom === "always") zone = p.region;
    else if (S.settings.zoom === "auto") zone = it.b < 3 ? p.region : null;
    if (zone) fitRegion(svg, zone, 0);
    if (svg._syncTag) svg._syncTag();

    // 動作確認用: ?z=3 で拡大状態から始められる
    var zp = parseFloat(new URLSearchParams(location.search).get("z"));
    if (zp > 1) {
      var rc = svg.getBoundingClientRect();
      zoomAtClient(svg, rc.left + rc.width / 2, rc.top + rc.height / 2, zp, 0);
      if (svg._syncTag) svg._syncTag();
    }

    var hint = document.createElement("div");
    hint.className = "map-hint";
    hint.textContent = "ドラッグで移動 ／ ピンチか ＋ で拡大";
    frame.appendChild(hint);
    setTimeout(function () { if (hint.parentNode) hint.classList.add("fade"); }, 3200);
    attachGestures.__hint = hint;
  }

  function onMapTap(svg, id, p) {
    if (ses.answered) return;
    if (id === p.id) {
      ses.answered = true;
      ses.gs.lock();
      markMapOk(svg, p);
      grade(true);
      return;
    }
    ses.tries++;
    var wrong = svg.querySelector('.pref[data-id="' + id + '"]');
    if (wrong) { wrong.classList.add("ng"); setTimeout(function () { wrong.classList.remove("ng"); }, 700); }
    var frame = svg.parentNode;
    var old = frame.querySelector(".toast");
    if (old) old.remove();
    var toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = "ちがいます — 押したのは" + BY_ID[id].name;
    frame.appendChild(toast);
    setTimeout(function () { if (toast.parentNode) toast.remove(); }, 1200);
    svg.classList.add("nudge");
    setTimeout(function () { svg.classList.remove("nudge"); }, 340);
    sndNg();
    if (ses.tries >= 2) {
      ses.answered = true;
      ses.gs.lock();
      markMapOk(svg, p);
      grade(false);
    }
  }

  function markMapOk(svg, p) {
    var paths = svg.querySelectorAll(".pref");
    for (var i = 0; i < paths.length; i++) {
      var id = paths[i].getAttribute("data-id");
      if (id !== p.id) paths[i].classList.add("dim");
    }
    var ans = svg.querySelector('.pref[data-id="' + p.id + '"]');
    if (ans) { ans.classList.remove("dim", "ng"); ans.classList.add("ok"); }

    // 答えが小さくて見えないときは、その県に寄る
    if (scaleOf(svg) < 3.2) {
      if (p.region === "北海道" || p.region === "九州") fitRegion(svg, p.region, 260);
      else fitIds(svg, [p.id], 1.4, 260);
    }
    setTimeout(function () { addLabel(svg, p.id, shortName(p)); }, 160);
  }

  function renderCapitalQ(body, p) {
    var area = document.createElement("div");
    area.className = "map-area";
    var frame = document.createElement("div");
    frame.className = "map-frame";
    var svg = buildMap();
    frame.appendChild(svg);
    area.appendChild(frame);
    body.appendChild(area);

    baseView(svg);
    var paths = svg.querySelectorAll(".pref");
    for (var i = 0; i < paths.length; i++) {
      if (paths[i].getAttribute("data-id") !== p.id) paths[i].classList.add("dim");
    }
    var ans = svg.querySelector('.pref[data-id="' + p.id + '"]');
    if (ans) { ans.style.fill = "#c3b393"; }
    fitRegion(svg, p.region, 0);
    addLabel(svg, p.id, shortName(p));

    var others = PREF.filter(function (x) { return x.id !== p.id; });
    var same = shuffle(others.filter(function (x) { return x.region === p.region; }));
    var diff = shuffle(others.filter(function (x) { return x.region !== p.region; }));
    var pick = same.slice(0, 3), k = 0;
    while (pick.length < 3) pick.push(diff[k++]);

    var wrap = document.createElement("div");
    wrap.className = "opts";
    shuffle([p].concat(pick)).forEach(function (o) {
      var b = document.createElement("button");
      b.className = "opt";
      b.textContent = o.capital;
      b.addEventListener("click", function () { onChoose(b, o, p, "capital", wrap); });
      wrap.appendChild(b);
    });
    body.appendChild(wrap);
  }

  function renderKeywordQ(body, p) {
    var chips = document.createElement("div");
    chips.className = "chips";
    p.items.forEach(function (it, i) {
      var c = document.createElement("div");
      var long = it.t.length > 9;
      c.className = "chip" + (long ? " wide" : "");
      c.style.animationDelay = (i * 40) + "ms";
      c.innerHTML = '<span class="cat">' + it.c + '</span><span class="txt">' + it.t + "</span>";
      chips.appendChild(c);
    });
    body.appendChild(chips);

    var others = PREF.filter(function (x) { return x.id !== p.id; });
    var same = shuffle(others.filter(function (x) { return x.region === p.region; }));
    var diff = shuffle(others.filter(function (x) { return x.region !== p.region; }));
    var pick = same.slice(0, 2), k = 0;
    while (pick.length < 3) pick.push(diff[k++]);

    var wrap = document.createElement("div");
    wrap.className = "opts";
    shuffle([p].concat(pick)).forEach(function (o) {
      var b = document.createElement("button");
      b.className = "opt";
      b.textContent = o.name;
      b.addEventListener("click", function () { onChoose(b, o, p, "keyword", wrap); });
      wrap.appendChild(b);
    });
    body.appendChild(wrap);
  }

  function onChoose(btn, chosen, p, mode, wrap) {
    if (ses.answered) return;
    ses.answered = true;
    var ok = chosen.id === p.id;
    var btns = wrap.querySelectorAll(".opt");
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = true;
      if (btns[i].textContent === (mode === "capital" ? p.capital : p.name)) btns[i].classList.add("ok");
    }
    if (!ok) btn.classList.add("ng");
    grade(ok);
  }

  function grade(ok) {
    var cur = ses.q[ses.i];
    var p = cur.p, mode = cur.mode;
    var it = getItem(mode, p.id);
    var t = todayIndex();

    it.seen += 1;
    if (ok) {
      it.b = Math.min(5, it.b + 1);
      it.d = t + INTERVALS[it.b];
      ses.right++;
      sndOk();
    } else {
      it.n += 1;
      it.b = 1;
      it.d = t + 1;
      ses.wrong.push({ mode: mode, p: p });
      sndNg();
      var again = ses.i + 3;
      if (again < ses.q.length && !ses.q[again].again) ses.q.splice(again, 0, { mode: mode, p: p, again: true });
      else if (again < ses.q.length) ses.q.splice(again + 1, 0, { mode: mode, p: p, again: true });
    }
    bumpToday();
    save();
    showSheet(ok, p, mode);
  }

  function showSheet(ok, p, mode) {
    var sheet = el("sheet");
    sheet.hidden = false;
    sheet.className = "sheet " + (ok ? "ok" : "ng");
    el("mark").textContent = ok ? "○" : "×";
    el("sheetTitle").innerHTML = (ok ? "正解" : "答えは " + p.name) +
      "<span>" + p.name + " ／ 県庁所在地 " + p.capital + "</span>";
    el("nextBtn").textContent = (ses.i === ses.q.length - 1) ? "結果へ" : "次へ";

    var html = "";
    if (mode === "map" && !p.same) {
      html += '<div class="why"><span class="c">由来</span><span class="w">' + p.capWhy + "</span></div>";
    }
    p.items.forEach(function (it) {
      html += '<div class="why"><span class="c">' + it.c + '</span><span><b>' + it.t +
        '</b> <span class="w">— ' + it.w + "</span></span></div>";
    });
    el("sheetBody").innerHTML = html;
    el("nextBtn").focus({ preventScroll: true });
  }

  function nextQ() {
    if (ses.i >= ses.q.length - 1) { finish(); return; }
    ses.i++;
    renderQ();
  }

  function finish() {
    var total = ses.q.length;
    el("scoreNum").textContent = ses.right;
    el("scoreTotal").textContent = "/" + total;
    var c = ses.right / total;
    el("scoreComment").textContent =
      c === 1 ? "全問正解。この範囲はもう定着しています。次は全国で試すか、別のモードへ。" :
      c >= 0.8 ? "よく入っています。間違えた県だけ、明日もう一度出ます。" :
      c >= 0.5 ? "半分は定着。間違えた県は明日また出ます。今日はここまでで十分。" :
      "まだ手をつけた段階。間違えた県だけ、明日もう一度出ます。";

    var t = todayIndex();
    if (S.streak.last === t) {}
    else if (S.streak.last === t - 1) { S.streak.count += 1; S.streak.last = t; }
    else { S.streak.count = 1; S.streak.last = t; }
    save();

    var list = el("reviewList");
    if (!ses.wrong.length) {
      list.innerHTML = '<div class="empty">間違いはありませんでした。<br>明日、間隔をあけて再出題します。</div>';
    } else {
      list.innerHTML = ses.wrong.map(function (w) {
        var it0 = w.p.items[0];
        return '<div class="rrow"><div class="h"><span class="n">' + w.p.name + '</span><span class="c">' +
          MODE_LABEL[w.mode] + " ／ " + w.p.capital + '</span></div><div class="w">' + it0.t + " — " + it0.w + "</div></div>";
      }).join("");
    }
    el("screen-quiz").className = "screen";
    show("result");
  }

  /* ---------------- notebook ---------------- */
  function renderBook() {
    var rows = [];
    var t = todayIndex();
    Object.keys(S.items).forEach(function (k) {
      var it = S.items[k];
      if (!it.n) return;
      var parts = k.split(":");
      rows.push({ mode: parts[0], p: BY_ID[parts[1]], it: it });
    });
    rows.sort(function (a, b) { return a.it.d - b.it.d; });

    var wrap = el("bookList");
    if (!rows.length) {
      wrap.innerHTML = '<div class="empty">まだ間違いはありません。<br>1セッション終えると、ここに苦手な県が残ります。</div>';
      el("bookSub").textContent = "0件";
      return;
    }
    el("bookSub").textContent = rows.length + "件";
    wrap.innerHTML = rows.map(function (r) {
      var d = r.it.d - t;
      var due = d <= 0 ? "今日" : d === 1 ? "明日" : d + "日後";
      return '<div class="book-row"><span class="badge">' + MODE_LABEL[r.mode] + '</span>' +
        '<span class="nm">' + r.p.name + "<small>" + r.p.items[0].t + " ／ " + r.p.capital + "</small></span>" +
        '<span class="due"><b>' + due + "</b>×" + r.it.n + "</span></div>";
    }).join("");
  }

  function renderSettings() {
    el("swSound").className = "switch" + (S.settings.sound ? " on" : "");
    var segs = el("zoomSeg").querySelectorAll("button");
    for (var i = 0; i < segs.length; i++) {
      segs[i].className = segs[i].getAttribute("data-v") === S.settings.zoom ? "on" : "";
    }
  }

  function resetAll() {
    if (!confirm("学習の記録をすべて消します。よろしいですか？")) return;
    S.items = {};
    S.streak = { last: null, count: 0 };
    S.today = { d: null, n: 0 };
    save();
    alert("消去しました。");
    show("home");
  }

  /* ---------------- init ---------------- */
  function init() {
    load();
    touchPlay();

    el("startBtn").addEventListener("click", function () {
      startSession(dueCount() > 0 ? "mixed" : "map");
    });
    var modes = document.querySelectorAll(".mode");
    for (var i = 0; i < modes.length; i++) {
      (function (b) {
        b.addEventListener("click", function () { startSession(b.getAttribute("data-mode")); });
      })(modes[i]);
    }
    el("nextBtn").addEventListener("click", nextQ);
    el("quitBtn").addEventListener("click", function () {
      el("screen-quiz").className = "screen";
      show("home");
    });
    el("againBtn").addEventListener("click", function () { startSession(ses.mode); });
    el("homeBtn").addEventListener("click", function () { show("home"); });
    el("bookBtn").addEventListener("click", function () { show("book"); });
    el("setBtn").addEventListener("click", function () { show("settings"); });
    el("bookBack").addEventListener("click", function () { show("home"); });
    el("setBack").addEventListener("click", function () { show("home"); });
    el("swSound").addEventListener("click", function () {
      S.settings.sound = !S.settings.sound;
      save(); renderSettings();
    });
    el("zoomSeg").addEventListener("click", function (e) {
      var v = e.target.getAttribute("data-v");
      if (!v) return;
      S.settings.zoom = v; save(); renderSettings();
    });
    el("resetBtn").addEventListener("click", resetAll);
    el("bookReviewBtn").addEventListener("click", function () { startSession("mixed"); });

    document.addEventListener("keydown", function (e) {
      if (el("screen-quiz").classList.contains("active") && (e.key === "Enter" || e.key === " ")) {
        if (!el("sheet").hidden) { e.preventDefault(); nextQ(); }
      }
      if (e.key === "Escape") { el("screen-quiz").className = "screen"; show("home"); }
    });

    renderHome();
    show("home");

    var q = new URLSearchParams(location.search);
    var h = q.get("s");
    if (h === "map" || h === "capital" || h === "keyword" || h === "mixed") startSession(h);
    if (q.get("v") === "book") show("book");
    if (q.get("v") === "settings") show("settings");

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(function () {});
    }
  }

  window.__buildMap = buildMap;
  window.__baseView = baseView;
  window.__hitTest = hitTest;
  window.__applyVB = function (svg) { applyVB(svg); };
  window.__paths = MAP_PATHS;

  if (!document.getElementById("screen-home")) return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
