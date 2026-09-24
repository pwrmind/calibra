const vscode = require('vscode');

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
//  БЛОК 4. Базовые контрасты токенов
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

// Решатель APCA: подбирает L так, чтобы контраст был равен targetLc
function solveTextForLc(bgOklab, targetLc, chromaA, chromaB) {
  const bgRgbRaw = oklabToRgb(bgOklab.L, bgOklab.a, bgOklab.b);
  const bgRgb = {
    r: clamp(bgRgbRaw.r, 0, 255),
    g: clamp(bgRgbRaw.g, 0, 255),
    b: clamp(bgRgbRaw.b, 0, 255),
  };

  const goingLight = bgOklab.L < 0.5;

  let lo, hi;
  if (goingLight) {
    lo = bgOklab.L;
    hi = 1.0;
  } else {
    lo = 0.0;
    hi = bgOklab.L;
  }

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

    if (diff < bestDiff) {
      bestDiff = diff;
      bestL = mid;
    }

    if (goingLight) {
      if (lc < targetLc) lo = mid;
      else hi = mid;
    } else {
      if (lc < targetLc) hi = mid;
      else lo = mid;
    }
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
    if (key === 'fg') {
      a = bgOklab.a * 0.2 + t.a;
      b = bgOklab.b * 0.2 + t.b;
    } else if (key === 'com') {
      a = bgOklab.a * 0.3 + t.a;
      b = bgOklab.b * 0.3 + t.b;
    }

    result[key] = solveTextForLc(bgOklab, targetLc, a, b);
  }

  return result;
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 5. Состояние калибровки и шаги
// ═════════════════════════════════════════════════════════════
//
//  state = {
//    bg: { L, a, b },                    // текущий фон в OKLab
//    lcAdjust: { fg: 0, com: 0, ... }    // дельты к базовым Lc из TOKENS
//  }
//
//  Каждый шаг — это функция make(state), которая возвращает 4 новых состояния.
//  Пользователь выбирает одно, оно становится новым состоянием.

function cloneState(s) {
  return {
    bg: { L: s.bg.L, a: s.bg.a, b: s.bg.b },
    lcAdjust: Object.assign({}, s.lcAdjust),
  };
}

function getInitialState(fromHex) {
  return {
    bg: hexToOklab(fromHex),
    lcAdjust: {},
  };
}

function stateToVariant(state) {
  const bgHex = oklabToHex(state.bg);
  const syn = deriveSyntax(state.bg, state.lcAdjust);
  return Object.assign({ bg: bgHex }, syn);
}

