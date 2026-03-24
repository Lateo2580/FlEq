// テーマ切替
(function () {
  const toggle = document.getElementById('theme-toggle');
  const html = document.documentElement;

  // localStorage > OS preference > light
  function getPreferred() {
    const stored = localStorage.getItem('theme');
    if (stored) return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  function apply(theme) {
    html.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }

  apply(getPreferred());

  toggle.addEventListener('click', function () {
    var current = html.getAttribute('data-theme');
    apply(current === 'dark' ? 'light' : 'dark');
  });
})();

// コピーボタン
document.querySelectorAll('.copy-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var text = btn.getAttribute('data-copy');
    navigator.clipboard.writeText(text).then(function () {
      var original = btn.textContent;
      btn.textContent = 'コピー済み';
      setTimeout(function () {
        btn.textContent = original;
      }, 1500);
    }).catch(function () {
      // Clipboard API unavailable (non-HTTPS or denied permission) — silent fail
    });
  });
});

// スムーススクロール
document.querySelectorAll('a[href^="#"]').forEach(function (a) {
  a.addEventListener('click', function (e) {
    var target = document.querySelector(a.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth' });
    }
  });
});
