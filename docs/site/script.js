// Progressive enhancement flag
document.documentElement.classList.add('js');

// ---------- Nav height (scroll-margin-top 動的算出) ----------
(function () {
  var navbar = document.querySelector('.navbar');
  if (!navbar) return;
  function update() {
    var h = navbar.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--nav-height', h + 'px');
  }
  update();
  window.addEventListener('resize', update);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(update).observe(navbar);
  }
})();

// ---------- Theme toggle ----------
(function () {
  var STORAGE_KEY = 'theme';
  var toggle = document.getElementById('theme-toggle');
  var html = document.documentElement;

  function apply(theme) {
    html.setAttribute('data-theme', theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) { /* private */ }
  }
  function readStored() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }

  var stored = readStored();
  if (stored === 'light' || stored === 'dark') {
    html.setAttribute('data-theme', stored);
  }
  // else: data-theme 未設定のまま、CSS の @media で OS 追従

  if (toggle) {
    toggle.addEventListener('click', function () {
      var current = html.getAttribute('data-theme');
      if (current !== 'light' && current !== 'dark') {
        var isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        current = isDark ? 'dark' : 'light';
      }
      apply(current === 'dark' ? 'light' : 'dark');
    });
  }
})();

// ---------- Copy button (未対応時は disabled + 隣接 .copy-btn-help を可視化) ----------
(function () {
  var btns = document.querySelectorAll('.copy-btn[data-copy]');
  if (!btns.length) return;

  function canCopy() {
    return !!(navigator.clipboard && typeof navigator.clipboard.writeText === 'function');
  }

  if (!canCopy()) {
    btns.forEach(function (btn) {
      btn.setAttribute('disabled', '');
      btn.setAttribute('aria-disabled', 'true');
      btn.title = 'このブラウザ / 環境ではクリップボード API が利用できません';
      // title tooltip + pointer-events:none の破綻を回避するため、隣接する .copy-btn-help span を可視化 (Codex §6-1)
      var help = btn.nextElementSibling;
      if (help && help.classList.contains('copy-btn-help')) {
        help.hidden = false;
      }
    });
    return;
  }

  // コピー成否を支援技術へ通知する共有 live region (JS 有効時のみ意味を持つため JS で生成)
  var copyStatus = document.createElement('span');
  copyStatus.className = 'visually-hidden';
  copyStatus.setAttribute('role', 'status');
  copyStatus.setAttribute('aria-live', 'polite');
  document.body.appendChild(copyStatus);
  function announceCopy(msg) {
    copyStatus.textContent = '';
    setTimeout(function () { copyStatus.textContent = msg; }, 30);
  }

  btns.forEach(function (btn) {
    // 復元値は初期ラベルに固定し、timer は 1 本に統一する
    // (連打時に「コピー済み」自体が復元値として保存され表示が戻らなくなるのを防ぐ)
    var originalLabel = btn.textContent;
    var restoreTimer = null;
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy');
      if (text == null) return;
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = 'コピー済み';
        announceCopy('コマンドをコピーしました');
        if (restoreTimer != null) clearTimeout(restoreTimer);
        restoreTimer = setTimeout(function () {
          btn.textContent = originalLabel;
          restoreTimer = null;
        }, 1500);
      }).catch(function () {
        announceCopy('コピーに失敗しました');
      });
    });
  });
})();

// ---------- Hero animation (generation ID + animationend cleanup with gen check) ----------
(function () {
  var overlay = document.querySelector('.hero-anim-overlay');
  var replay = document.querySelector('.hero-replay');
  if (!overlay) return;

  var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  var currentGen = 0;
  var scheduled = [];

  function motionAvailable() {
    return !mq.matches
      && typeof CSS !== 'undefined'
      && typeof CSS.supports === 'function'
      && CSS.supports('clip-path', 'inset(0)');
  }

  function clearScheduled() {
    scheduled.forEach(function (id) { clearTimeout(id); });
    scheduled = [];
  }

  function clearHighlights() {
    document.querySelectorAll('.is-highlight').forEach(function (el) {
      el.classList.remove('is-highlight');
    });
  }

  function createMarker(key) {
    // 名前空間指定で SVG <line> を作成 (旧 marker は playOnce のたびに DOM から detach するため、遅延到着した animationend event は e.target.parentNode !== overlay で無視できる)
    var m = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    m.setAttribute('class', 'hero-anim-marker');
    m.setAttribute('data-marker-for', key);
    m.setAttribute('pathLength', '100');
    m.setAttribute('x1', '0');
    m.setAttribute('y1', '0');
    m.setAttribute('x2', '0');
    m.setAttribute('y2', '0');
    return m;
  }

  function clearFadeState() {
    overlay.classList.remove('is-fading');
    var panes = overlay.parentNode;
    if (panes && panes.classList) panes.classList.remove('hero-fade');
  }

  function finishPlay() {
    overlay.classList.remove('is-playing');
    clearFadeState();
    clearHighlights();
  }

  function updateMotion() {
    var ok = motionAvailable();
    document.documentElement.classList.toggle('motion-ok', ok);
    if (replay) replay.hidden = !ok;
    if (!ok) {
      currentGen++;                              // 進行中の generation を無効化
      clearScheduled();
      finishPlay();
    }
  }

  function updateMarkerGeometry() {
    var panes = overlay.parentNode;
    if (!panes) return;
    var panesRect = panes.getBoundingClientRect();
    overlay.setAttribute('viewBox', '0 0 ' + panesRect.width + ' ' + panesRect.height);
    overlay.setAttribute('width', panesRect.width);
    overlay.setAttribute('height', panesRect.height);

    ['title', 'kind', 'area'].forEach(function (key) {
      var src = panes.querySelector('[data-hero-src-line="' + key + '"]');
      var out = panes.querySelector('[data-hero-out-line="' + key + '"]');
      var marker = overlay.querySelector('.hero-anim-marker[data-marker-for="' + key + '"]');
      if (!src || !out || !marker) return;
      var s = src.getBoundingClientRect();
      var o = out.getBoundingClientRect();
      marker.setAttribute('x1', (s.right - panesRect.left));
      marker.setAttribute('y1', (s.top + s.height / 2 - panesRect.top));
      marker.setAttribute('x2', (o.left - panesRect.left));
      marker.setAttribute('y2', (o.top + o.height / 2 - panesRect.top));
    });
  }

  function highlight(gen, key, on) {
    if (gen !== currentGen) return;  // 古い generation の呼出は無視
    ['data-hero-src-line', 'data-hero-out-line'].forEach(function (attr) {
      var el = document.querySelector('[' + attr + '="' + key + '"]');
      if (!el) return;
      if (on) el.classList.add('is-highlight');
      else el.classList.remove('is-highlight');
    });
  }

  function playOnce() {
    if (!motionAvailable()) return;

    // 進行中の generation を無効化 + cleanup (fade 中の再生 click にも対応)
    currentGen++;
    var gen = currentGen;
    clearScheduled();
    clearHighlights();
    clearFadeState();

    // marker 3 本を新規作成して置換 (Codex Plan v4 §B 対応: 旧 marker は DOM から detach され、
    // 旧 animation event は event.target.parentNode !== overlay で自動的に無視される)
    overlay.replaceChildren(createMarker('title'), createMarker('kind'), createMarker('area'));

    updateMarkerGeometry();

    overlay.classList.remove('is-playing');
    void overlay.offsetWidth;
    overlay.classList.add('is-playing');

    // highlight は 0s / 0.5s / 1.0s stagger で順に点灯し、消灯はしない (全 3 対が揃うまで保持)。
    // 描画完了 (1.5s) → 0.7s 保持 → 2.2s から線 + 枠を同時に 1.2s かけて fade out。総所要 約 3.4s。
    [
      { key: 'title', on: 0 },
      { key: 'kind',  on: 500 },
      { key: 'area',  on: 1000 }
    ].forEach(function (step) {
      scheduled.push(setTimeout(function () { highlight(gen, step.key, true); }, step.on));
    });
    scheduled.push(setTimeout(function () {
      if (gen !== currentGen) return;
      overlay.classList.add('is-fading');
      var panes = overlay.parentNode;
      if (panes && panes.classList) panes.classList.add('hero-fade');
    }, 2200));
    // fade (1.2s) 完了後の片付け。animationend が主経路、この timer は event 消失時の保険 (冪等)
    scheduled.push(setTimeout(function () {
      if (gen !== currentGen) return;
      finishPlay();
    }, 3600));
  }

  // animationend cleanup: 最後の marker (area) の fade 終了で全状態を片付ける。
  // draw 終了 (hero-marker-draw) では何もしない = 3 本表示のまま保持し、playOnce の timer が fade を開始する。
  // event.target が overlay の現行 child でない場合 (旧 marker が既に detach 済み) は無視 = generation 判定を DOM 帰属で成立させる (Codex Plan v4 §B 対応)
  overlay.addEventListener('animationend', function (e) {
    var marker = e.target;
    if (!marker || !marker.getAttribute) return;
    if (marker.parentNode !== overlay) return;   // 旧 (detach 済み) marker からの遅延 event
    if (marker.getAttribute('data-marker-for') !== 'area') return;
    if (e.animationName !== 'hero-marker-fade') return;  // draw 終了では片付けない (保持フェーズへ)
    finishPlay();
  });

  updateMotion();
  mq.addEventListener('change', updateMotion);

  window.addEventListener('resize', function () {
    if (overlay.classList.contains('is-playing')) updateMarkerGeometry();
  });

  // Google Fonts load 後の layout shift 追従
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      if (overlay.classList.contains('is-playing')) updateMarkerGeometry();
    });
  }

  if (motionAvailable()) {
    scheduled.push(setTimeout(playOnce, 300));
  }

  if (replay) {
    replay.addEventListener('click', playOnce);
  }
})();

// ---------- Smooth scroll (href="#" / 空 hash / 無効 selector で例外なし、reduced-motion 時は behavior:auto) ----------
(function () {
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var href = a.getAttribute('href');
      if (!href || href === '#' || href.length <= 1) return;
      var target;
      try { target = document.querySelector(href); }
      catch (err) { return; }
      if (target) {
        e.preventDefault();
        var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
      }
    });
  });
})();
