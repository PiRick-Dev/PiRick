// The looks PiRick comes with. Each one is drawn and coloured in
// web/static/style.css under [data-theme="<id>"], once for light and once for
// dark; a test checks that this list and the stylesheet agree.

export const DEFAULT_THEME = 'sea';
export const DEFAULT_MODE = 'auto';

export const THEMES = [
  { id: 'sea', name: 'The sea' },
  { id: 'cinema', name: 'Cinema' },
  { id: 'video-store', name: 'Video store' },
  { id: 'study', name: 'Butler’s study' },
  { id: 'plain', name: 'Plain' },
];

export const MODES = [
  { id: 'auto', name: 'Match my device' },
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' },
];
