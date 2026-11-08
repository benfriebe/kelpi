# kelpi.sh

The landing page for Kelpi: plain HTML, CSS and a little JavaScript, with no build step.

```
site/
  index.html      the landing page
  privacy.html    what the site and the app send anywhere
  404.html        served for missing paths (uses absolute /assets paths)
  og.png          1200x630 social card
  assets/
    styles.css    tokens, named text styles, components
    main.js       release lookup, menu, current section, reveals, tagline, copy buttons
    ascii-hero.js the hero's ASCII kelpie, drawn on a canvas from favicon.svg
    herd-field.js the flock of faint dots behind the whole page, herded by the pointer
    fonts/        Geist and Geist Mono variable fonts (SIL OFL, see OFL.txt)
    img/          screenshots from docs/assets/readme
```

## Preview

```bash
python3 -m http.server 8765 --directory site
open http://127.0.0.1:8765/
```

## Deploy

Any static host works: publish the `site/` folder at the root of `kelpi.sh`. GitHub Pages and
Cloudflare Pages both serve `404.html` for missing paths on their own.

## Things that update themselves

- **Download links.** Every `[data-download]` link points at
  `https://github.com/benfriebe/kelpi/releases/latest` in the HTML. On load, `main.js` asks the
  GitHub API for the latest release and swaps in the `*-arm64.dmg` asset URL, then shows the
  version, size and date under the button. If that lookup fails, the links keep the release page.
  Nothing needs editing when a new release ships.

## The ASCII hero

`ascii-hero.js` rasterises `favicon.svg` once, floods the outline to find the face, and draws a
character grid on a canvas. Line art cells pick `- _ / | \` from the direction of the stroke
through them, the face gets a slow ripple of `. : ; + *`, and a sparse dot field sits around it.
Rows decode out of noise on load, glyphs scramble under the pointer (fine pointers only), and
edge cells glint in the app's running green and waiting blue. It draws at 30 frames a second,
pauses when off screen or in a hidden tab, and draws one still frame under reduced motion.
Change the logo and the art follows.

`herd-field.js` puts a fixed canvas behind the page with a flock of faint dots, sized to the
viewport. Each dot keeps its distance, matches its neighbours' heading and drifts toward the
group on a slow current; a few are tinted running green and waiting blue, because the flock is
the agents. The pointer is the dog: dots peel away from it and settle back to a cruise once it
moves off. On a phone the finger herds while it touches. The hero kelpie is a gentler second
dog, so the flock parts around it, and its canvas blanks the cells it draws so dots pass behind
the dog. The flock slides against the scroll, stops in a hidden tab, and is drawn once,
already settled, under reduced motion. The tuning constants sit at the top of the file.

## Things to keep in step by hand

- **FAQ structured data.** The `FAQPage` JSON-LD in the `<head>` of `index.html` repeats the
  visible FAQ text. Change both together.
- **Screenshots.** `assets/img/hero.png` and `web-pane.png` are copies of
  `docs/assets/readme/`; `new-workspace-sheet.png` is a crop of `new-workspace-worktree.png`.
  Regenerate them with `scripts/readme-screenshots.mjs` and copy them over when the UI changes.
- **Product facts.** Theme counts, the Codex version floor and the rest come from the README.