const STEPS = [
  // ─── 1. Яркость фона, грубо ────────────────────────────────
  {
    title: 'Шаг 1 из 10. Яркость фона',
    hint: 'Какой уровень освещения вам комфортнее?',
    highlight: null,
    make: (s) => {
      const deltas = [-0.16, -0.06, 0.06, 0.16];
      return deltas.map((d) => {
        const c = cloneState(s);
        c.bg.L = clamp(c.bg.L + d, 0.06, 0.94);
        return c;
      });
    },
  },

  // ─── 2. Яркость фона, тонко ────────────────────────────────
  {
    title: 'Шаг 2 из 10. Яркость фона (уточнение)',
    hint: 'Теперь — совсем небольшая разница.',
    highlight: null,
    make: (s) => {
      const deltas = [-0.045, -0.015, 0.015, 0.045];
      return deltas.map((d) => {
        const c = cloneState(s);
        c.bg.L = clamp(c.bg.L + d, 0.06, 0.94);
        return c;
      });
    },
  },

  // ─── 3. Оттенок фона, грубо ────────────────────────────────
  {
    title: 'Шаг 3 из 10. Оттенок фона',
    hint: 'Тёплый, холодный или нейтральный?',
    highlight: null,
    make: (s) => {
      const shifts = [
        { da:  0.030, db:  0.020 }, // тёплый
        { da: -0.030, db: -0.020 }, // холодный
        { da:  0.000, db:  0.000 }, // нейтральный
        { da:  0.020, db: -0.030 }, // холодно-синий
      ];
      return shifts.map((sh) => {
        const c = cloneState(s);
        c.bg.a = clamp(c.bg.a + sh.da, -0.18, 0.18);
        c.bg.b = clamp(c.bg.b + sh.db, -0.18, 0.18);
        return c;
      });
    },
  },

  // ─── 4. Оттенок фона, тонко ────────────────────────────────
  {
    title: 'Шаг 4 из 10. Оттенок фона (уточнение)',
    hint: 'Едва заметные сдвиги оттенка.',
    highlight: null,
    make: (s) => {
      const shifts = [
        { da:  0.012, db:  0.008 },
        { da: -0.012, db: -0.008 },
        { da:  0.008, db: -0.012 },
        { da: -0.008, db:  0.012 },
      ];
      return shifts.map((sh) => {
        const c = cloneState(s);
        c.bg.a = clamp(c.bg.a + sh.da, -0.18, 0.18);
        c.bg.b = clamp(c.bg.b + sh.db, -0.18, 0.18);
        return c;
      });
    },
  },

  // ─── 5. Насыщенность фона ──────────────────────────────────
  {
    title: 'Шаг 5 из 10. Насыщенность фона',
    hint: 'Насколько выраженным должен быть оттенок?',
    highlight: null,
    make: (s) => {
      const scales = [0.4, 0.8, 1.1, 1.4];
      return scales.map((k) => {
        const c = cloneState(s);
        c.bg.a = clamp(c.bg.a * k, -0.20, 0.20);
        c.bg.b = clamp(c.bg.b * k, -0.20, 0.20);
        return c;
      });
    },
  },

  // ─── 6. Контраст основного текста ──────────────────────────
  {
    title: 'Шаг 6 из 10. Контраст основного текста',
    hint: 'Насколько ярким должен быть обычный код?',
    highlight: 'fg',
    make: (s) => {
      const deltas = [-14, -5, 5, 14];
      return deltas.map((d) => {
        const c = cloneState(s);
        c.lcAdjust.fg = (c.lcAdjust.fg || 0) + d;
        return c;
      });
    },
  },

  // ─── 7. Контраст комментариев ──────────────────────────────
  {
    title: 'Шаг 7 из 10. Контраст комментариев',
    hint: 'Комментарии должны быть заметнее или тише?',
    highlight: 'com',
    make: (s) => {
      const deltas = [-14, -5, 5, 14];
      return deltas.map((d) => {
        const c = cloneState(s);
        c.lcAdjust.com = (c.lcAdjust.com || 0) + d;
        return c;
      });
    },
  },

  // ─── 8. Контраст свойств объектов ──────────────────────────
  {
    title: 'Шаг 8 из 10. Контраст свойств и методов',
    hint: 'api.get, res.data — насколько они должны выделяться?',
    highlight: 'prp',
    make: (s) => {
      const deltas = [-12, -4, 4, 12];
      return deltas.map((d) => {
        const c = cloneState(s);
        c.lcAdjust.prp = (c.lcAdjust.prp || 0) + d;
        return c;
      });
    },
  },

  // ─── 9. Баланс строк и чисел ───────────────────────────────
  {
    title: 'Шаг 9 из 10. Строки и числа',
    hint: 'Какой баланс контраста между строками и числами удобнее?',
    highlight: 'num',
    make: (s) => {
      const pairs = [
        { str: -10, num:  10 },
        { str:  -3, num:   3 },
        { str:   3, num:  -3 },
        { str:  10, num: -10 },
      ];
      return pairs.map((p) => {
        const c = cloneState(s);
        c.lcAdjust.str = (c.lcAdjust.str || 0) + p.str;
        c.lcAdjust.num = (c.lcAdjust.num || 0) + p.num;
        return c;
      });
    },
  },

  // ─── 10. Финальная полировка фона ──────────────────────────
  {
    title: 'Шаг 10 из 10. Финальная полировка',
    hint: 'Совсем небольшая разница в фоне.',
    highlight: null,
    make: (s) => {
      const deltas = [-0.018, -0.006, 0.006, 0.018];
      return deltas.map((d) => {
        const c = cloneState(s);
        c.bg.L = clamp(c.bg.L + d, 0.06, 0.94);
        return c;
      });
    },
  },
];

// ═════════════════════════════════════════════════════════════
//  БЛОК 6. Расширение: активация и команды
// ═════════════════════════════════════════════════════════════

let originalWorkbench = null;
let originalTokens = null;
let calib = null;
let extensionContext = null;

