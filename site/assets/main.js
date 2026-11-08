// Kelpi landing page behaviour. Everything here is progressive: without it the page
// still reads top to bottom and every download link points at the latest release page.
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function storageGet(key) {
    try { return window.sessionStorage.getItem(key); } catch (e) { return null; }
  }

  function storageSet(key, value) {
    try { window.sessionStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }

  // ---------- Latest release: point every download link at the DMG ----------

  var RELEASE_API = 'https://api.github.com/repos/benfriebe/kelpi/releases/latest';
  var RELEASE_CACHE = 'kelpi.release.v1';

  function describeRelease(release) {
    var parts = ['Version ' + release.version];
    if (release.size) parts.push(Math.round(release.size / 1e6) + ' MB');
    if (release.published) {
      var date = new Date(release.published);
      if (!isNaN(date.getTime())) {
        parts.push('released ' + date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
      }
    }
    return parts.join(' · ');
  }

  function applyRelease(release) {
    document.querySelectorAll('[data-download]').forEach(function (link) {
      link.href = release.url;
    });
    document.querySelectorAll('[data-release]').forEach(function (meta) {
      var text = meta.querySelector('[data-release-text]');
      if (text) text.textContent = describeRelease(release);
      meta.classList.add('is-ready');
    });
  }

  function releaseUnavailable() {
    // Links keep their fallback: the release page on GitHub.
    document.querySelectorAll('[data-release]').forEach(function (meta) {
      meta.classList.add('is-ready');
    });
  }

  function loadRelease() {
    var cached = storageGet(RELEASE_CACHE);
    if (cached) {
      try {
        applyRelease(JSON.parse(cached));
        return;
      } catch (e) { /* fall through to a fresh lookup */ }
    }

    if (!window.fetch) { releaseUnavailable(); return; }

    var controller = window.AbortController ? new AbortController() : null;
    var timer = window.setTimeout(function () { if (controller) controller.abort(); }, 5000);

    fetch(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller ? controller.signal : undefined
    })
      .then(function (response) {
        if (!response.ok) throw new Error('GitHub answered ' + response.status);
        return response.json();
      })
      .then(function (data) {
        var assets = Array.isArray(data.assets) ? data.assets : [];
        var dmg = assets.filter(function (asset) { return /arm64\.dmg$/i.test(asset.name || ''); })[0];
        if (!dmg || !dmg.browser_download_url) throw new Error('No DMG in the latest release');
        var release = {
          url: dmg.browser_download_url,
          version: String(data.tag_name || data.name || '').replace(/^v/i, ''),
          size: dmg.size || 0,
          published: data.published_at || ''
        };
        storageSet(RELEASE_CACHE, JSON.stringify(release));
        applyRelease(release);
      })
      .catch(releaseUnavailable)
      .then(function () { window.clearTimeout(timer); });
  }

  // ---------- Navigation: mobile menu and current section ----------

  function setupMenu() {
    var toggle = document.querySelector('.nav-toggle');
    var menu = document.getElementById('mobile-menu');
    if (!toggle || !menu) return;

    function setOpen(open) {
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      menu.classList.toggle('is-open', open);
      document.documentElement.classList.toggle('menu-open', open);
      if (open) {
        menu.removeAttribute('inert');
      } else {
        menu.setAttribute('inert', '');
      }
    }

    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });

    menu.addEventListener('click', function (event) {
      if (event.target.closest('a')) setOpen(false);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setOpen(false);
        toggle.focus();
      }
    });

    window.matchMedia('(min-width: 768px)').addEventListener('change', function (query) {
      if (query.matches) setOpen(false);
    });
  }

  function setupCurrentSection() {
    var links = Array.prototype.slice.call(document.querySelectorAll('[data-nav]'));
    if (!links.length || !('IntersectionObserver' in window)) return;

    var sections = links
      .map(function (link) { return document.getElementById(link.getAttribute('data-nav')); })
      .filter(Boolean);
    var visible = new Map();

    function update() {
      var current = null;
      sections.forEach(function (section) {
        if (visible.get(section) && !current) current = section.id;
      });
      links.forEach(function (link) {
        if (link.getAttribute('data-nav') === current) {
          link.setAttribute('aria-current', 'true');
        } else {
          link.removeAttribute('aria-current');
        }
      });
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) { visible.set(entry.target, entry.isIntersecting); });
      update();
    }, { rootMargin: '-45% 0px -50% 0px' });

    sections.forEach(function (section) { observer.observe(section); });
  }

  // ---------- Scroll reveals: once per element ----------

  function setupReveals() {
    var items = document.querySelectorAll('[data-reveal]');
    if (!('IntersectionObserver' in window)) {
      items.forEach(function (item) { item.classList.add('is-visible'); });
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.05 });
    items.forEach(function (item) { observer.observe(item); });
  }

  // ---------- Tagline: words light up in reading order as they cross a line ----------

  function setupTagline() {
    var block = document.querySelector('[data-tagline]');
    if (!block) return;

    block.querySelectorAll('.line').forEach(function (line) {
      var words = line.textContent.trim().split(/\s+/);
      line.textContent = '';
      words.forEach(function (word, index) {
        var span = document.createElement('span');
        span.className = 'word';
        span.textContent = word;
        line.appendChild(span);
        if (index < words.length - 1) line.appendChild(document.createTextNode(' '));
      });
    });

    var words = Array.prototype.slice.call(block.querySelectorAll('.word'));

    if (reduceMotion.matches) {
      words.forEach(function (word) { word.classList.add('is-lit'); });
      return;
    }

    var frame = 0;
    var listening = false;

    var litCount = 0;

    function measure() {
      frame = 0;
      // Progress runs from the block's top reaching 80% of the viewport to its bottom
      // reaching 40%. Each step of progress lights the next word in reading order, so
      // words arrive one at a time, never a whole line at once. Lit words stay lit.
      var box = block.getBoundingClientRect();
      var viewport = window.innerHeight;
      var start = box.top - viewport * 0.8;
      var end = box.bottom - viewport * 0.4;
      var progress = start >= 0 ? 0 : Math.min(1, -start / (end - start));
      var target = Math.ceil(progress * words.length);
      while (litCount < target) {
        words[litCount].classList.add('is-lit');
        litCount += 1;
      }
      if (litCount >= words.length) stop();
    }

    function onScroll() {
      if (!frame) frame = window.requestAnimationFrame(measure);
    }

    function start() {
      if (listening) return;
      listening = true;
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll, { passive: true });
      onScroll();
    }

    function stop() {
      if (!listening) return;
      listening = false;
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    }

    if (!('IntersectionObserver' in window)) {
      start();
      return;
    }

    new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { start(); } else { stop(); measure(); }
      });
    }).observe(block);
  }

  // ---------- Copy buttons ----------

  function setupCopy() {
    document.querySelectorAll('[data-copy]').forEach(function (button) {
      var wrap = button.closest('.snippet-wrap');
      var source = wrap && wrap.querySelector('[data-copy-source]');
      var label = button.querySelector('[data-copy-label]');
      var error = wrap && wrap.querySelector('.copy-error');
      var timer = 0;
      if (!source || !label) return;

      button.addEventListener('click', function () {
        var text = source.textContent.trim();
        var write = navigator.clipboard && navigator.clipboard.writeText
          ? navigator.clipboard.writeText(text)
          : Promise.reject(new Error('Clipboard unavailable'));

        write.then(function () {
          if (error) error.textContent = '';
          button.classList.add('is-copied');
          label.textContent = 'Copied';
          window.clearTimeout(timer);
          timer = window.setTimeout(function () {
            button.classList.remove('is-copied');
            label.textContent = 'Copy';
          }, 2000);
        }, function () {
          if (error) error.textContent = 'Copy failed. Select the command and copy it by hand.';
        });
      });
    });
  }

  function init() {
    loadRelease();
    setupMenu();
    setupCurrentSection();
    setupReveals();
    setupTagline();
    setupCopy();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
