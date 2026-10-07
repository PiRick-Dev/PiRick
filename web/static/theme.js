// Shows the look this browser last used, before anything is drawn. That is why
// this is a plain script in the page's head and not a module like the rest: a
// module runs after the page has been laid out, which would flash the wrong look.
//
// A look is a theme and a mode ("auto", "light" or "dark"). The stylesheet reads
// both from the root element. It is only ever told "light" or "dark": matching
// the device is worked out here, and followed when the device changes.
(() => {
  const root = document.documentElement;
  const device = matchMedia('(prefers-color-scheme: dark)');
  const stored = (key) => {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      // Storage can be switched off; the look is then only remembered by the account.
      return '';
    }
  };
  // The stylesheet decides what a name means, so anything shaped like one is passed on.
  const named = (value, fallback) => (/^[a-z][a-z-]{0,30}$/.test(value) ? value : fallback);
  let look = { theme: named(stored('pirick-theme'), 'sea'), mode: named(stored('pirick-mode'), 'auto') };

  function paint() {
    root.dataset.theme = look.theme;
    root.dataset.mode = look.mode === 'light' || look.mode === 'dark' ? look.mode : device.matches ? 'dark' : 'light';
    // The colour a phone's browser gives its own bars comes from the stylesheet too.
    const chrome = getComputedStyle(root).getPropertyValue('--chrome').trim();
    if (chrome) for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = chrome;
  }

  window.pirickLook = {
    /** Shows a look and remembers it on this browser, for the next visit and for the sign-in page. */
    set(theme, mode) {
      look = { theme: named(theme, 'sea'), mode: named(mode, 'auto') };
      try {
        localStorage.setItem('pirick-theme', look.theme);
        localStorage.setItem('pirick-mode', look.mode);
      } catch {
        // See above.
      }
      paint();
    },
  };

  paint();
  device.addEventListener('change', paint);
})();
