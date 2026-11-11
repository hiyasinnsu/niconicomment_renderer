// コメントの配置と描画。
// 数値と手順は nicovideo.jp の視聴ページが読み込む公式コメント描画ライブラリ
// (@nico/comment-renderer) の挙動を読み取り、同じ規則を独自に実装したもの。
// 公式は再生中に逐次配置するため、シークすると配置が変わる。ここでは
// 先頭から再生した場合の配置を最初に一度だけ計算し、描画は時刻だけで決まる
// 純粋な処理にしている。プレビューと書き出しは同じ描画関数を使う。

export const BASE_CANVAS_HEIGHT = 384;
const SUPPORTED_MINIMUM_CHARACTER_SIZE = 10;
const FONT_SIZE_RATIO = 0.8; // 文字サイズに対する実際のフォントpx
const VIEW_TIME_MS = 3000; // 通常動画の表示時間
const FRONT_ADJUST_STAGING_MS = 1000;
const FRONT_ADJUST_VIEW_MS = 1000;
const BEHIND_ADJUST_VIEW_MS = 1000;
const FIXED_OVERLAP_IGNORE_MS = 200;
const COLLISION_EPSILON = 1e-4;
const BASE_ASPECT = { width: 4, height: 3 };
const DEFAULT_SHADOW_THICKNESS = 2.8;
const DEFAULT_SHADOW_ALPHA = 0.4;

const LINE_COUNTS = {
  characterSize: { big: 7.8, medium: 11.3, small: 16.6 },
  lineHeight: { big: 8.4, medium: 13.1, small: 21 },
  lineHeightAtResize: { big: 16, medium: 25.4, small: 38 },
};
const RESIZE_LINE_THRESHOLD = { big: 3, medium: 5, small: 7 };

const POSITIONS = ["ue", "naka", "shita"];
const SIZES = ["big", "medium", "small"];
const FONT_NAMES = ["defont", "gothic", "mincho"];
export const COLORS = {
  white: "#ffffff", red: "#ff0000", pink: "#ff8080", orange: "#ffc000",
  yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", blue: "#0000ff",
  purple: "#c000ff", black: "#000000",
  white2: "#cccc99", niconicowhite: "#cccc99", red2: "#cc0033", truered: "#cc0033",
  orange2: "#ff6600", passionorange: "#ff6600", yellow2: "#999900", madyellow: "#999900",
  green2: "#00cc66", elementalgreen: "#00cc66", blue2: "#3399ff", marineblue: "#3399ff",
  purple2: "#6633cc", nobleviolet: "#6633cc", pink2: "#ff33cc", cyan2: "#00cccc",
  black2: "#666666",
};
const ALPHA_BY_COMMAND = [{ command: "_live", alpha: 0.5 }];
const AT_SECONDS = /(?:^|\s)(@\d+(?:\.\d+)?)(?:\s|$)/;
const COLOR_CODE = /^#[a-z0-9]{6}$/i;
const NEWLINE = /\r\n|\r|\n/;

// ---- フォント（公式はOSごとに切り替える） ----
const F = (family, adjustBaselinePosition, weight) => ({ family, adjustBaselinePosition, weight });
const GENERIC = { defont: F("sans-serif", 0, 600), gothic: F("sans-serif", 0, 400), mincho: F("serif", 0, 400) };
const HIRAGINO_SANS_W6 = F('"ヒラギノ角ゴシック", "Hiragino Sans", HiraginoSans', -0.05, 600);
const HIRAGINO_SANS_W3 = F('"ヒラギノ角ゴシック", "Hiragino Sans", HiraginoSans', -0.04, 300);
const YU_GOTHIC = F('"游ゴシック体", "游ゴシック", "Yu Gothic", YuGothic, yugothic, YuGo-Medium', -0.04, 400);
const HIRAGINO_MINCHO = F('"ヒラギノ明朝 ProN W3", HiraMinProN-W3, "ヒラギノ明朝 ProN", HiraMinProN, "Hiragino Mincho ProN"', -0.02, 300);
const YU_MINCHO = F('"游明朝体", "游明朝", "Yu Mincho", YuMincho, yumincho, YuMin-Medium', -0.01, 400);
const KAKU_W6 = F('"ヒラギノ角ゴ ProN W6", HiraKakuProN-W6, "ヒラギノ角ゴ ProN", HiraKakuProN, "Hiragino Kaku Gothic ProN"', -0.05, 600);
const KAKU_W3 = F('"ヒラギノ角ゴ ProN W3", HiraKakuProN-W3, "ヒラギノ角ゴ ProN", HiraKakuProN, "Hiragino Kaku Gothic ProN"', -0.04, 300);
const join = (base, ...rest) => F([base, ...rest].map((f) => f.family).join(", "), base.adjustBaselinePosition, base.weight);
const ARIAL_MS_PGOTHIC = F('Arial, "ＭＳ Ｐゴシック", "MS PGothic", MSPGothic, MS-PGothic', 0.01, 600);
const GULIM = F('Gulim, "黑体", SimHei', 0.03, 400);
const SIMSUN = F('"宋体", SimSun', 0.135, 400);

const MAC_NEW = { defont: HIRAGINO_SANS_W6, gothic: join(YU_GOTHIC, HIRAGINO_SANS_W3), mincho: join(YU_MINCHO, HIRAGINO_MINCHO, HIRAGINO_SANS_W3) };
const MAC_OLD = { defont: KAKU_W6, gothic: join(YU_GOTHIC, KAKU_W3), mincho: join(YU_MINCHO, HIRAGINO_MINCHO, KAKU_W3) };
const MAC_LEGACY = { defont: KAKU_W6, gothic: KAKU_W3, mincho: HIRAGINO_MINCHO };
const WIN_7 = { defont: ARIAL_MS_PGOTHIC, gothic: join(YU_GOTHIC, GULIM, ARIAL_MS_PGOTHIC), mincho: join(YU_MINCHO, SIMSUN, ARIAL_MS_PGOTHIC) };
const WIN_10 = { defont: ARIAL_MS_PGOTHIC, gothic: join(YU_GOTHIC, SIMSUN, ARIAL_MS_PGOTHIC), mincho: join(YU_MINCHO, SIMSUN, ARIAL_MS_PGOTHIC) };
const WIN_OTHER = { defont: ARIAL_MS_PGOTHIC, gothic: join(GULIM, ARIAL_MS_PGOTHIC), mincho: join(SIMSUN, ARIAL_MS_PGOTHIC) };

export function officialFontFamilies(userAgent = navigator.userAgent) {
  const ua = userAgent.toLowerCase();
  let env = GENERIC;
  if (ua.includes("windows nt")) {
    if (/windows nt 6\.1/.test(ua)) env = WIN_7;
    else if (/windows nt 6\.2/.test(ua)) env = WIN_7;
    else if (/windows nt 6\.3/.test(ua)) env = WIN_10;
    else if (/windows nt 10\.[0-9]/.test(ua)) env = WIN_10;
    else env = WIN_OTHER;
  } else if (ua.includes("mac os x")) {
    if (/mac os x 10(\.|_)9/.test(ua)) env = MAC_OLD;
    else if (/mac os x 10(\.|_)10/.test(ua)) env = MAC_OLD;
    else if (/mac os x 10(\.|_)11/.test(ua)) env = MAC_NEW;
    else if (/mac os x 10(\.|_)1[2-9]/.test(ua)) env = MAC_NEW;
    else env = MAC_LEGACY;
  }
  return { ...GENERIC, ...env };
}

// コメント増量の「メイリオ」設定と同じく、標準フォントだけをメイリオ太字にする。
export function fontFamiliesFor(setting, customFamily) {
  const families = officialFontFamilies();
  if (setting === "meiryo") {
    families.defont = F('"メイリオ", Meiryo, sans-serif', 0, 700);
  } else if (setting === "custom" && customFamily && customFamily.trim()) {
    for (const key of FONT_NAMES) families[key] = { ...families[key], family: customFamily.trim() };
  }
  return families;
}

// ---- コマンド解析（公式と同じく、各属性は最初に現れたものが有効） ----
export function parseCommands(commands) {
  const out = { commands: [] };
  for (const raw of commands) {
    if (typeof raw !== "string" || raw === "") continue;
    const c = raw.toLowerCase();
    if (POSITIONS.includes(c)) { out.position ||= c; continue; }
    if (FONT_NAMES.includes(c)) { out.font ||= c; continue; }
    if (SIZES.includes(c)) { out.size ||= c; continue; }
    if (Object.hasOwn(COLORS, c)) { if (!out.color) { out.color = COLORS[c]; out.colorName = c; } continue; }
    if (COLOR_CODE.test(c)) { out.color ||= c; continue; }
    const at = raw.match(AT_SECONDS);
    if (at) { out.atNumber ??= Number(at[1].slice(1)); continue; }
    if (/^device:(.+)$/i.test(raw)) continue;
    out.commands.push(raw);
  }
  return {
    position: out.position ?? "naka",
    size: out.size ?? "medium",
    font: out.font ?? "defont",
    color: out.color ?? COLORS.white,
    atNumber: out.atNumber,
    rest: out.commands,
  };
}

// ---- 表示時間（動画の終端に掛かるコメントは前倒しする） ----
function viewTimeMs(chat, viewTime) {
  return chat.atNumber !== undefined ? chat.atNumber * 1000 : viewTime;
}
function vposInfoForMoving(chat, lengthMs, viewTime) {
  const view = viewTimeMs(chat, viewTime);
  let start = chat.vposMs - FRONT_ADJUST_VIEW_MS;
  let end = start + FRONT_ADJUST_VIEW_MS + view;
  if (lengthMs !== undefined && end > lengthMs) {
    start = lengthMs - (view + FRONT_ADJUST_VIEW_MS);
    end = lengthMs;
  }
  return { vStagingMs: start - FRONT_ADJUST_STAGING_MS, vStartMs: start, vEndMs: end, vRemoveMs: end + BEHIND_ADJUST_VIEW_MS };
}
function vposInfoForFixed(chat, lengthMs, viewTime) {
  const view = viewTimeMs(chat, viewTime);
  let start = chat.vposMs;
  let end = start + view;
  if (lengthMs !== undefined && lengthMs - start < view) {
    start = lengthMs - view;
    end = lengthMs;
  }
  return { vStagingMs: start, vStartMs: start, vEndMs: end, vRemoveMs: end };
}
const isFixed = (position) => position === "ue" || position === "shita";
const vposInfo = (chat, lengthMs, viewTime) =>
  isFixed(chat.position) ? vposInfoForFixed(chat, lengthMs, viewTime) : vposInfoForMoving(chat, lengthMs, viewTime);

// ---- 文字サイズ ----
function characterSize(size, screen) {
  return screen.baseHeight / LINE_COUNTS.characterSize[size];
}
function lineHeight(size, screen, atResize = false) {
  const cs = characterSize(size, screen);
  const lines = LINE_COUNTS.lineHeight[size];
  if (!atResize) return (screen.baseHeight - cs) / (lines - 1);
  const resized = LINE_COUNTS.lineHeightAtResize[size];
  return (screen.baseHeight - (lines / resized) * cs) / (resized - 1);
}
export function adjusterInfo(cs) {
  let actual = cs * FONT_SIZE_RATIO;
  let scale = 1;
  if (actual < SUPPORTED_MINIMUM_CHARACTER_SIZE) {
    if (actual >= 1) actual = Math.floor(actual);
    scale = actual / SUPPORTED_MINIMUM_CHARACTER_SIZE;
    actual = SUPPORTED_MINIMUM_CHARACTER_SIZE;
  } else {
    actual = Math.floor(actual);
  }
  return { actual, scale };
}

let measureContext;
function context2d() {
  if (!measureContext) {
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
    measureContext = canvas.getContext("2d");
  }
  return measureContext;
}
const widthCache = new Map();
function measureLineWidth(font, line) {
  const key = font + "\u0000" + line;
  let w = widthCache.get(key);
  if (w === undefined) {
    const ctx = context2d();
    ctx.font = font;
    w = ctx.measureText(line).width;
    if (widthCache.size > 200000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}
const fontString = (fontInfo, px) => `${fontInfo.weight} ${px}px ${fontInfo.family}`;

function measure(slot, cs, lh) {
  const adj = adjusterInfo(cs);
  const font = fontString(slot.fontInfo, adj.actual);
  let width = 0;
  for (const line of slot.lines) width = Math.max(width, Math.ceil(measureLineWidth(font, line) * adj.scale));
  const height = slot.lines.length > 1 ? lh * (slot.lines.length - 1) + cs : cs;
  return { width, height, characterSize: cs, lineHeight: lh };
}

// 公式の resizeSlotIfNeed と同じ。複数行は行間を詰め、固定コメントは幅に収める。
function resizeIfNeeded(slot, screen, fontScale) {
  const cs0 = slot.characterSize;
  const lh0 = slot.lineHeight;
  const limit = slot.rest.includes("full") ? screen.width : screen.baseWidth;
  let over = slot.width > limit;
  const many = slot.lines.length >= RESIZE_LINE_THRESHOLD[slot.size];
  const fixed = isFixed(slot.position);
  const ender = slot.rest.includes("ender");
  if (!(over && fixed) && (!many || ender)) return;
  let m;
  if (many && !ender) {
    // 公式はここで文字サイズ倍率を落とすが、大きさ設定が複数行にも効くよう掛け直す。
    const lh = lineHeight(slot.size, screen, true) * fontScale;
    m = measure(slot, slot.characterSize * (lh / slot.lineHeight), lh);
  } else {
    m = measure(slot, slot.characterSize, slot.lineHeight);
  }
  over = m.width > limit;
  const keepRatio = over && many && fixed && !ender;
  if (over && fixed) {
    const before = m.characterSize;
    const ratio = limit / m.width;
    m = measure(slot, m.characterSize * ratio, m.lineHeight * ratio);
    if (m.width > limit) {
      let guard = 0;
      do {
        const cs = m.characterSize - 1;
        m = measure(slot, cs, m.lineHeight * (cs / m.characterSize));
      } while (m.width >= limit && m.characterSize > 1 && ++guard < 500);
    } else {
      let prev;
      let guard = 0;
      do {
        prev = m;
        const cs = m.characterSize + 1;
        m = measure(slot, cs, m.lineHeight * (cs / m.characterSize));
      } while (m.width < limit && ++guard < 500);
      m = prev;
    }
    if (keepRatio) {
      const r = m.characterSize / before;
      m.characterSize = cs0 * r;
      m.lineHeight = lh0 * r;
    }
  }
  Object.assign(slot, measure(slot, m.characterSize, m.lineHeight));
}

function xAt(slot, t, reverse) {
  const p = (t - slot.vStartMs) / (slot.vEndMs - slot.vStartMs);
  return reverse ? slot.targetX + (slot.initialX - slot.targetX) * p : slot.initialX + (slot.targetX - slot.initialX) * p;
}

function stagingY(slot, staged, screen, random) {
  const area = screen.renderArea;
  const pos = slot.position;
  if (slot.height >= area.height) {
    if (pos === "shita") return area.y + area.height - slot.height;
    if (pos === "ue") return area.y;
    return area.y - (slot.height - area.height) / 2;
  }
  let y, down, limit;
  if (pos === "shita") { y = area.y + area.height - slot.height; down = false; limit = area.y; }
  else { y = area.y; down = true; limit = area.y + area.height; }
  const overlapsY = (top, h, other) => !(other.y + other.height <= top + COLLISION_EPSILON || top + h <= other.y + COLLISION_EPSILON);
  const overlapsX = (a, b) => a.initialX <= xAt(b, a.vStartMs) + b.width || xAt(a, b.vEndMs) <= b.targetX + b.width;
  // 縦位置に関係しない条件は先に絞り込む（判定の順序と結果は公式と同じ）
  const candidates = [];
  for (const other of staged) {
    if (other.position !== pos || !overlapsX(slot, other)) continue;
    if (isFixed(pos) && other.vEndMs - slot.vStartMs <= FIXED_OVERLAP_IGNORE_MS) continue;
    candidates.push(other);
  }
  let moved, overflow = false;
  do {
    moved = false;
    for (const other of candidates) {
      if (!overlapsY(y, slot.height, other)) continue;
      if (down) { y = other.y + other.height; if (y + slot.height > limit) overflow = true; else moved = true; }
      else { y = other.y - slot.height; if (y < limit) overflow = true; else moved = true; }
      break;
    }
  } while (!overflow && moved);
  return overflow ? area.y + random() * (area.height - slot.height) : y;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 公式の並び順：表示準備時刻、コメント番号、スレッドの順。
function compareChats(a, b) {
  let d = a.timing.vStagingMs - b.timing.vStagingMs;
  if (d !== 0) return d;
  d = (Number.isFinite(a.no) ? a.no : Infinity) - (Number.isFinite(b.no) ? b.no : Infinity) || 0;
  if (d !== 0) return d;
  const ta = Number(a.thread), tb = Number(b.thread);
  return Number.isNaN(ta) || Number.isNaN(tb) ? -1 : ta - tb;
}

/**
 * コメントの配置を計算する。
 * @param {Array} comments normalizeで整えたコメント
 * @param {object} o 画面とコメントの設定
 */
export function buildLayout(comments, o) {
  const height = BASE_CANVAS_HEIGHT;
  const width = height * o.aspect;
  const screen = {
    width,
    height,
    baseWidth: Math.ceil(height * (BASE_ASPECT.width / BASE_ASPECT.height)),
    baseHeight: Math.ceil(height),
    renderArea: { x: 0, y: 0, width, height },
  };
  const lengthMs = o.durationMs > 0 ? Math.floor(o.durationMs) : undefined;
  const viewTime = o.viewTimeMs ?? VIEW_TIME_MS;
  const families = o.fontFamilies;
  const slotLimit = o.slotLimit > 0 ? o.slotLimit : Infinity;
  const offset = o.offsetMs || 0;

  // コメントアート保護（コメント増量の「コメントアートが崩れないようにする」）
  const caGroup = o.keepCA ? commentArtGroups(comments) : new Map();

  const layers = new Map();
  comments.forEach((c, index) => {
    const parsed = parseCommands(c.commands);
    if (parsed.rest.includes("invisible")) return;
    const chat = {
      index,
      source: c,
      vposMs: Math.max(0, c.vposMs + offset),
      no: c.no,
      thread: c.thread,
      owner: c.owner,
      ...parsed,
      text: c.body.includes("\t") ? c.body.replace(/\t/g, "  ") : c.body,
    };
    if (chat.text === "") return;
    // 動画より後ろのコメント（長さの違う動画やタイミング補正で起きる）は終端に積もるので出さない
    if (lengthMs !== undefined && chat.vposMs > lengthMs) return;
    chat.timing = vposInfo(chat, lengthMs, viewTime);
    const ca = caGroup.get(c);
    chat.ignoreScale = ca !== undefined;
    const key = c.owner ? "owner" : ca !== undefined ? "ca" + ca : "main";
    if (!layers.has(key)) layers.set(key, []);
    layers.get(key).push(chat);
  });

  const items = [];
  let evicted = 0;
  for (const [key, chats] of layers) {
    chats.sort(compareChats);
    let staged = [];
    let nextExpiry = Infinity;
    for (const chat of chats) {
      const t = Math.max(0, chat.timing.vStagingMs);
      if (t >= nextExpiry) {
        staged = staged.filter((s) => s.removeAt > t);
        nextExpiry = staged.reduce((m, s) => Math.min(m, s.removeAt), Infinity);
      }
      const scale = chat.ignoreScale ? 1 : o.fontScale;
      const fontInfo = families[chat.font] ?? families.defont;
      const slot = {
        chat,
        key,
        owner: chat.owner,
        position: chat.position,
        size: chat.size,
        rest: chat.rest,
        lines: chat.text.split(NEWLINE),
        fontInfo,
        color: chat.color,
        alpha: ALPHA_BY_COMMAND.find((a) => chat.rest.includes(a.command))?.alpha ?? 1,
        ...chat.timing,
      };
      Object.assign(slot, measure(slot, characterSize(chat.size, screen) * scale, lineHeight(chat.size, screen) * scale));
      resizeIfNeeded(slot, screen, scale);
      if (isFixed(slot.position)) {
        slot.initialX = slot.targetX = screen.width / 2 - slot.width / 2;
      } else {
        slot.initialX = screen.width / 2 + screen.baseWidth / 2;
        slot.targetX = screen.width / 2 - screen.baseWidth / 2 - slot.width;
      }
      if (staged.length >= slotLimit) {
        const oldest = staged.shift();
        oldest.removeAt = t; // 枠が足りないと公式は最も古いコメントを消す
        evicted++;
      }
      slot.y = stagingY(slot, staged, screen, mulberry32((o.seed ?? 1) * 2654435761 + chat.index));
      slot.showFrom = isFixed(slot.position) ? slot.vStartMs : slot.vStagingMs;
      slot.removeAt = slot.vRemoveMs;
      nextExpiry = Math.min(nextExpiry, slot.removeAt);
      staged.push(slot);
      items.push(slot);
    }
  }
  // 重なり順：投稿者コメントが最前面、各レイヤー内は再生位置とコメント番号の順。
  for (const s of items) {
    s.order = [s.owner ? 1 : 0, s.chat.vposMs, Number.isFinite(s.chat.no) ? s.chat.no : 0, s.chat.index];
    s.end = s.removeAt;
  }
  return new Layout(items, screen, evicted);
}

const cmpOrder = (a, b) => {
  for (let i = 0; i < 4; i++) if (a.order[i] !== b.order[i]) return a.order[i] - b.order[i];
  return 0;
};

const BUCKET_MS = 1000;
class Layout {
  constructor(items, screen, evicted) {
    this.items = items;
    this.screen = screen;
    this.evicted = evicted;
    this.buckets = new Map();
    for (const item of items) {
      if (!(item.end > item.showFrom)) continue;
      const from = Math.floor(item.showFrom / BUCKET_MS);
      const to = Math.floor((item.end - 1) / BUCKET_MS);
      for (let b = from; b <= to; b++) {
        let list = this.buckets.get(b);
        if (!list) this.buckets.set(b, (list = []));
        list.push(item);
      }
    }
  }
  visibleAt(t) {
    const list = this.buckets.get(Math.floor(t / BUCKET_MS));
    if (!list) return [];
    const out = list.filter((s) => s.showFrom <= t && t < s.end);
    out.sort(cmpOrder);
    return out;
  }
}

// ---- 描画 ----
const fontMetricsCache = new Map();
// 公式が使う描画ライブラリと同じく、"|ÉqÅM" を実際に描いて上下の高さを測る。
function fontMetrics(font) {
  let m = fontMetricsCache.get(font);
  if (m) return m;
  const ctx = context2d();
  ctx.font = font;
  const text = "|ÉqÅM";
  const w = Math.max(1, Math.ceil(ctx.measureText(text).width));
  let baseline = Math.ceil(ctx.measureText("M").width);
  const h = Math.max(1, Math.ceil(2 * baseline));
  baseline = (baseline * 1.4) | 0;
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const c = canvas.getContext("2d", { willReadFrequently: true });
  c.fillStyle = "#f00";
  c.fillRect(0, 0, w, h);
  c.font = font;
  c.textBaseline = "alphabetic";
  c.fillStyle = "#000";
  c.fillText(text, 0, baseline);
  const data = c.getImageData(0, 0, w, h).data;
  const rowHasInk = (row) => {
    for (let x = 0; x < w; x++) if (data[(row * w + x) * 4] !== 255) return true;
    return false;
  };
  let top = 0;
  while (top < baseline && !rowHasInk(top)) top++;
  let bottom = h - 1;
  while (bottom > baseline && !rowHasInk(bottom)) bottom--;
  m = { ascent: baseline - top, descent: bottom - baseline };
  m.fontSize = m.ascent + m.descent;
  if (m.fontSize === 0) m = { ascent: 10, descent: 2, fontSize: 12 };
  fontMetricsCache.set(font, m);
  return m;
}

function shadowColor(color, alpha) {
  return color.toLowerCase() === "#000000" ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`;
}

// 1つのコメントを画像にする。scale は出力px / 基準px。
function renderItem(item, scale, style) {
  const adj = adjusterInfo(item.characterSize);
  const a = adj.scale;
  const font = fontString(item.fontInfo, adj.actual);
  const metrics = fontMetrics(font);
  const stroke = style.strokeThickness / a;
  const lh = item.lineHeight / a;
  let maxW = 0;
  for (const line of item.lines) maxW = Math.max(maxW, measureLineWidth(font, line));
  const textW = maxW + stroke;
  const textH = Math.max(lh, metrics.fontSize + stroke) + (item.lines.length - 1) * lh;
  const textX = (item.width - textW * a) / 2;
  const textY = (item.height - textH * a * a) / 2 + item.fontInfo.adjustBaselinePosition * item.lineHeight * a;
  const pad = style.strokeThickness + 4;
  const left = Math.min(0, textX) - pad;
  const top = Math.min(0, textY) - pad;
  const right = Math.max(item.width, textX + textW * a) + pad;
  const bottom = Math.max(item.height, textY + textH * a) + pad;
  const w = Math.max(1, Math.ceil((right - left) * scale));
  const h = Math.max(1, Math.ceil((bottom - top) * scale));
  if (w * h > 64e6) return null; // 極端に大きいものは描かない
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.translate(textX - left, textY - top);
  ctx.scale(a, a);
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.miterLimit = 10;
  ctx.lineWidth = stroke;
  ctx.strokeStyle = shadowColor(item.color, style.strokeAlpha);
  ctx.fillStyle = item.color;
  item.lines.forEach((line, i) => {
    const y = stroke / 2 + i * lh + metrics.ascent;
    if (stroke > 0 && style.strokeAlpha > 0) ctx.strokeText(line, stroke / 2, y);
    ctx.fillText(line, stroke / 2, y);
  });
  return { canvas, offsetX: left, offsetY: top };
}

export class CommentPainter {
  constructor() {
    this.cache = new Map();
    this.key = "";
    this.frame = 0;
  }
  /**
   * 時刻 t(ms) のコメントを ctx に描く。rect は描画先の基準領域（出力px）。
   */
  draw(ctx, layout, t, rect, style) {
    const scale = rect.height / layout.screen.height;
    const key = `${scale.toFixed(4)}|${style.strokeThickness}|${style.strokeAlpha}`;
    if (key !== this.key) { this.cache.clear(); this.key = key; }
    this.frame++;
    const visible = layout.visibleAt(t);
    for (const item of visible) {
      let entry = this.cache.get(item);
      if (entry === undefined) {
        entry = { image: renderItem(item, scale, style), used: 0 };
        this.cache.set(item, entry);
      }
      entry.used = this.frame;
      if (!entry.image) continue;
      const x = isFixed(item.position) ? item.initialX : xAt(item, t, false);
      ctx.globalAlpha = item.alpha;
      ctx.drawImage(entry.image.canvas, rect.x + (x + entry.image.offsetX) * scale, rect.y + (item.y + entry.image.offsetY) * scale);
    }
    ctx.globalAlpha = 1;
    if (this.cache.size > 1500) {
      for (const [k, v] of this.cache) if (this.frame - v.used > 30) this.cache.delete(k);
    }
    return visible.length;
  }
  clear() {
    this.cache.clear();
  }
}

// ---- コメントアートの判定（コメント増量が使う niconicomments の keepCA に倣う） ----
// CAを投稿したユーザーのコメントを投稿時刻の近さでまとめ、まとまりごとに別の衝突判定にする。
// まとまり同士は重なってもずらさないので、CAの行が他のコメントに押されて崩れない。
function commentArtGroups(comments) {
  const minScore = 10, timestampRange = 300;
  const score = new Map();
  for (const c of comments) {
    if (c.owner || !c.userId) continue;
    let s = score.get(c.userId) ?? 0;
    const mail = c.commands;
    if (mail.includes("ca") || mail.includes("patissier") || mail.includes("ender") || mail.includes("full")) s += 5;
    const breaks = (c.body.match(/\r\n|\n|\r/g) ?? []).length;
    if (breaks > 2) s += breaks / 2;
    score.set(c.userId, s);
  }
  const groups = new Map();
  const clusters = new Map();
  let id = 0;
  for (const c of comments) {
    if (c.owner || !c.userId || (score.get(c.userId) ?? 0) < minScore) continue;
    const date = c.postedAtSec ?? 0;
    let list = clusters.get(c.userId);
    if (!list) clusters.set(c.userId, (list = []));
    let cluster = list.find((g) => date >= g.start - timestampRange && date <= g.end + timestampRange);
    if (!cluster) list.push((cluster = { start: date, end: date, id: id++ }));
    cluster.start = Math.min(cluster.start, date);
    cluster.end = Math.max(cluster.end, date);
    groups.set(c, cluster.id);
  }
  return groups;
}