function activate(context) {
  extensionContext = context;

  context.subscriptions.push(
    vscode.commands.registerCommand('calibra.start', () => {
      startCalibration(null);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('calibra.resume', () => {
      const saved = context.globalState.get('calibra.state');
      if (!saved) {
        vscode.window.showInformationMessage(
          'Calibra: сохранённого состояния нет. Начните новую калибровку.'
        );
        return;
      }
      startCalibration(saved);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('calibra.reset', async () => {
      await vscode.workspace.getConfiguration('workbench').update(
        'colorCustomizations',
        originalWorkbench || {},
        vscode.ConfigurationTarget.Global
      );
      await vscode.workspace.getConfiguration('editor').update(
        'tokenColorCustomizations',
        originalTokens || {},
        vscode.ConfigurationTarget.Global
      );
      vscode.window.showInformationMessage('Calibra: цвета возвращены как были.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('calibra.save', async () => {
      await saveProfileFromCurrent();
      vscode.window.showInformationMessage('Calibra: текущие цвета сохранены как профиль.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('calibra.restore', async () => {
      const restored = await restoreProfile();
      if (restored) {
        vscode.window.showInformationMessage('Calibra: профиль восстановлен.');
      } else {
        vscode.window.showInformationMessage('Calibra: сохранённого профиля пока нет.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('calibra.forget', async () => {
      await context.globalState.update('calibra.profile', undefined);
      await context.globalState.update('calibra.state', undefined);
      vscode.window.showInformationMessage('Calibra: профиль и состояние удалены.');
    })
  );
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 7. Калибровка
// ═════════════════════════════════════════════════════════════

function startCalibration(resumeState) {
  const wbConfig = vscode.workspace.getConfiguration('workbench');
  const tkConfig = vscode.workspace.getConfiguration('editor');

  originalWorkbench = wbConfig.get('colorCustomizations') || {};
  originalTokens = tkConfig.get('tokenColorCustomizations') || {};

  let initialState;
  if (resumeState && resumeState.bg && typeof resumeState.bg.L === 'number') {
    initialState = cloneState(resumeState);
  } else {
    const startHex = originalWorkbench['editor.background'] || '#1e1e1e';
    initialState = getInitialState(startHex);
  }

  const panel = vscode.window.createWebviewPanel(
    'calibra',
    'Calibra',
    vscode.ViewColumn.Beside,
    { enableScripts: true }
  );

  const firstStep = STEPS[0];
  const candidateStates = firstStep.make(initialState);

  calib = {
    state: initialState,
    step: 1,
    candidates: candidateStates,
    panel,
  };

  panel.webview.html = getHtml();

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.command === 'ready') {
      sendRender();
    } else if (msg.command === 'select') {
      await handleSelect(msg.letter);
    } else if (msg.command === 'finish') {
      await finishCalibration();
    }
  });

  panel.onDidDispose(() => {
    if (calib && calib.panel === panel) {
      calib = null;
    }
  });
}

function sendRender() {
  if (!calib) return;

  const stepDef = STEPS[calib.step - 1];
  const total = STEPS.length;
  const progress = (calib.step - 1) / total;

  const cards = calib.candidates.map((state, idx) => {
    const v = stateToVariant(state);
    const letter = 'ABCD'[idx];
    return {
      letter,
      bg: v.bg,
      fg: v.fg,
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
    cards,
  });
}

async function handleSelect(letter) {
  if (!calib) return;

  const idx = 'ABCD'.indexOf(letter);
  if (idx < 0 || idx >= calib.candidates.length) return;

  const chosenState = calib.candidates[idx];
  const chosenVariant = stateToVariant(chosenState);

  await applyVariant(chosenVariant);

  // Двигаемся к следующему шагу или завершаем
  const nextStep = calib.step + 1;
  if (nextStep > STEPS.length) {
    await finishCalibration();
    return;
  }

  calib.state = chosenState;
  calib.step = nextStep;
  calib.candidates = STEPS[nextStep - 1].make(chosenState);

  sendRender();
}

async function finishCalibration() {
  if (!calib) return;

  // Применяем финальное состояние на всякий случай — вдруг был клик «Готово»
  const finalVariant = stateToVariant(calib.state);
  await applyVariant(finalVariant);

  // Сохраняем результат
  await saveProfileFromCurrent();
  await extensionContext.globalState.update('calibra.state', calib.state);

  vscode.window.showInformationMessage('Calibra: калибровка завершена и сохранена.');

  const panel = calib.panel;
  calib = null;
  panel.dispose();
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 8. Применение цвета к VS Code
// ═════════════════════════════════════════════════════════════

async function applyVariant(variant) {
  const wbConfig = vscode.workspace.getConfiguration('workbench');
  const currentWb = wbConfig.get('colorCustomizations') || {};

  const nextWb = Object.assign({}, currentWb, {
    'editor.background': variant.bg,
    'editor.foreground': variant.fg,
    'editorError.foreground': variant.err,
  });

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
      {
        scope: [
          'constant.language',
          'constant.language.boolean',
          'constant.language.null',
          'constant.language.undefined',
        ],
        settings: { foreground: variant.con },
      },
      {
        scope: [
          'keyword',
          'storage',
          'storage.type',
          'storage.modifier',
          'keyword.control',
        ],
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
        scope: [
          'entity.name.function',
          'support.function',
          'meta.function-call',
        ],
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
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 9. Профиль
// ═════════════════════════════════════════════════════════════

async function saveProfileFromCurrent() {
  if (!extensionContext) return;

  const profile = {
    workbench:
      vscode.workspace.getConfiguration('workbench').get('colorCustomizations') || {},
    tokens:
      vscode.workspace.getConfiguration('editor').get('tokenColorCustomizations') || {},
    savedAt: Date.now(),
  };

  await extensionContext.globalState.update('calibra.profile', profile);
}

async function restoreProfile() {
  if (!extensionContext) return false;

  const profile = extensionContext.globalState.get('calibra.profile');
  if (!profile) return false;

  await vscode.workspace.getConfiguration('workbench').update(
    'colorCustomizations',
    profile.workbench || {},
    vscode.ConfigurationTarget.Global
  );

  await vscode.workspace.getConfiguration('editor').update(
    'tokenColorCustomizations',
    profile.tokens || {},
    vscode.ConfigurationTarget.Global
  );

  return true;
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 10. Превью кода
// ═════════════════════════════════════════════════════════════

// Обёртка для «подсветки» токена, который сейчас калибруется.
// Тонкий пунктирный контур вокруг, ничего не меняя в самом цвете.
function hl(text, color, key, highlight) {
  const base = `<span style="color:${color}">${text}</span>`;
  if (key && key === highlight) {
    return `<span style="outline:1px dashed rgba(255,255,255,0.35); outline-offset:2px; border-radius:2px;">${base}</span>`;
  }
  return base;
}

function buildPreviewHtml(v, highlight) {
  highlight = highlight || null;

  const line1 =
    hl('// fetch user with caching', v.com, 'com', highlight);

  const line2 =
    hl('export async function', v.kw, 'kw', highlight) + ' ' +
    hl('fetchUser', v.fn, 'fn', highlight) + '&lt;' +
    hl('T', v.typ, 'typ', highlight) + '&gt;(';

  const line3 =
    '  ' + hl('id', v.fg, 'fg', highlight) + ': ' +
    hl('number', v.typ, 'typ', highlight) + ',';

  const line4 =
    '  opts: ' + hl('Options', v.typ, 'typ', highlight) + ' = {}';

  const line5 =
    '): ' + hl('Promise', v.typ, 'typ', highlight) + '&lt;' +
    hl('User', v.typ, 'typ', highlight) + '&gt; {';

  const line6 =
    '  ' + hl('const', v.kw, 'kw', highlight) + ' maxRetries = ' +
    hl('3', v.num, 'num', highlight) + ';';

  const line7 =
    '  ' + hl('const', v.kw, 'kw', highlight) + ' enabled = ' +
    hl('true', v.con, 'con', highlight) + ';';

  const line8 =
    '  ' + hl('if', v.kw, 'kw', highlight) + ' (!id || id &gt; ' +
    hl('1000', v.num, 'num', highlight) + ') ' +
    hl('return', v.kw, 'kw', highlight) + ' ' +
    hl('null', v.con, 'con', highlight) + ';';

  const line9 =
    '  ' + hl('const', v.kw, 'kw', highlight) + ' cacheKey = ' +
    hl("'user:'", v.str, 'str', highlight) + ' + id;';

  const line10 =
    '  ' + hl('const', v.kw, 'kw', highlight) + ' cached = ' +
    hl('store', v.fg, 'fg', highlight) + '.' +
    hl('get', v.prp, 'prp', highlight) + '(cacheKey);';

  const line11 =
    '  ' + hl('if', v.kw, 'kw', highlight) + ' (cached) ' +
    hl('return', v.kw, 'kw', highlight) + ' cached;';

  const line12 =
    '  ' + hl('const', v.kw, 'kw', highlight) + ' res = ' +
    hl('await', v.kw, 'kw', highlight) + ' ' +
    hl('api', v.fg, 'fg', highlight) + '.' +
    hl('get', v.prp, 'prp', highlight) + '(' +
    hl("'/user/'", v.str, 'str', highlight) + ' + id);';

  const line13 =
    '  ' + hl('return', v.kw, 'kw', highlight) + ' res.' +
    hl('data', v.prp, 'prp', highlight) + ';';

  const line14 = '}';

  return [
    line1, line2, line3, line4, line5,
    line6, line7, line8, line9, line10,
    line11, line12, line13, line14
  ].join('\n');
}

// ═════════════════════════════════════════════════════════════
//  БЛОК 11. Webview
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
    .header {
      margin-bottom: 16px;
    }
    h1 {
      font-size: 16px;
      font-weight: 600;
      margin: 0 0 6px 0;
    }
    .hint {
      font-size: 13px;
      opacity: 0.7;
      margin: 0 0 12px 0;
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

        var label = document.createElement('div');
        label.className = 'label';
        label.textContent = 'Вариант ' + c.letter;

        el.appendChild(preview);
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