/* トドケン — アプリ本体
   学習設計:
   - 想起（思い出す）を毎問1回必ず発生させる
   - 誤答は「なぜ」を1行返し、同じ項目を3問後に再出題（即時再学習）
   - 正答は間隔をあけて再出題（1→3→7→16→35日）
   - 誤答した項目は「まちがいノート」に残す
*/
(function () {
  "use strict";

  /* 万一のエラーを画面とログに出す（学習記録を壊さないため） */
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
  var INTERVALS = [0, 1, 3, 7, 16, 35];      // box 0..5
  var SESSION_SIZE = 10;

  var S = {
    items: {},                                  // "mode:id" -> {b,d,n,seen}
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
    } catch (e) { /* 初回・プライベートモード */ }
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
  function bumpToday() {
    touchPlay();
    S.today.n += 1;
    save();
  }

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

  /* 習熟度: 3モードの平均boxから 0..3 の段階へ */
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

  /* ---------------- map ---------------- */
  var NS = "http://www.w3.org/2000/svg";
  var ZONES = {};
  PREF.forEach(function (p) {
    (ZONES[p.region] = ZONES[p.region] || []).push(p.id);
  });

  function buildMap(opt) {
    opt = opt || {};
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 438 516");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("class", "jp");
    var g = document.createElementNS(NS, "g");
    g.setAttribute("class", "zoom");
    PREF.forEach(function (p) {
      var path = document.createElementNS(NS, "path");
      path.setAttribute("d", MAP_PATHS[p.id]);
      path.setAttribute("class", "pref" + (opt.interactive ? " hoverable" : ""));
      path.setAttribute("data-id", p.id);
      g.appendChild(path);
    });
    svg.appendChild(g);
    svg._zoom = g;
    return svg;
  }

  /* 47県全体が枠に収まるよう viewBox を実測して合わせる */
  function fitAll(svg) {
    var paths = svg._zoom.querySelectorAll(".pref");
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (var i = 0; i < paths.length; i++) {
      var b = paths[i].getBBox();
      if (b.width === 0) continue;
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
    }
    if (x0 > x1) return;
    var pad = 6;
    svg.setAttribute("viewBox", (x0 - pad) + " " + (y0 - pad) + " " +
      (x1 - x0 + pad * 2) + " " + (y1 - y0 + pad * 2));
    svg._base = svg.getAttribute("viewBox").split(" ").map(Number);
  }

  /* 地方にズーム。zone=null で全国 */
  function fitZone(svg, zone) {
    var g = svg._zoom;
    if (!svg._base) svg._base = [0, 0, 438, 516];
    if (!zone) { g.setAttribute("transform", ""); return; }
    var BW = svg._base[2], BH = svg._base[3];
    var ids = ZONES[zone] || [];
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    ids.forEach(function (id) {
      var b = g.querySelector('[data-id="' + id + '"]').getBBox();
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
    });
    var w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1);
    var s = Math.min(BW / w, BH / h) * 0.92;
    s = Math.max(1, Math.min(7, s));
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    g.setAttribute("transform", "translate(" + (BW / 2 - s * cx) + "," + (BH / 2 - s * cy) + ") scale(" + s + ")");
  }

  function paint(svg, fn) {
    var paths = svg.querySelectorAll(".pref");
    for (var i = 0; i < paths.length; i++) {
      var cls = fn(paths[i].getAttribute("data-id"));
      if (cls) paths[i].setAttribute("class", "pref " + cls);
    }
  }

  /* 小さい県を最前面に置く透明レイヤ（タップ判定用） */
  function addTouchLayer(svg, onTap) {
    var g = svg._zoom;
    var order = [];
    var paths = g.querySelectorAll(".pref");
    for (var i = 0; i < paths.length; i++) {
      var b = paths[i].getBBox();
      order.push({ d: paths[i].getAttribute("d"), id: paths[i].getAttribute("data-id"), a: b.width * b.height });
    }
    order.sort(function (p, q) { return q.a - p.a; });
    var layer = document.createElementNS(NS, "g");
    order.forEach(function (o) {
      var h = document.createElementNS(NS, "path");
      h.setAttribute("d", o.d);
      h.setAttribute("class", "halo");
      h.setAttribute("data-id", o.id);
      layer.appendChild(h);
    });
    layer.addEventListener("click", function (e) {
      var t = e.target;
      var id = t && t.getAttribute ? t.getAttribute("data-id") : null;
      if (id) onTap(id);
    });
    layer.setAttribute("class", "touch");
    g.appendChild(layer);
  }

  function addLabel(svg, id, text, cls) {
    var g = svg._zoom;
    var p = g.querySelector('.pref[data-id="' + id + '"]');
    if (!p) return;
    var b = p.getBBox();
    var t = document.createElementNS(NS, "text");
    t.setAttribute("x", b.x + b.width / 2);
    t.setAttribute("y", b.y + b.height / 2 + 4);
    t.setAttribute("class", "lbl " + (cls || ""));
    t.textContent = text;
    g.appendChild(t);
  }

  /* ---------------- home ---------------- */
  function renderHome() {
    var m = masteredCount();
    el("masterNum").textContent = m;
    if (el("masterBar")) el("masterBar").style.width = (m / 47 * 100).toFixed(1) + "%";

    var due = dueCount();
    var t = todayIndex();
    touchPlay();
    var doneToday = S.today.n;
    var goal = 10;
    el("dueLabel").textContent = due > 0 ? due + "問たまっています" : (doneToday > 0 ? "今日は " + doneToday + "問 解きました" : "まずは10問から");
    el("dueTitle").textContent = due > 0 ? "今日の復習" : (doneToday > 0 ? "もう少しやる" : "はじめる");

    var pct = Math.min(1, doneToday / goal);
    var circ = 2 * Math.PI * 26;
    var ring = el("ringFill");
    ring.setAttribute("stroke-dasharray", circ.toFixed(1));
    ring.setAttribute("stroke-dashoffset", (circ * (1 - pct)).toFixed(1));
    el("ringNum").innerHTML = doneToday + "<small>問</small>";

    var st = S.streak.count || 0;
    el("streakNum").textContent = st;

    MODES.forEach(function (mode) {
      var n = modeMastery(mode);
      el("cnt-" + mode).innerHTML = n + "<b>/47</b>";
      el("cnt-" + mode).innerHTML = "<b>" + n + "</b>/47";
    });

    // 地図
    var slot = el("homeMap");
    slot.innerHTML = "";
    var svg = buildMap({});
    slot.appendChild(svg);
    requestAnimationFrame(function () { fitAll(svg); });
    var paths = svg.querySelectorAll(".pref");
    for (var i = 0; i < paths.length; i++) {
      var lv = levelOf(BY_ID[paths[i].getAttribute("data-id")]);
      paths[i].style.fill = ["#dccfae", "#b9bda0", "#7ba487", "#2f7d5c"][lv];
    }
  }

  /* ---------------- session ---------------- */
  var ses = null;

  /* 出題候補を優先度順に */
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
      var per = { map: [], capital: [], keyword: [] };
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
    show("quiz");
    renderQ();
  }

  function renderQ() {
    var cur = ses.q[ses.i];
    var p = cur.p, mode = cur.mode;
    var it = getItem(mode, p.id);
    ses.answered = false;
    ses.tries = 0;

    // progress
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
    var svg = buildMap({ interactive: true });
    frame.appendChild(svg);

    var zone = ses.mode === "mixed" ? null : null;
    if (S.settings.zoom === "always") zone = p.region;
    else if (S.settings.zoom === "auto") zone = it.b < 3 ? p.region : null;
    var tag = document.createElement("div");
    tag.className = "zoom-tag";
    tag.textContent = zone ? zone + "だけ表示" : "全国";
    frame.appendChild(tag);

    area.appendChild(frame);
    body.appendChild(area);

    addTouchLayer(svg, function (id) { onMapTap(svg, id, p); });
    requestAnimationFrame(function () { fitAll(svg); fitZone(svg, zone); });
    ses.svg = svg;
  }

  function onMapTap(svg, id, p) {
    if (ses.answered) return;
    if (id === p.id) {
      ses.answered = true;
      markMapOk(svg, p);
      grade(true);
      return;
    }
    // 誤答：1回目は再挑戦させる（学習のため）。3回目で答えを開く。
    ses.tries++;
    var wrong = svg.querySelector('.pref[data-id="' + id + '"]');
    if (wrong) { wrong.classList.add("ng"); }
    var frame = svg.parentNode;
    var old = frame.querySelector(".toast");
    if (old) old.remove();
    var toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = "ちがいます — 押したのは" + BY_ID[id].name;
    frame.appendChild(toast);
    setTimeout(function () { if (toast.parentNode) toast.remove(); }, 1100);
    svg.classList.add("nudge");
    if (!S.settings.sound) {} else sndNg();
    if (ses.tries >= 2) {
      ses.answered = true;
      markMapOk(svg, p);
      grade(false);
    }
  }

  function markMapOk(svg, p) {
    var paths = svg.querySelectorAll(".pref");
    for (var i = 0; i < paths.length; i++) {
      paths[i].classList.remove("hoverable");
      var id = paths[i].getAttribute("data-id");
      if (id !== p.id && !paths[i].classList.contains("ng")) paths[i].classList.add("dim");
    }
    var ans = svg.querySelector('.pref[data-id="' + p.id + '"]');
    if (ans) { ans.classList.remove("dim", "ng"); ans.classList.add("ok"); }
    addLabel(svg, p.id, shortName(p));
    if (S.settings.zoom !== "always") fitZone(svg, null);
    var layer = svg.querySelector(".touch");
    if (layer) layer.remove();
  }

  function renderCapitalQ(body, p) {
    var area = document.createElement("div");
    area.className = "map-area";
    var frame = document.createElement("div");
    frame.className = "map-frame";
    var svg = buildMap({});
    frame.appendChild(svg);
    area.appendChild(frame);

    var paths = svg.querySelectorAll(".pref");
    for (var i = 0; i < paths.length; i++) {
      if (paths[i].getAttribute("data-id") !== p.id) paths[i].classList.add("dim");
    }
    var ans = svg.querySelector('.pref[data-id="' + p.id + '"]');
    if (ans) { ans.classList.remove("dim"); ans.style.fill = "#c3b393"; }
    body.appendChild(area);
    requestAnimationFrame(function () {
      fitAll(svg);
      fitZone(svg, p.region);
      addLabel(svg, p.id, shortName(p), "lbl-on-light");
    });

    // 選択肢：同じ地方の県庁所在地を優先
    var others = PREF.filter(function (x) { return x.id !== p.id; });
    var same = shuffle(others.filter(function (x) { return x.region === p.region; }));
    var diff = shuffle(others.filter(function (x) { return x.region !== p.region; }));
    var pick = same.slice(0, 3);
    var k = 0;
    while (pick.length < 3) pick.push(diff[k++]);
    var opts = shuffle([p].concat(pick));

    var wrap = document.createElement("div");
    wrap.className = "opts";
    opts.forEach(function (o) {
      var b = document.createElement("button");
      b.className = "opt";
      b.textContent = o.capital;
      b.addEventListener("click", function () { onChoose(b, o, p, "capital", wrap); });
      wrap.appendChild(b);
    });
    body.appendChild(wrap);
  }

  function renderKeywordQ(body, p) {
    var wrap = document.createElement("div");
    wrap.innerHTML = "";
    var chips = document.createElement("div");
    chips.className = "chips";
    p.items.forEach(function (it, i) {
      var c = document.createElement("div");
      c.className = "chip" + (p.items.length === 5 && i === 4 && p.items[4].t.length > 9 ? " wide" : "");
      c.style.animationDelay = (i * 40) + "ms";
      c.innerHTML = '<span class="cat">' + it.c + "</span><span class=\"txt\">" + it.t + "</span>";
      chips.appendChild(c);
    });
    body.appendChild(chips);

    var others = PREF.filter(function (x) { return x.id !== p.id; });
    var same = shuffle(others.filter(function (x) { return x.region === p.region; }));
    var diff = shuffle(others.filter(function (x) { return x.region !== p.region; }));
    var pick = same.slice(0, 2);
    var k = 0;
    while (pick.length < 3) pick.push(diff[k++]);

    var wrap2 = document.createElement("div");
    wrap2.className = "opts";
    shuffle([p].concat(pick)).forEach(function (o) {
      var b = document.createElement("button");
      b.className = "opt";
      b.textContent = o.name;
      b.addEventListener("click", function () { onChoose(b, o, p, "keyword", wrap2); });
      wrap2.appendChild(b);
    });
    body.appendChild(wrap2);
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

  /* 採点 & 記録 */
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
      // 3問後に再出題（即時再学習）
      var again = ses.i + 3;
      if (again < ses.q.length && !ses.q[again].again) {
        ses.q.splice(again, 0, { mode: mode, p: p, again: true });
      } else if (again < ses.q.length) {
        ses.q.splice(again + 1, 0, { mode: mode, p: p, again: true });
      }
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

    var body = el("sheetBody");
    var html = "";
    if (mode === "map" && !p.same) {
      html += '<div class="why"><span class="c">由来</span><span class="w">' + p.capWhy + "</span></div>";
    }
    p.items.forEach(function (it) {
      html += '<div class="why"><span class="c">' + it.c + "</span><span><b>" + it.t + "</b> <span class=\"w\">— " + it.w + "</span></span></div>";
    });
    body.innerHTML = html;
    body.hidden = false;
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
      c === 1 ? "全問正解。この範囲はもう定着しています。次は全国モードで試すか、別のモードへ。" :
      c >= 0.8 ? "よく入っています。間違えた県だけ、明日もう一度出ます。" :
      c >= 0.5 ? "半分は定着。間違えた県は明日また出ます。今日はここまでで十分。" :
      "まだ手をつけた段階。間違えた県だけ、明日もう一度出ます。";

    // streak
    var t = todayIndex();
    if (S.streak.last === t) { /* 同日2回目 */ }
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
      var lv = "×" + r.it.n;
      return '<div class="book-row"><span class="badge">' + MODE_LABEL[r.mode] + '</span>' +
        '<span class="nm">' + r.p.name + "<small>" + r.p.items[0].t + " ／ " + r.p.capital + "</small></span>" +
        '<span class="due"><b>' + due + "</b>" + lv + "</span></div>";
    }).join("");
  }

  /* ---------------- settings ---------------- */
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
    renderHome();
    alert("消去しました。");
    show("home");
  }

  /* ---------------- wire up ---------------- */
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
    el("quitBtn").addEventListener("click", function () { show("home"); });
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
    el("bookReviewBtn").addEventListener("click", function () {
      startSession("mixed");
    });

    document.addEventListener("keydown", function (e) {
      if (el("screen-quiz").classList.contains("active") && (e.key === "Enter" || e.key === " ")) {
        if (!el("sheet").hidden) { e.preventDefault(); nextQ(); }
      }
      if (e.key === "Escape") show("home");
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

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
