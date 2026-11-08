// The hero's ASCII kelpie. The logo SVG is rasterised once, split into stroke, face and
// background cells, then drawn as terminal characters on a canvas: dense glyphs on the
// line art, a slow ripple through the face, a sparse dot field around it. Characters
// decode out of noise on load, scramble around the pointer, and now and then an edge
// glints in the app's running green or waiting blue.
(function () {
  'use strict';

  var canvas = document.querySelector('[data-ascii]');
  if (!canvas || !canvas.getContext) return;

  var ctx = canvas.getContext('2d');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

  var FILL = ' .:;+*';
  var DENSE = '#@%&';
  var SCRAMBLE = '<>/\\|_=+*#01{}[]~^:;';
  var RUNNING = '95, 190, 137';
  var WAITING = '111, 155, 216';
  var FONT = '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace';
  var INTRO_MS = 1800;
  var FRAME_MS = 1000 / 30;

  var field = null;   // rasterised logo masks
  var grid = null;    // cells for the current canvas size
  var pointer = { x: -9999, y: -9999, active: false };
  var glints = [];
  var startTime = 0;
  var lastFrame = 0;
  var lastGlint = 0;
  var running = false;
  var visible = true;
  var rafId = 0;

  function hash(a, b) {
    var h = (a * 374761393 + b * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967295;
  }

  function easeOut(p) {
    // matches the page's cubic-bezier(0.22, 1, 0.36, 1) closely enough for a reveal
    return 1 - Math.pow(1 - p, 4);
  }

  // ---------- Rasterise the logo into masks ----------

  function buildField(image) {
    var S = 512;
    var off = document.createElement('canvas');
    off.width = S;
    off.height = S;
    var g = off.getContext('2d', { willReadFrequently: true });
    g.drawImage(image, 0, 0, S, S);
    var px = g.getImageData(0, 0, S, S).data;
    var stroke = new Uint8Array(S * S);
    var minX = S, minY = S, maxX = 0, maxY = 0;
    for (var i = 0; i < S * S; i++) {
      var lum = px[i * 4] * 0.2126 + px[i * 4 + 1] * 0.7152 + px[i * 4 + 2] * 0.0722;
      if (lum > 128) {
        stroke[i] = 1;
        var x = i % S, y = (i / S) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    // Close small gaps in the line art, then flood the outside from the border.
    // Whatever the flood cannot reach is the face.
    var closed = dilate(stroke, S, 5);
    var outside = new Uint8Array(S * S);
    var stack = new Int32Array(S * S);
    var top = 0;
    function seed(idx) {
      if (!closed[idx] && !outside[idx]) { outside[idx] = 1; stack[top++] = idx; }
    }
    for (var e = 0; e < S; e++) {
      seed(e); seed((S - 1) * S + e); seed(e * S); seed(e * S + S - 1);
    }
    while (top > 0) {
      var idx = stack[--top];
      var cx = idx % S;
      if (cx > 0) seed(idx - 1);
      if (cx < S - 1) seed(idx + 1);
      if (idx >= S) seed(idx - S);
      if (idx < S * (S - 1)) seed(idx + S);
    }
    var inside = new Uint8Array(S * S);
    for (var k = 0; k < S * S; k++) inside[k] = !outside[k] && !stroke[k] ? 1 : 0;

    return { S: S, raw: stroke, stroke: dilate(stroke, S, 1), inside: inside, box: { x0: minX, y0: minY, x1: maxX, y1: maxY } };
  }

  function dilate(mask, S, r) {
    var tmp = new Uint8Array(S * S);
    var out = new Uint8Array(S * S);
    var x, y, d;
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        if (!mask[y * S + x]) continue;
        for (d = -r; d <= r; d++) {
          var nx = x + d;
          if (nx >= 0 && nx < S) tmp[y * S + nx] = 1;
        }
      }
    }
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        if (!tmp[y * S + x]) continue;
        for (d = -r; d <= r; d++) {
          var ny = y + d;
          if (ny >= 0 && ny < S) out[ny * S + x] = 1;
        }
      }
    }
    return out;
  }

  // ---------- Fit a character grid to the canvas ----------

  function buildGrid() {
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);

    // Aim for cells about 6px wide on a desktop, a little smaller on phones.
    var targetCell = rect.width < 420 ? 4.75 : 6;
    var cols = Math.max(48, Math.min(120, Math.round(rect.width / targetCell)));
    var cellW = rect.width / cols;
    var fontSize = cellW / 0.6;
    var cellH = fontSize * 1.18;
    var rows = Math.floor(rect.height / cellH);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '500 ' + fontSize.toFixed(2) + 'px ' + FONT;
    ctx.textBaseline = 'top';
    var measured = ctx.measureText('M').width;
    var xPad = Math.max(0, (cellW - measured) / 2);

    // Fit the art into the canvas with some air around it.
    var box = field.box;
    var artW = box.x1 - box.x0, artH = box.y1 - box.y0;
    var scale = Math.min((rect.width * 0.86) / artW, (rect.height * 0.86) / artH);
    var offX = (rect.width - artW * scale) / 2 - box.x0 * scale;
    var offY = (rect.height - artH * scale) / 2 - box.y0 * scale;

    var n = cols * rows;
    var type = new Uint8Array(n);      // 0 background, 1 face, 2 line
    var edge = new Float32Array(n);
    var glyph = new Array(n);
    var seed = new Float32Array(n);
    var dist = new Float32Array(n);
    var S = field.S;
    var SUB = 4;

    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var i = r * cols + c;
        var onStroke = 0, onFace = 0;
        for (var sy = 0; sy < SUB; sy++) {
          for (var sx = 0; sx < SUB; sx++) {
            var px = ((c + (sx + 0.5) / SUB) * cellW - offX) / scale;
            var py = ((r + (sy + 0.5) / SUB) * cellH - offY) / scale;
            var ix = px | 0, iy = py | 0;
            if (ix < 0 || iy < 0 || ix >= S || iy >= S) continue;
            var k = iy * S + ix;
            if (field.stroke[k]) onStroke++;
            else if (field.inside[k]) onFace++;
          }
        }
        var total = SUB * SUB;
        seed[i] = hash(c + 17, r + 101);
        if (onStroke / total > 0.18) {
          type[i] = 2;
          edge[i] = onStroke / total;
          glyph[i] = lineGlyph(c, r);
        } else if (onFace / total > 0.45) {
          type[i] = 1;
        }
      }
    }

    // Distance from the line art through the face, in cells, for an inner glow.
    var queue = new Int32Array(n);
    var head = 0, tail = 0;
    for (var q = 0; q < n; q++) {
      if (type[q] === 2) { dist[q] = 0; queue[tail++] = q; } else { dist[q] = 1e9; }
    }
    while (head < tail) {
      var cur = queue[head++];
      var cc = cur % cols, cr = (cur / cols) | 0;
      var nbrs = [cc > 0 ? cur - 1 : -1, cc < cols - 1 ? cur + 1 : -1, cr > 0 ? cur - cols : -1, cr < rows - 1 ? cur + cols : -1];
      for (var b = 0; b < 4; b++) {
        var nb = nbrs[b];
        if (nb < 0 || type[nb] !== 1 || dist[nb] <= dist[cur] + 1) continue;
        dist[nb] = dist[cur] + 1;
        queue[tail++] = nb;
      }
    }

    // Pick a character that follows the stroke through this cell: the principal axis of
    // the stroke pixels around it decides between - / | \\ and _, and a blob with no
    // clear direction (a junction, the eye, the nose) gets a dense glyph instead.
    function lineGlyph(c, r) {
      var x0 = ((c - 0.25) * cellW - offX) / scale, x1 = ((c + 1.25) * cellW - offX) / scale;
      var y0 = ((r - 0.25) * cellH - offY) / scale, y1 = ((r + 1.25) * cellH - offY) / scale;
      var sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, count = 0;
      for (var yy = Math.max(0, y0 | 0); yy < Math.min(S, Math.ceil(y1)); yy++) {
        for (var xx = Math.max(0, x0 | 0); xx < Math.min(S, Math.ceil(x1)); xx++) {
          if (!field.raw[yy * S + xx]) continue;
          // measure in screen units so the cell's aspect does not skew the angle
          var u = xx * scale + offX, v = yy * scale + offY;
          sx += u; sy += v; sxx += u * u; syy += v * v; sxy += u * v; count++;
        }
      }
      if (count < 3) return '·';
      var mx = sx / count, my = sy / count;
      var cxx = sxx / count - mx * mx, cyy = syy / count - my * my, cxy = sxy / count - mx * my;
      var tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
      var gap = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      var l1 = tr / 2 + gap, l2 = tr / 2 - gap;
      if (l1 <= 0 || l2 / l1 > 0.45) return DENSE[(hash(c, r) * DENSE.length) | 0];
      // eigenvector for l1 is (cxy, l1 - cxx); flip y so angles read like a maths plot
      var deg = (Math.atan2(-(l1 - cxx), cxy) * 180 / Math.PI + 360) % 180;
      if (cxy === 0 && l1 === cxx) deg = 0;
      var slant = Math.atan2(cellH, cellW) * 180 / Math.PI; // the angle a / glyph draws at
      var lo = slant / 2, hi = (slant + 90) / 2;
      if (deg < lo || deg >= 180 - lo) {
        return (my - r * cellH) / cellH > 0.62 ? '_' : '-';
      }
      if (deg < hi) return '/';
      if (deg < 180 - hi) return '|';
      return '\\';
    }

    var edges = [];
    for (var m = 0; m < n; m++) if (type[m] === 2) edges.push(m);

    return {
      cols: cols, rows: rows, cellW: cellW, cellH: cellH, xPad: xPad,
      width: rect.width, height: rect.height,
      type: type, edge: edge, glyph: glyph, seed: seed, dist: dist, edges: edges
    };
  }

  // ---------- Drawing ----------

  function draw(now) {
    if (!grid) return;
    var g = grid;
    var t = (now - startTime) / 1000;
    var intro = reduceMotion.matches ? 1 : Math.min(1, (now - startTime) / INTRO_MS);
    var lens = pointer.active && !reduceMotion.matches ? Math.min(g.width, g.height) * 0.16 : 0;
    var tick = Math.floor(t * 14);

    ctx.clearRect(0, 0, g.width, g.height);
    ctx.fillStyle = '#ffffff';

    for (var r = 0; r < g.rows; r++) {
      var y = r * g.cellH;
      for (var c = 0; c < g.cols; c++) {
        var i = r * g.cols + c;
        var type = g.type[i];
        var seed = g.seed[i];
        var x = c * g.cellW;

        // pointer lens
        var k = 0;
        if (lens) {
          var dx = x + g.cellW / 2 - pointer.x;
          var dy = y + g.cellH / 2 - pointer.y;
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d < lens) { k = 1 - d / lens; k = k * k; }
        }

        // intro: rows decode top to bottom with some scatter
        var revealAt = (r / g.rows) * 0.7 + seed * 0.3;
        var revealed = intro >= revealAt;

        var ch = '';
        var alpha = 0;

        if (type === 2) {
          var flick = hash(c, tick + Math.floor(seed * 40)) > 0.992;
          ch = flick ? DENSE[(hash(r, tick) * DENSE.length) | 0] : g.glyph[i];
          alpha = 0.82 + 0.18 * g.edge[i];
        } else if (type === 1) {
          var w1 = Math.sin(c * 0.21 + r * 0.42 - t * 1.15);
          var w2 = Math.sin(c * 0.06 - r * 0.17 + t * 0.55);
          var wave = (w1 * 0.6 + w2 * 0.4) * 0.5 + 0.5;
          var glow = Math.exp(-g.dist[i] / 2.4);
          var light = 1 - r / g.rows;
          var level = 0.08 + 0.42 * wave + 0.3 * glow + 0.1 * light;
          var idx = Math.max(1, Math.min(FILL.length - 1, Math.round(level * (FILL.length - 1))));
          ch = FILL[idx];
          alpha = 0.1 + 0.42 * level;
        }

        if (!revealed) {
          if (type === 0 || intro === 0) continue;
          ch = SCRAMBLE[Math.floor(hash(c, r + tick) * SCRAMBLE.length)];
          alpha = 0.18 + 0.2 * (revealAt - intro);
        } else if (!reduceMotion.matches && intro < 1) {
          var settle = Math.min(1, (intro - revealAt) / 0.12);
          alpha *= easeOut(settle);
        }

        if (k > 0.04) {
          ch = SCRAMBLE[Math.floor(hash(c + tick, r) * SCRAMBLE.length)];
          alpha = Math.max(alpha, 0.16 + 0.8 * k);
        }

        if (type !== 0 && revealed) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#000000';
          ctx.fillRect(x, y, g.cellW + 0.5, g.cellH + 0.5);
          ctx.fillStyle = '#ffffff';
        }

        if (!ch || ch === ' ' || alpha <= 0.01) continue;
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.fillText(ch, x + g.xPad, y);
      }
    }

    // glints over the line art
    if (!reduceMotion.matches && intro >= 1) {
      for (var gi = glints.length - 1; gi >= 0; gi--) {
        var glint = glints[gi];
        var p = (now - glint.born) / glint.life;
        if (p >= 1) { glints.splice(gi, 1); continue; }
        var gc = glint.cell % g.cols, gr = (glint.cell / g.cols) | 0;
        var gx = gc * g.cellW, gy = gr * g.cellH;
        ctx.globalAlpha = 1;
        ctx.clearRect(gx, gy, g.cellW, g.cellH);
        ctx.globalAlpha = Math.sin(Math.PI * p);
        ctx.fillStyle = 'rgb(' + glint.color + ')';
        ctx.fillText(g.glyph[glint.cell], gx + g.xPad, gy);
        ctx.fillStyle = '#ffffff';
      }
    }

    ctx.globalAlpha = 1;
  }

  function spawnGlint(now) {
    if (!grid || !grid.edges.length) return;
    var cell = grid.edges[Math.floor(Math.random() * grid.edges.length)];
    glints.push({
      cell: cell,
      color: Math.random() < 0.65 ? RUNNING : WAITING,
      born: now,
      life: 1400 + Math.random() * 900
    });
  }

  function frame(now) {
    rafId = 0;
    if (!running) return;
    if (now - lastFrame >= FRAME_MS) {
      lastFrame = now;
      if (now - lastGlint > 420 && glints.length < 6) {
        lastGlint = now;
        spawnGlint(now);
      }
      draw(now);
    }
    rafId = window.requestAnimationFrame(frame);
  }

  function start() {
    if (running || reduceMotion.matches || !visible || document.hidden) return;
    running = true;
    rafId = window.requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (rafId) window.cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function relayout() {
    if (!field) return;
    grid = buildGrid();
    if (reduceMotion.matches || !running) draw(performance.now());
  }

  // ---------- Wiring ----------

  function onPointer(event) {
    var rect = canvas.getBoundingClientRect();
    pointer.x = event.clientX - rect.left;
    pointer.y = event.clientY - rect.top;
    pointer.active = true;
  }

  function init(image) {
    field = buildField(image);
    grid = buildGrid();
    startTime = performance.now();
    canvas.classList.add('is-ready');

    if (reduceMotion.matches) {
      draw(startTime + INTRO_MS);
    } else {
      start();
    }

    if (finePointer.matches) {
      var area = canvas.closest('.hero') || canvas;
      area.addEventListener('pointermove', onPointer, { passive: true });
      area.addEventListener('pointerleave', function () { pointer.active = false; });
    }

    if ('ResizeObserver' in window) {
      var pending = 0;
      new ResizeObserver(function () {
        if (pending) return;
        pending = window.requestAnimationFrame(function () { pending = 0; relayout(); });
      }).observe(canvas);
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) start(); else stop();
      }).observe(canvas);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });

    reduceMotion.addEventListener('change', function () {
      if (reduceMotion.matches) { stop(); draw(startTime + INTRO_MS); } else { start(); }
    });
  }

  var image = new Image();
  image.decoding = 'async';
  image.src = canvas.getAttribute('data-src');

  var fontReady = document.fonts && document.fonts.load
    ? document.fonts.load('500 12px "Geist Mono"').catch(function () {})
    : Promise.resolve();
  var imageReady = image.decode ? image.decode() : new Promise(function (resolve, reject) {
    image.onload = resolve;
    image.onerror = reject;
  });

  Promise.all([imageReady, fontReady]).then(function () { init(image); }, function () {
    // The logo failed to load: leave the static fallback in place.
    canvas.classList.add('is-failed');
  });
})();
