const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ═════════════════════════════════════════════════════════════
//  БЛОК 1. sRGB и HEX
// ═════════════════════════════════════════════════════════════

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHex(r, g, b) {
  const c = (n) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 2. OKLab
// ═════════════════════════════════════════════════════════════

function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function rgbToOklab(r, g, b) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  };
}

function oklabToRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const lr =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413190470 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  return {
    r: linearToSrgb(lr) * 255,
    g: linearToSrgb(lg) * 255,
    b: linearToSrgb(lb) * 255,
  };
}

function hexToOklab(hex) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToOklab(r, g, b);
}

function oklabToHex(lab) {
  const { r, g, b } = oklabToRgb(lab.L, lab.a, lab.b);
  return rgbToHex(r, g, b);
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 3. APCA
// ═════════════════════════════════════════════════════════════

const APCA = {
  mainTRC: 2.4,
  sRco: 0.2126729,
  sGco: 0.7151522,
  sBco: 0.0721750,
  normBG: 0.56,
  normTXT: 0.57,
  revTXT: 0.62,
  revBG: 0.65,
  blkThrs: 0.022,
  blkClmp: 1.414,
  scaleBoW: 1.14,
  scaleWoB: 1.14,
  loBoWoffset: 0.027,
  loWoBoffset: 0.027,
  deltaYmin: 0.0005,
  loClip: 0.1,
};

function apcaLinearize(c) {
  return Math.pow(c / 255, APCA.mainTRC);
}

function apcaY(rgb) {
  const R = apcaLinearize(rgb.r);
  const G = apcaLinearize(rgb.g);
  const B = apcaLinearize(rgb.b);
  return APCA.sRco * R + APCA.sGco * G + APCA.sBco * B;
}

function apcaClampBlack(Y) {
  return Y > APCA.blkThrs
    ? Y
    : Y + Math.pow(APCA.blkThrs - Y, APCA.blkClmp);
}

function apcaContrast(textRgb, bgRgb) {
  const txtY = apcaClampBlack(apcaY(textRgb));
  const bgY = apcaClampBlack(apcaY(bgRgb));

  if (Math.abs(bgY - txtY) < APCA.deltaYmin) return 0;

  let output;
  if (bgY > txtY) {
    const SAPC = (Math.pow(bgY, APCA.normBG) - Math.pow(txtY, APCA.normTXT))
      * APCA.scaleBoW;
    output = SAPC < APCA.loClip ? 0 : SAPC - APCA.loBoWoffset;
  } else {
    const SAPC = (Math.pow(bgY, APCA.revBG) - Math.pow(txtY, APCA.revTXT))
      * APCA.scaleWoB;
    output = SAPC > -APCA.loClip ? 0 : SAPC + APCA.loWoBoffset;
  }

  return output * 100;
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 4. Токены и решатель контраста
// ═════════════════════════════════════════════════════════════

const TOKENS = {
  fg:  { lc: 88, a:  0.005, b:  0.005 },
  kw:  { lc: 75, a:  0.100, b: -0.050 },
  typ: { lc: 72, a: -0.050, b:  0.100 },
  fn:  { lc: 68, a:  0.000, b:  0.120 },
  num: { lc: 70, a:  0.080, b:  0.100 },
  con: { lc: 76, a:  0.120, b:  0.020 },
  str: { lc: 62, a: -0.080, b: -0.030 },
  prp: { lc: 52, a: -0.020, b:  0.050 },
  com: { lc: 42, a:  0.000, b:  0.000 },
  err: { lc: 72, a:  0.150, b:  0.040 },
};

function solveTextForLc(bgOklab, targetLc, chromaA, chromaB) {
  const bgRgbRaw = oklabToRgb(bgOklab.L, bgOklab.a, bgOklab.b);
  const bgRgb = {
    r: clamp(bgRgbRaw.r, 0, 255),
    g: clamp(bgRgbRaw.g, 0, 255),
    b: clamp(bgRgbRaw.b, 0, 255),
  };

  const goingLight = bgOklab.L < 0.5;

  let lo, hi;
  if (goingLight) { lo = bgOklab.L; hi = 1.0; }
  else            { lo = 0.0;        hi = bgOklab.L; }

  let bestL = (lo + hi) / 2;
  let bestDiff = Infinity;

  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const rgbRaw = oklabToRgb(mid, chromaA, chromaB);
    const rgb = {
      r: clamp(rgbRaw.r, 0, 255),
      g: clamp(rgbRaw.g, 0, 255),
      b: clamp(rgbRaw.b, 0, 255),
    };
    const lc = Math.abs(apcaContrast(rgb, bgRgb));
    const diff = Math.abs(lc - targetLc);

    if (diff < bestDiff) { bestDiff = diff; bestL = mid; }

    if (goingLight) { if (lc < targetLc) lo = mid; else hi = mid; }
    else            { if (lc < targetLc) hi = mid; else lo = mid; }
  }

  return oklabToHex({ L: bestL, a: chromaA, b: chromaB });
}

function deriveSyntax(bgOklab, lcAdjust) {
  lcAdjust = lcAdjust || {};
  const result = {};

  for (const key of Object.keys(TOKENS)) {
    const t = TOKENS[key];
    const targetLc = t.lc + (lcAdjust[key] || 0);

    let a = t.a;
    let b = t.b;
    if (key === 'fg')  { a = bgOklab.a * 0.2 + t.a; b = bgOklab.b * 0.2 + t.b; }
    if (key === 'com') { a = bgOklab.a * 0.3 + t.a; b = bgOklab.b * 0.3 + t.b; }

    result[key] = solveTextForLc(bgOklab, targetLc, a, b);
  }

  return result;
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 5. Акцент и UI-элементы
// ═════════════════════════════════════════════════════════════

function deriveAccent(bg) {
  const hueMag = Math.hypot(bg.a, bg.b);
  let accentA, accentB;
  if (hueMag < 0.008) {
    accentA = -0.04;
    accentB = -0.13;
  } else {
    const norm = 0.14 / hueMag;
    accentA = bg.a * norm;
    accentB = bg.b * norm;
  }
  const accentHex = solveTextForLc(bg, 60, accentA, accentB);
  return hexToOklab(accentHex);
}

function deriveAnsi(bg) {
  const dark = bg.L < 0.5;
  const baseL   = dark ? 0.66 : 0.42;
  const brightL = dark ? 0.82 : 0.30;

  const hues = {
    red:     { a:  0.15, b:  0.04 },
    green:   { a: -0.10, b:  0.10 },
    yellow:  { a: -0.02, b:  0.14 },
    blue:    { a: -0.04, b: -0.13 },
    magenta: { a:  0.15, b: -0.08 },
    cyan:    { a: -0.10, b: -0.06 },
  };

  const ansi = {
    black:       oklabToHex({ L: dark ? clamp(bg.L + 0.03, 0.03, 0.12) : 0.10, a: 0, b: 0 }),
    white:       oklabToHex({ L: dark ? 0.84 : 0.28, a: 0, b: 0 }),
    brightBlack: oklabToHex({ L: dark ? 0.45 : 0.50, a: 0, b: 0 }),
    brightWhite: oklabToHex({ L: dark ? 0.96 : 0.08, a: 0, b: 0 }),
  };

  for (const name of Object.keys(hues)) {
    const h = hues[name];
    ansi[name] = oklabToHex({ L: baseL, a: h.a, b: h.b });
    const cap = name[0].toUpperCase() + name.slice(1);
    ansi['bright' + cap] = oklabToHex({
      L: brightL,
      a: h.a * 1.05,
      b: h.b * 1.05,
    });
  }

  return ansi;
}

function deriveUI(bg, accent) {
  const accentHex = oklabToHex(accent);

  // ─── Две разные функции плоскостей ─────────────────────
  //
  //  chromeSurface — для "обвязки" интерфейса: sidebar, activity bar,
  //  панель, вкладки, поля ввода. Всегда идут в одну сторону от
  //  редактора к краям, независимо от полярности темы. На тёмной
  //  теме — темнее, на светлой — тоже темнее. Это то, что делает
  //  chrome видимым как отдельный слой.
  //
  //  overlaySurface — для элементов, которые лежат "поверх"
  //  основного фона: виджеты, selection, hover, скроллбар.
  //  Направление зависит от полярности: на тёмной — светлее,
  //  на светлой — темнее. Иначе на светлых темах они сливаются
  //  с фоном и становятся невидимыми.

  const chromeSurface = (dL) => oklabToHex({
    L: clamp(bg.L + dL, 0.02, 0.98),
    a: bg.a + accent.a * 0.02,
    b: bg.b + accent.b * 0.02,
  });

  const overlaySurface = (magnitude) => {
    const dir = bg.L > 0.5 ? -1 : 1;
    return oklabToHex({
      L: clamp(bg.L + dir * magnitude, 0.02, 0.98),
      a: bg.a + accent.a * 0.02,
      b: bg.b + accent.b * 0.02,
    });
  };

  const textOn = (surfaceHex, lc) => {
    const sOklab = hexToOklab(surfaceHex);
    return solveTextForLc(sOklab, lc, bg.a * 0.1, bg.b * 0.1);
  };

  // Chrome-плоскости
  const sideBarBg      = chromeSurface(-0.02);
  const activityBarBg  = chromeSurface(-0.08);
  const panelBg        = chromeSurface(-0.025);
  const tabInactiveBg  = chromeSurface(-0.03);
  const inputBg        = chromeSurface(-0.04);
  const dropdownBg     = chromeSurface(-0.03);
  const sideBarHeaderBg = chromeSurface(-0.04);
  const activityActiveBg = chromeSurface(-0.03);

  // Overlay-плоскости
  const widgetBg       = overlaySurface(0.03);
  const selectionBg    = overlaySurface(0.06);

  const ansi = deriveAnsi(bg);

  const sideBarFg       = textOn(sideBarBg, 70);
  const activityBarFg   = textOn(activityBarBg, 70);
  const panelFg         = textOn(panelBg, 70);
  const tabInactiveFg   = textOn(tabInactiveBg, 50);
  const inputFg         = textOn(inputBg, 80);
  const dropdownFg      = textOn(dropdownBg, 80);
  const widgetFg        = textOn(widgetBg, 80);
  const selectionFg     = textOn(selectionBg, 80);

  const onAccent        = textOn(accentHex, 80);

  return {
    // ─── Редактор ─────────────────────────────────────────
    'editorLineNumber.foreground':        textOn(oklabToHex(bg), 38),
    'editorLineNumber.activeForeground':  textOn(oklabToHex(bg), 60),
    'editorCursor.foreground':            accentHex,
    'editor.selectionBackground':         selectionBg,
    'editor.selectionHighlightBackground': overlaySurface(0.04),
    'editor.lineHighlightBackground':     overlaySurface(0.02),
    'editorWhitespace.foreground':        textOn(oklabToHex(bg), 22),
    'editorIndentGuide.background1':      textOn(oklabToHex(bg), 18),
    'editorIndentGuide.activeBackground1': textOn(oklabToHex(bg), 38),
    'editorOverviewRuler.border':         chromeSurface(0.04),
    'editorGutter.background':            oklabToHex(bg),
    'editorBracketMatch.background':      overlaySurface(0.05),
    'editorBracketMatch.border':          accentHex,

    // ─── Sidebar ──────────────────────────────────────────
    'sideBar.background':             sideBarBg,
    'sideBar.foreground':             sideBarFg,
    'sideBar.border':                 chromeSurface(0.02),
    'sideBarSectionHeader.background': sideBarHeaderBg,
    'sideBarSectionHeader.foreground': textOn(sideBarHeaderBg, 65),

    // ─── Activity bar ─────────────────────────────────────
    'activityBar.background':            activityBarBg,
    'activityBar.foreground':            activityBarFg,
    'activityBar.inactiveForeground':    textOn(activityBarBg, 40),
    'activityBar.activeBorder':          accentHex,
    'activityBar.activeBackground':      activityActiveBg,
    'activityBar.border':                chromeSurface(0.02),
    'activityBarBadge.background':       accentHex,
    'activityBarBadge.foreground':       onAccent,

    // ─── Status bar ───────────────────────────────────────
    'statusBar.background':              accentHex,
    'statusBar.foreground':              onAccent,
    'statusBar.border':                  chromeSurface(0.03),
    'statusBarItem.hoverBackground':     oklabToHex({
      L: clamp(accent.L + 0.06, 0.02, 0.98), a: accent.a, b: accent.b,
    }),
    'statusBarItem.remoteBackground':    accentHex,
    'statusBarItem.remoteForeground':    onAccent,

    // ─── Title bar ────────────────────────────────────────
    'titleBar.activeBackground':   activityBarBg,
    'titleBar.activeForeground':   activityBarFg,
    'titleBar.inactiveBackground': activityBarBg,
    'titleBar.inactiveForeground': textOn(activityBarBg, 40),
    'titleBar.border':             chromeSurface(0.02),

    // ─── Вкладки ──────────────────────────────────────────
    'tab.activeBackground':              oklabToHex(bg),
    'tab.activeForeground':              textOn(oklabToHex(bg), 80),
    'tab.inactiveBackground':            tabInactiveBg,
    'tab.inactiveForeground':            tabInactiveFg,
    'tab.border':                        chromeSurface(0.02),
    'tab.activeBorderTop':               accentHex,
    'tab.unfocusedActiveBorderTop':      overlaySurface(0.05),
    'editorGroupHeader.tabsBackground':  tabInactiveBg,
    'editorGroupHeader.tabsBorder':      chromeSurface(0.02),
    'editorGroupHeader.noTabsBackground': tabInactiveBg,
    'editorGroup.border':                chromeSurface(0.04),

    // ─── Панель и терминал ────────────────────────────────
    'panel.background':             panelBg,
    'panel.foreground':             panelFg,
    'panel.border':                 chromeSurface(0.03),
    'panelTitle.activeForeground':  textOn(panelBg, 80),
    'panelTitle.inactiveForeground': textOn(panelBg, 55),
    'panelTitle.activeBorder':      accentHex,
    'terminal.background':          panelBg,
    'terminal.foreground':          panelFg,
    'terminalCursor.foreground':    accentHex,
    'terminal.selectionBackground': overlaySurface(0.06),
    'terminal.border':              chromeSurface(0.03),

    // ─── Поля ввода, выпадашки, кнопки ────────────────────
    'input.background':               inputBg,
    'input.foreground':               inputFg,
    'input.border':                   chromeSurface(0.05),
    'input.placeholderForeground':    textOn(inputBg, 45),
    'inputOption.activeBackground':   accentHex,
    'inputOption.activeForeground':   onAccent,
    'dropdown.background':            dropdownBg,
    'dropdown.foreground':            dropdownFg,
    'dropdown.border':                chromeSurface(0.05),
    'button.background':              accentHex,
    'button.foreground':              onAccent,
    'button.hoverBackground':         oklabToHex({
      L: clamp(accent.L + 0.06, 0.02, 0.98), a: accent.a, b: accent.b,
    }),
    'button.secondaryBackground':     overlaySurface(0.06),
    'button.secondaryForeground':     textOn(overlaySurface(0.06), 80),
    'button.secondaryHoverBackground': overlaySurface(0.09),

    // ─── Фокус и списки ───────────────────────────────────
    'focusBorder':                        accentHex,
    'list.activeSelectionBackground':     selectionBg,
    'list.activeSelectionForeground':     selectionFg,
    'list.inactiveSelectionBackground':   overlaySurface(0.03),
    'list.hoverBackground':               overlaySurface(0.04),
    'list.focusOutline':                  accentHex,
    'list.highlightForeground':           accentHex,

    // ─── Бейджи ───────────────────────────────────────────
    'badge.background': accentHex,
    'badge.foreground': onAccent,

    // ─── Скроллбар ────────────────────────────────────────
    'scrollbar.shadow':                    'transparent',
    'scrollbarSlider.background':          overlaySurface(0.10),
    'scrollbarSlider.hoverBackground':     overlaySurface(0.14),
    'scrollbarSlider.activeBackground':    overlaySurface(0.18),

    // ─── Minimap ──────────────────────────────────────────
    'minimap.background':           oklabToHex(bg),
    'minimap.selectionHighlight':   overlaySurface(0.10),

    // ─── Виджеты редактора ────────────────────────────────
    'editorWidget.background':                  widgetBg,
    'editorWidget.foreground':                  widgetFg,
    'editorWidget.border':                      chromeSurface(0.06),
    'editorSuggestWidget.background':           widgetBg,
    'editorSuggestWidget.foreground':           widgetFg,
    'editorSuggestWidget.selectedBackground':   overlaySurface(0.06),

    // ─── Уведомления ──────────────────────────────────────
    'notifications.background': widgetBg,
    'notifications.foreground': widgetFg,

    // ─── ANSI-палитра терминала ───────────────────────────
    'terminal.ansiBlack':         ansi.black,
    'terminal.ansiRed':           ansi.red,
    'terminal.ansiGreen':         ansi.green,
    'terminal.ansiYellow':        ansi.yellow,
    'terminal.ansiBlue':          ansi.blue,
    'terminal.ansiMagenta':       ansi.magenta,
    'terminal.ansiCyan':          ansi.cyan,
    'terminal.ansiWhite':         ansi.white,
    'terminal.ansiBrightBlack':   ansi.brightBlack,
    'terminal.ansiBrightRed':     ansi.brightRed,
    'terminal.ansiBrightGreen':   ansi.brightGreen,
    'terminal.ansiBrightYellow':  ansi.brightYellow,
    'terminal.ansiBrightBlue':    ansi.brightBlue,
    'terminal.ansiBrightMagenta': ansi.brightMagenta,
    'terminal.ansiBrightCyan':    ansi.brightCyan,
    'terminal.ansiBrightWhite':   ansi.brightWhite,
  };
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 6. Состояние и шаги
// ═════════════════════════════════════════════════════════════

function cloneState(s) {
  return {
    bg: { L: s.bg.L, a: s.bg.a, b: s.bg.b },
    lcAdjust: Object.assign({}, s.lcAdjust),
    accent: s.accent
      ? { L: s.accent.L, a: s.accent.a, b: s.accent.b }
      : undefined,
  };
}

function getInitialState(fromHex) {
  return {
    bg: hexToOklab(fromHex),
    lcAdjust: {},
    accent: undefined,
  };
}

function stateToVariant(state) {
  const bgHex = oklabToHex(state.bg);
  const syn = deriveSyntax(state.bg, state.lcAdjust);
  const accent = state.accent || deriveAccent(state.bg);
  const ui = deriveUI(state.bg, accent);

  return Object.assign(
    {
      bg: bgHex,
      accentBg: oklabToHex(accent),
    },
    syn,
    { ui }
  );
}

const STEP_TITLES_TOTAL = 12;

const STEPS = [
  {
    title: `Шаг 1 из ${STEP_TITLES_TOTAL}. Тип темы`,
    hint: 'Тёмная, светлая или что-то между? Выбирайте то, что ближе к вашему привычному ощущению.',
    highlight: null,
    make: (s) => {
      const targets = [0.10, 0.28, 0.72, 0.92];
      return targets.map((targetL) => {
        const c = cloneState(s);
        c.bg.L = targetL;
        return c;
      });
    },
  },
  {
    title: `Шаг 2 из ${STEP_TITLES_TOTAL}. Яркость фона`,
    hint: 'Уточните уровень освещения — теперь в выбранной полярности.',
    highlight: null,
    make: (s) => [-0.06, -0.02, 0.02, 0.06].map((d) => {
      const c = cloneState(s);
      c.bg.L = clamp(c.bg.L + d, 0.04, 0.96);
      return c;
    }),
  },
  {
    title: `Шаг 3 из ${STEP_TITLES_TOTAL}. Яркость фона (уточнение)`,
    hint: 'Совсем небольшая разница.',
    highlight: null,
    make: (s) => [-0.020, -0.007, 0.007, 0.020].map((d) => {
      const c = cloneState(s);
      c.bg.L = clamp(c.bg.L + d, 0.04, 0.96);
      return c;
    }),
  },
  {
    title: `Шаг 4 из ${STEP_TITLES_TOTAL}. Оттенок фона`,
    hint: 'Тёплый, холодный или нейтральный?',
    highlight: null,
    make: (s) => [
      { da:  0.030, db:  0.020 },
      { da: -0.030, db: -0.020 },
      { da:  0.000, db:  0.000 },
      { da:  0.020, db: -0.030 },
    ].map((sh) => {
      const c = cloneState(s);
      c.bg.a = clamp(c.bg.a + sh.da, -0.18, 0.18);
      c.bg.b = clamp(c.bg.b + sh.db, -0.18, 0.18);
      return c;
    }),
  },
  {
    title: `Шаг 5 из ${STEP_TITLES_TOTAL}. Оттенок фона (уточнение)`,
    hint: 'Едва заметные сдвиги оттенка.',
    highlight: null,
    make: (s) => [
      { da:  0.012, db:  0.008 },
      { da: -0.012, db: -0.008 },
      { da:  0.008, db: -0.012 },
      { da: -0.008, db:  0.012 },
    ].map((sh) => {
      const c = cloneState(s);
      c.bg.a = clamp(c.bg.a + sh.da, -0.18, 0.18);
      c.bg.b = clamp(c.bg.b + sh.db, -0.18, 0.18);
      return c;
    }),
  },
  {
    title: `Шаг 6 из ${STEP_TITLES_TOTAL}. Насыщенность фона`,
    hint: 'Насколько выраженным должен быть оттенок?',
    highlight: null,
    make: (s) => [0.4, 0.8, 1.1, 1.4].map((k) => {
      const c = cloneState(s);
      c.bg.a = clamp(c.bg.a * k, -0.20, 0.20);
      c.bg.b = clamp(c.bg.b * k, -0.20, 0.20);
      return c;
    }),
  },
  {
    title: `Шаг 7 из ${STEP_TITLES_TOTAL}. Акцентный цвет`,
    hint: 'Цвет кнопок, фокуса, статус-бара и активных элементов.',
    highlight: null,
    make: (s) => [
      { a: -0.04, b: -0.13 },
      { a:  0.15, b: -0.08 },
      { a: -0.10, b:  0.10 },
      { a:  0.13, b:  0.06 },
    ].map((p) => {
      const c = cloneState(s);
      const accentHex = solveTextForLc(s.bg, 60, p.a, p.b);
      c.accent = hexToOklab(accentHex);
      return c;
    }),
  },
  {
    title: `Шаг 8 из ${STEP_TITLES_TOTAL}. Контраст основного текста`,
    hint: 'Насколько ярким должен быть обычный код?',
    highlight: 'fg',
    make: (s) => [-14, -5, 5, 14].map((d) => {
      const c = cloneState(s);
      c.lcAdjust.fg = (c.lcAdjust.fg || 0) + d;
      return c;
    }),
  },
  {
    title: `Шаг 9 из ${STEP_TITLES_TOTAL}. Контраст комментариев`,
    hint: 'Комментарии должны быть заметнее или тише?',
    highlight: 'com',
    make: (s) => [-14, -5, 5, 14].map((d) => {
      const c = cloneState(s);
      c.lcAdjust.com = (c.lcAdjust.com || 0) + d;
      return c;
    }),
  },
  {
    title: `Шаг 10 из ${STEP_TITLES_TOTAL}. Контраст свойств объектов`,
    hint: 'api.get, res.data — насколько они должны выделяться?',
    highlight: 'prp',
    make: (s) => [-12, -4, 4, 12].map((d) => {
      const c = cloneState(s);
      c.lcAdjust.prp = (c.lcAdjust.prp || 0) + d;
      return c;
    }),
  },
  {
    title: `Шаг 11 из ${STEP_TITLES_TOTAL}. Строки и числа`,
    hint: 'Какой баланс контраста между строками и числами удобнее?',
    highlight: 'num',
    make: (s) => [
      { str: -10, num:  10 },
      { str:  -3, num:   3 },
      { str:   3, num:  -3 },
      { str:  10, num: -10 },
    ].map((p) => {
      const c = cloneState(s);
      c.lcAdjust.str = (c.lcAdjust.str || 0) + p.str;
      c.lcAdjust.num = (c.lcAdjust.num || 0) + p.num;
      return c;
    }),
  },
  {
    title: `Шаг 12 из ${STEP_TITLES_TOTAL}. Финальная полировка`,
    hint: 'Совсем небольшая разница в фоне.',
    highlight: null,
    make: (s) => [-0.018, -0.006, 0.006, 0.018].map((d) => {
      const c = cloneState(s);
      c.bg.L = clamp(c.bg.L + d, 0.04, 0.96);
      return c;
    }),
  },
];

// ═════════════════════════════════════════════════════════════
//  БЛОК 7. Профили: хранилище
// ═════════════════════════════════════════════════════════════

const PROFILES_KEY = 'calibra.profiles';
const ACTIVE_KEY   = 'calibra.activeProfileId';
const CALIB_KEY    = 'calibra.calibration';

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getProfiles() {
  return extensionContext.globalState.get(PROFILES_KEY) || [];
}

async function setProfiles(list) {
  await extensionContext.globalState.update(PROFILES_KEY, list);
}

function getActiveId() {
  return extensionContext.globalState.get(ACTIVE_KEY) || null;
}

async function setActiveId(id) {
  await extensionContext.globalState.update(ACTIVE_KEY, id || null);
}

function getActiveProfile() {
  const id = getActiveId();
  if (!id) return null;
  return getProfiles().find((p) => p.id === id) || null;
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 8. Профили: захват и применение
// ═════════════════════════════════════════════════════════════

function captureCurrentColors() {
  return {
    workbench:
      vscode.workspace.getConfiguration('workbench').get('colorCustomizations') || {},
    tokens:
      vscode.workspace.getConfiguration('editor').get('tokenColorCustomizations') || {},
  };
}

async function applyColors(data) {
  await vscode.workspace.getConfiguration('workbench').update(
    'colorCustomizations',
    data.workbench || {},
    vscode.ConfigurationTarget.Global
  );
  await vscode.workspace.getConfiguration('editor').update(
    'tokenColorCustomizations',
    data.tokens || {},
    vscode.ConfigurationTarget.Global
  );
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 9. Профили: операции
// ═════════════════════════════════════════════════════════════

async function saveAsNewProfile() {
  const colors = captureCurrentColors();

  const name = await vscode.window.showInputBox({
    prompt: 'Название нового профиля',
    value: 'Моя тема',
    placeHolder: 'Например: Дневная, Ночная, Для работы',
    validateInput: (v) => (v && v.trim() ? null : 'Название не может быть пустым'),
  });
  if (name === undefined) return null;

  const now = Date.now();
  const profile = {
    id: genId(),
    name: name.trim(),
    workbench: colors.workbench,
    tokens: colors.tokens,
    createdAt: now,
    updatedAt: now,
  };

  const list = getProfiles();
  list.push(profile);
  await setProfiles(list);
  await setActiveId(profile.id);

  return profile;
}

async function overwriteActiveProfile() {
  const active = getActiveProfile();
  if (!active) return await saveAsNewProfile();

  const colors = captureCurrentColors();
  const list = getProfiles().map((p) =>
    p.id === active.id
      ? Object.assign({}, p, {
          workbench: colors.workbench,
          tokens: colors.tokens,
          updatedAt: Date.now(),
        })
      : p
  );
  await setProfiles(list);

  return list.find((p) => p.id === active.id);
}

async function pickProfile(placeHolder) {
  const list = getProfiles();
  if (list.length === 0) {
    vscode.window.showInformationMessage('Calibra: профилей пока нет.');
    return null;
  }

  const activeId = getActiveId();
  const items = list.map((p) => {
    const isActive = p.id === activeId;
    const dateStr = new Date(p.updatedAt).toLocaleString('ru-RU');
    return {
      label: (isActive ? '$(star-full) ' : '$(circle-outline) ') + p.name,
      description: isActive ? `активный · ${dateStr}` : dateStr,
      id: p.id,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: placeHolder || 'Выберите профиль',
    matchOnDescription: true,
  });
  if (!picked) return null;

  return list.find((p) => p.id === picked.id) || null;
}

async function loadProfileFlow() {
  const target = await pickProfile('Какой профиль загрузить?');
  if (!target) return;

  await applyColors(target);
  await setActiveId(target.id);

  vscode.window.showInformationMessage(`Calibra: загружен профиль «${target.name}».`);
}

async function deleteProfileFlow() {
  const target = await pickProfile('Какой профиль удалить?');
  if (!target) return;

  const answer = await vscode.window.showWarningMessage(
    `Удалить профиль «${target.name}»?`,
    { modal: true },
    'Удалить'
  );
  if (answer !== 'Удалить') return;

  const list = getProfiles().filter((p) => p.id !== target.id);
  await setProfiles(list);

  if (getActiveId() === target.id) {
    await setActiveId(null);
  }

  vscode.window.showInformationMessage(`Calibra: профиль «${target.name}» удалён.`);
}

async function renameProfileFlow() {
  const target = await pickProfile('Какой профиль переименовать?');
  if (!target) return;

  const newName = await vscode.window.showInputBox({
    prompt: 'Новое имя профиля',
    value: target.name,
    validateInput: (v) => (v && v.trim() ? null : 'Название не может быть пустым'),
  });
  if (newName === undefined) return;

  const list = getProfiles().map((p) =>
    p.id === target.id
      ? Object.assign({}, p, { name: newName.trim(), updatedAt: Date.now() })
      : p
  );
  await setProfiles(list);

  vscode.window.showInformationMessage(
    `Calibra: профиль переименован в «${newName.trim()}».`
  );
}

async function showActiveProfileFlow() {
  const active = getActiveProfile();
  if (!active) {
    vscode.window.showInformationMessage('Calibra: активного профиля нет.');
    return;
  }

  const created = new Date(active.createdAt).toLocaleString('ru-RU');
  const updated = new Date(active.updatedAt).toLocaleString('ru-RU');

  vscode.window.showInformationMessage(
    `Calibra: активный профиль — «${active.name}». Создан: ${created}. Обновлён: ${updated}.`
  );
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 10. Профили: экспорт/импорт
// ═════════════════════════════════════════════════════════════

const EXPORT_FORMAT_VERSION = 1;

function sanitizeFileName(name) {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'calibra-profile'
  );
}

async function exportProfileFlow() {
  const list = getProfiles();
  if (list.length === 0) {
    vscode.window.showInformationMessage('Calibra: нечего экспортировать.');
    return;
  }

  const activeId = getActiveId();
  const items = [
    { label: '$(archive) Все профили', description: `${list.length} шт.`, id: '__all__' },
    ...list.map((p) => ({
      label: '$(file) ' + p.name,
      description:
        (p.id === activeId ? 'активный · ' : '') +
        new Date(p.updatedAt).toLocaleString('ru-RU'),
      id: p.id,
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Что экспортировать?',
  });
  if (!picked) return;

  let toExport;
  let suggested;
  if (picked.id === '__all__') {
    toExport = list;
    suggested = 'calibra-all-profiles.json';
  } else {
    const one = list.find((p) => p.id === picked.id);
    if (!one) return;
    toExport = [one];
    suggested = `calibra-${sanitizeFileName(one.name)}.json`;
  }

  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(os.homedir(), suggested)),
    filters: { 'Calibra profile': ['json'] },
    saveLabel: 'Экспортировать',
  });
  if (!uri) return;

  const payload = {
    calibra: EXPORT_FORMAT_VERSION,
    exportedAt: Date.now(),
    profiles: toExport.map((p) => ({
      name: p.name,
      workbench: p.workbench,
      tokens: p.tokens,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
  };

  try {
    fs.writeFileSync(uri.fsPath, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    vscode.window.showErrorMessage('Calibra: не удалось записать файл — ' + e.message);
    return;
  }

  const count = toExport.length;
  const word = count === 1 ? 'профиль' : 'профилей';
  vscode.window.showInformationMessage(
    `Calibra: экспортировано ${count} ${word} в ${uri.fsPath}`
  );
}

async function importProfileFlow() {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'Calibra profile': ['json'] },
    openLabel: 'Импортировать',
  });
  if (!uris || uris.length === 0) return;

  let payload;
  try {
    const raw = fs.readFileSync(uris[0].fsPath, 'utf8');
    payload = JSON.parse(raw);
  } catch (e) {
    vscode.window.showErrorMessage('Calibra: не удалось прочитать файл — ' + e.message);
    return;
  }

  if (
    !payload ||
    payload.calibra !== EXPORT_FORMAT_VERSION ||
    !Array.isArray(payload.profiles)
  ) {
    vscode.window.showErrorMessage('Calibra: неизвестный формат файла.');
    return;
  }

  const list = getProfiles();
  let added = 0;
  let skipped = 0;

  for (const raw of payload.profiles) {
    if (!raw || typeof raw.name !== 'string' || !raw.workbench || !raw.tokens) {
      skipped++;
      continue;
    }

    list.push({
      id: genId(),
      name: raw.name.trim() || 'Импортированный профиль',
      workbench: raw.workbench,
      tokens: raw.tokens,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    });
    added++;
  }

  await setProfiles(list);

  if (added === 0) {
    vscode.window.showWarningMessage('Calibra: в файле не нашлось валидных профилей.');
    return;
  }

  const word = added === 1 ? 'профиль' : 'профилей';
  let msg = `Calibra: импортировано ${added} ${word}.`;
  if (skipped > 0) msg += ` Пропущено записей: ${skipped}.`;
  vscode.window.showInformationMessage(msg);
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 11. Активация и команды
// ═════════════════════════════════════════════════════════════

let extensionContext = null;
let calib = null;
let sessionSnapshot = null;
let isApplying = false;

function activate(context) {
  extensionContext = context;

  const register = (name, handler) => {
    context.subscriptions.push(vscode.commands.registerCommand(name, handler));
  };

  register('calibra.start', () => startCalibration(null));

  register('calibra.resume', () => {
    const saved = context.globalState.get(CALIB_KEY);
    if (!saved || !saved.state || !saved.state.bg) {
      vscode.window.showInformationMessage(
        'Calibra: сохранённого состояния нет. Начните новую калибровку.'
      );
      return;
    }
    startCalibration(saved);
  });

  register('calibra.reset', async () => {
    if (!sessionSnapshot) {
      vscode.window.showInformationMessage(
        'Calibra: нет снимка для восстановления — калибровка ещё не запускалась в этой сессии.'
      );
      return;
    }
    await applyColors(sessionSnapshot);
    vscode.window.showInformationMessage('Calibra: цвета возвращены как были до сессии.');
  });

  register('calibra.saveAs', async () => {
    const p = await saveAsNewProfile();
    if (p) vscode.window.showInformationMessage(`Calibra: профиль «${p.name}» сохранён.`);
  });

  register('calibra.save', async () => {
    const active = getActiveProfile();
    if (!active) {
      const p = await saveAsNewProfile();
      if (p) vscode.window.showInformationMessage(`Calibra: профиль «${p.name}» сохранён.`);
      return;
    }
    const p = await overwriteActiveProfile();
    if (p) vscode.window.showInformationMessage(`Calibra: профиль «${p.name}» обновлён.`);
  });

  register('calibra.load', loadProfileFlow);
  register('calibra.delete', deleteProfileFlow);
  register('calibra.rename', renameProfileFlow);
  register('calibra.export', exportProfileFlow);
  register('calibra.import', importProfileFlow);
  register('calibra.showActive', showActiveProfileFlow);

  register('calibra.purge', async () => {
    const answer = await vscode.window.showWarningMessage(
      'Полностью очистить настройки Calibra? Это удалит colorCustomizations и tokenColorCustomizations из глобальных настроек. Ваши профили сохранятся.',
      { modal: true },
      'Очистить'
    );
    if (answer !== 'Очистить') return;

    await vscode.workspace.getConfiguration('workbench').update(
      'colorCustomizations',
      undefined,
      vscode.ConfigurationTarget.Global
    );
    await vscode.workspace.getConfiguration('editor').update(
      'tokenColorCustomizations',
      undefined,
      vscode.ConfigurationTarget.Global
    );

    await extensionContext.globalState.update(CALIB_KEY, undefined);
    await extensionContext.globalState.update(ACTIVE_KEY, null);

    sessionSnapshot = null;

    vscode.window.showInformationMessage(
      'Calibra: все кастомизации удалены. Переключение тем VS Code снова работает как обычно.'
    );
  });

  register('calibra.forgetAll', async () => {
    const answer = await vscode.window.showWarningMessage(
      'Удалить все профили и сохранённое состояние Calibra? Это нельзя отменить.',
      { modal: true },
      'Удалить всё'
    );
    if (answer !== 'Удалить всё') return;

    await context.globalState.update(PROFILES_KEY, []);
    await context.globalState.update(ACTIVE_KEY, null);
    await context.globalState.update(CALIB_KEY, undefined);

    vscode.window.showInformationMessage('Calibra: все данные удалены.');
  });
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 12. Калибровка
// ═════════════════════════════════════════════════════════════

async function startCalibration(resumeData) {
  if (calib && calib.panel) {
    try { calib.panel.dispose(); } catch (e) { /* noop */ }
    calib = null;
  }

  if (!sessionSnapshot) {
    sessionSnapshot = captureCurrentColors();
  }

  let initialState;
  let initialStep;
  if (resumeData && resumeData.state && resumeData.state.bg) {
    initialState = cloneState(resumeData.state);
    initialStep = clamp(resumeData.step || 1, 1, STEPS.length);
  } else {
    const startHex = sessionSnapshot.workbench['editor.background'] || '#1e1e1e';
    initialState = getInitialState(startHex);
    initialStep = 1;
  }

  const panel = vscode.window.createWebviewPanel(
    'calibra',
    'Calibra',
    vscode.ViewColumn.Beside,
    { enableScripts: true }
  );

  calib = {
    state: initialState,
    step: initialStep,
    candidates: STEPS[initialStep - 1].make(initialState),
    panel,
  };

  panel.webview.html = getHtml();

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.command === 'ready')       sendRender();
    else if (msg.command === 'select') await handleSelect(msg.letter);
    else if (msg.command === 'finish') await finishCalibration();
  });

  panel.onDidDispose(() => {
    if (calib && calib.panel === panel) calib = null;
  });
}

function sendRender() {
  if (!calib) return;

  const stepDef = STEPS[calib.step - 1];
  const total = STEPS.length;
  const progress = (calib.step - 1) / total;

  const active = getActiveProfile();
  const activeProfileName = active ? active.name : null;

  const cards = calib.candidates.map((state, idx) => {
    const v = stateToVariant(state);
    return {
      letter: 'ABCD'[idx],
      bg: v.bg,
      fg: v.fg,
      accentBg: v.accentBg,
      accentFg: v.ui['statusBar.foreground'] || v.fg,
      preview: buildPreviewHtml(v, stepDef.highlight),
    };
  });

  calib.panel.webview.postMessage({
    command: 'render',
    title: stepDef.title,
    hint: stepDef.hint,
    progress,
    stepNumber: calib.step,
    totalSteps: total,
    activeProfileName,
    cards,
  });
}

async function handleSelect(letter) {
  if (!calib) return;
  if (isApplying) return;

  const idx = 'ABCD'.indexOf(letter);
  if (idx < 0 || idx >= calib.candidates.length) return;

  isApplying = true;
  try {
    const chosenState = calib.candidates[idx];
    const chosenVariant = stateToVariant(chosenState);

    await applyVariant(chosenVariant);

    const nextStep = calib.step + 1;
    if (nextStep > STEPS.length) {
      calib.state = chosenState;
      await saveCalibrationState();
      await finishCalibration();
      return;
    }

    calib.state = chosenState;
    calib.step = nextStep;
    calib.candidates = STEPS[nextStep - 1].make(chosenState);

    await saveCalibrationState();
    sendRender();
  } finally {
    isApplying = false;
  }
}

async function saveCalibrationState() {
  if (!extensionContext || !calib) return;
  await extensionContext.globalState.update(CALIB_KEY, {
    step: calib.step,
    state: calib.state,
  });
}

async function finishCalibration() {
  if (!calib) return;

  const finalVariant = stateToVariant(calib.state);
  await applyVariant(finalVariant);
  await saveCalibrationState();

  const panel = calib.panel;
  calib = null;
  panel.dispose();

  await promptSaveAfterCalibration();
}

async function promptSaveAfterCalibration() {
  const active = getActiveProfile();

  const items = [
    { label: '$(add) Сохранить как новый профиль…', id: 'new' },
  ];
  if (active) {
    items.push({ label: `$(save) Обновить «${active.name}»`, id: 'update' });
  }
  items.push({ label: '$(close) Не сохранять', id: 'skip' });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Что сделать с результатом калибровки?',
  });

  if (!picked || picked.id === 'skip') {
    vscode.window.showInformationMessage('Calibra: калибровка применена.');
    return;
  }

  if (picked.id === 'new') {
    const p = await saveAsNewProfile();
    if (p) vscode.window.showInformationMessage(`Calibra: профиль «${p.name}» сохранён.`);
    return;
  }

  if (picked.id === 'update') {
    const p = await overwriteActiveProfile();
    if (p) vscode.window.showInformationMessage(`Calibra: профиль «${p.name}» обновлён.`);
  }
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 13. Применение цвета к VS Code
// ═════════════════════════════════════════════════════════════

async function applyVariant(variant) {
  try {
    const allColors = Object.assign({}, variant.ui, {
      'editor.background': variant.bg,
      'editor.foreground': variant.fg,
      'editorError.foreground': variant.err,
    });

    // Страховка: отбрасываем всё, что не похоже на HEX-цвет
    for (const key of Object.keys(allColors)) {
      const val = allColors[key];
      if (typeof val !== 'string' || !val.match(/^(#[0-9a-fA-F]{6}|transparent)$/)) {
        console.error('Calibra: некорректное значение для', key, '=', val);
        delete allColors[key];
      }
    }

    const wbConfig = vscode.workspace.getConfiguration('workbench');
    const currentWb = wbConfig.get('colorCustomizations') || {};

    const nextWb = Object.assign({}, currentWb, allColors);

    await wbConfig.update(
      'colorCustomizations',
      nextWb,
      vscode.ConfigurationTarget.Global
    );

    const tkConfig = vscode.workspace.getConfiguration('editor');
    const currentTk = tkConfig.get('tokenColorCustomizations') || {};

    const nextTk = Object.assign({}, currentTk, {
      textMateRules: [
        { scope: 'comment', settings: { foreground: variant.com, fontStyle: 'italic' } },
        { scope: 'string', settings: { foreground: variant.str } },
        { scope: 'constant.numeric', settings: { foreground: variant.num } },
        { scope: 'constant.language', settings: { foreground: variant.con } },
        {
          scope: ['keyword.control', 'keyword.other'],
          settings: { foreground: variant.kw },
        },
        {
          scope: ['storage', 'storage.type', 'storage.modifier'],
          settings: { foreground: variant.kw },
        },
        {
          scope: [
            'entity.name.type',
            'entity.name.class',
            'entity.name.interface',
            'support.type',
            'support.class',
          ],
          settings: { foreground: variant.typ },
        },
        {
          scope: ['entity.name.function', 'support.function'],
          settings: { foreground: variant.fn },
        },
        {
          scope: [
            'variable.other.property',
            'meta.object-literal.key',
            'support.variable.property',
          ],
          settings: { foreground: variant.prp },
        },
      ],
    });

    await tkConfig.update(
      'tokenColorCustomizations',
      nextTk,
      vscode.ConfigurationTarget.Global
    );
  } catch (e) {
    console.error('Calibra: ошибка применения варианта', e);
    vscode.window.showErrorMessage('Calibra: не удалось применить цвета — ' + e.message);
  }
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 14. Превью кода
// ═════════════════════════════════════════════════════════════

function hl(text, color, key, highlight) {
  const base = `<span style="color:${color}">${text}</span>`;
  if (key && key === highlight) {
    return `<span style="outline:1px dashed rgba(128,128,128,0.5); outline-offset:2px; border-radius:2px;">${base}</span>`;
  }
  return base;
}

function buildPreviewHtml(v, highlight) {
  highlight = highlight || null;

  const lines = [
    hl('// fetch user with caching', v.com, 'com', highlight),

    hl('export async function', v.kw, 'kw', highlight) + ' ' +
      hl('fetchUser', v.fn, 'fn', highlight) + '&lt;' +
      hl('T', v.typ, 'typ', highlight) + '&gt;(',

    '  ' + hl('id', v.fg, 'fg', highlight) + ': ' +
      hl('number', v.typ, 'typ', highlight) + ',',

    '  opts: ' + hl('Options', v.typ, 'typ', highlight) + ' = {}',

    '): ' + hl('Promise', v.typ, 'typ', highlight) + '&lt;' +
      hl('User', v.typ, 'typ', highlight) + '&gt; {',

    '  ' + hl('const', v.kw, 'kw', highlight) + ' maxRetries = ' +
      hl('3', v.num, 'num', highlight) + ';',

    '  ' + hl('const', v.kw, 'kw', highlight) + ' enabled = ' +
      hl('true', v.con, 'con', highlight) + ';',

    '  ' + hl('if', v.kw, 'kw', highlight) + ' (!id || id &gt; ' +
      hl('1000', v.num, 'num', highlight) + ') ' +
      hl('return', v.kw, 'kw', highlight) + ' ' +
      hl('null', v.con, 'con', highlight) + ';',

    '  ' + hl('const', v.kw, 'kw', highlight) + ' cacheKey = ' +
      hl("'user:'", v.str, 'str', highlight) + ' + id;',

    '  ' + hl('const', v.kw, 'kw', highlight) + ' cached = ' +
      hl('store', v.fg, 'fg', highlight) + '.' +
      hl('get', v.prp, 'prp', highlight) + '(cacheKey);',

    '  ' + hl('if', v.kw, 'kw', highlight) + ' (cached) ' +
      hl('return', v.kw, 'kw', highlight) + ' cached;',

    '  ' + hl('const', v.kw, 'kw', highlight) + ' res = ' +
      hl('await', v.kw, 'kw', highlight) + ' ' +
      hl('api', v.fg, 'fg', highlight) + '.' +
      hl('get', v.prp, 'prp', highlight) + '(' +
      hl("'/user/'", v.str, 'str', highlight) + ' + id);',

    '  ' + hl('return', v.kw, 'kw', highlight) + ' res.' +
      hl('data', v.prp, 'prp', highlight) + ';',

    '}',
  ];

  return lines.join('\n');
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 15. Webview
// ═════════════════════════════════════════════════════════════

function getHtml() {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>Calibra</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px 24px;
      margin: 0;
    }
    .header { margin-bottom: 16px; }
    h1 {
      font-size: 16px;
      font-weight: 600;
      margin: 0 0 6px 0;
    }
    .hint {
      font-size: 13px;
      opacity: 0.7;
      margin: 0 0 10px 0;
    }
    .active {
      font-size: 12px;
      opacity: 0.55;
      margin: 0 0 12px 0;
      font-style: italic;
    }
    .progress {
      height: 3px;
      width: 100%;
      background: rgba(128, 128, 128, 0.2);
      border-radius: 2px;
      overflow: hidden;
      margin-bottom: 20px;
    }
    .progress-bar {
      height: 100%;
      background: var(--vscode-focusBorder);
      width: 0%;
      transition: width 0.25s ease;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .card {
      border: 1px solid rgba(128, 128, 128, 0.25);
      border-radius: 6px;
      overflow: hidden;
      cursor: pointer;
      transition: border-color 0.15s, transform 0.15s;
    }
    .card:hover {
      border-color: var(--vscode-focusBorder);
      transform: translateY(-1px);
    }
    .preview {
      font-family: var(--vscode-editor-font-family);
      font-size: 11.5px;
      line-height: 1.5;
      padding: 14px;
      white-space: pre;
      tab-size: 2;
      overflow: auto;
    }
    .chrome {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 3px 10px;
      font-size: 10px;
      font-family: var(--vscode-font-family);
      letter-spacing: 0.03em;
    }
    .chrome .left { opacity: 0.9; }
    .chrome .right { opacity: 0.75; }
    .label {
      font-size: 12px;
      text-align: center;
      padding: 6px;
      background: rgba(128, 128, 128, 0.08);
      opacity: 0.8;
      letter-spacing: 0.05em;
    }
    .footer {
      margin-top: 20px;
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }
    button {
      font-family: inherit;
      font-size: 13px;
      padding: 6px 14px;
      border-radius: 4px;
      border: 1px solid transparent;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
      transition: background 0.15s;
    }
    button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
  </style>
</head>
<body>
  <div class="header">
    <h1 id="title">Загрузка…</h1>
    <p class="hint" id="hint"></p>
    <p class="active" id="active" style="display:none;"></p>
    <div class="progress"><div class="progress-bar" id="bar"></div></div>
  </div>

  <div class="grid" id="grid"></div>

  <div class="footer">
    <button id="finish">Готово, оставить как есть</button>
  </div>

  <script>
    var vscode = acquireVsCodeApi();
    var grid = document.getElementById('grid');
    var titleEl = document.getElementById('title');
    var hintEl = document.getElementById('hint');
    var activeEl = document.getElementById('active');
    var barEl = document.getElementById('bar');
    var finishBtn = document.getElementById('finish');

    function renderCards(cards) {
      grid.innerHTML = '';
      cards.forEach(function (c) {
        var el = document.createElement('div');
        el.className = 'card';
        el.setAttribute('data-letter', c.letter);
        el.addEventListener('click', function () {
          vscode.postMessage({ command: 'select', letter: c.letter });
        });

        var preview = document.createElement('div');
        preview.className = 'preview';
        preview.style.background = c.bg;
        preview.style.color = c.fg;
        preview.innerHTML = c.preview;

        var chrome = document.createElement('div');
        chrome.className = 'chrome';
        chrome.style.background = c.accentBg;
        chrome.style.color = c.accentFg;
        chrome.innerHTML =
          '<span class="left">Calibra · main</span>' +
          '<span class="right">UTF-8 · TS</span>';

        var label = document.createElement('div');
        label.className = 'label';
        label.textContent = 'Вариант ' + c.letter;

        el.appendChild(preview);
        el.appendChild(chrome);
        el.appendChild(label);
        grid.appendChild(el);
      });
    }

    window.addEventListener('message', function (event) {
      var msg = event.data;
      if (msg.command === 'render') {
        titleEl.textContent = msg.title;
        hintEl.textContent = msg.hint || '';
        barEl.style.width = Math.round((msg.progress || 0) * 100) + '%';

        if (msg.activeProfileName) {
          activeEl.textContent = 'Активный профиль: ' + msg.activeProfileName;
          activeEl.style.display = '';
        } else {
          activeEl.style.display = 'none';
        }

        renderCards(msg.cards);
      }
    });

    finishBtn.addEventListener('click', function () {
      vscode.postMessage({ command: 'finish' });
    });

    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };