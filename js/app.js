import { buildLayout, CommentPainter, fontFamiliesFor } from "./renderer.js";
import { parseCommentText, filterComments } from "./comments.js";
import { supportsWebCodecs, exportWithWebCodecs, exportWithRecorder } from "./exporter.js";

const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const stage = $("stage");

const DEFAULTS = {
  fontScale: 100,
  strokeAlpha: 0.4,
  strokeThickness: 2.8,
  opacity: 100,
  fps: 30,
  font: "default",
  customFont: "",
  keepCA: false,
  showCount: false,
  stageAspect: "16:9",
  slotLimit: "0",
  offsetSec: 0,
  showOwner: true,
  hideNicoscript: true,
  ngScore: "none",
  nicoruMin: 0,
  premiumOnly: false,
  hideEasy: false,
  ngWords: "",
  ngCommands: "",
  outHeight: "source",
  bitrate: 0,
  exportMode: "webcodecs",
  includeAudio: true,
};
// 配置の再計算が要らない設定（描画だけ変わる）
const DRAW_ONLY = new Set(["strokeAlpha", "strokeThickness", "opacity", "fps", "showCount", "outHeight", "bitrate", "exportMode", "includeAudio"]);
const STORAGE_KEY = "niconicomment_renderer.settings.v1";

let settings = loadSettings();
let videoFile = null;
let videoUrl = "";
let rawComments = [];
let layout = null;
let layoutKey = "";
const painter = new CommentPainter();
let exportController = null;

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* 保存できなくても動作は続ける */ }
}

// ---- 設定フォーム ----
function bindSettings() {
  for (const key of Object.keys(DEFAULTS)) {
    const el = $(key);
    if (!el) continue;
    const write = () => {
      if (el.type === "checkbox") el.checked = !!settings[key];
      else el.value = settings[key];
      const out = document.querySelector(`output[data-for="${key}"]`);
      if (out) out.textContent = settings[key];
    };
    write();
    el.addEventListener(el.type === "range" || el.tagName === "TEXTAREA" || el.type === "text" ? "input" : "change", () => {
      let v;
      if (el.type === "checkbox") v = el.checked;
      else if (el.type === "range" || el.type === "number") v = el.value === "" ? DEFAULTS[key] : Number(el.value);
      else v = el.value;
      settings[key] = v;
      const out = document.querySelector(`output[data-for="${key}"]`);
      if (out) out.textContent = v;
      saveSettings();
      onSettingChanged(key);
    });
    el._write = write;
  }
  $("customFont").hidden = settings.font !== "custom";
}

function onSettingChanged(key) {
  if (key === "font") $("customFont").hidden = settings.font !== "custom";
  if (key === "stageAspect") updateStageGeometry();
  if (key === "outHeight" || key === "stageAspect" || key === "bitrate") updateExportInfo();
  if (key === "exportMode") updateExportInfo();
  if (!DRAW_ONLY.has(key)) scheduleLayout();
  else painter.clear();
  requestDraw();
}

$("resetBtn").addEventListener("click", () => {
  settings = { ...DEFAULTS };
  saveSettings();
  for (const key of Object.keys(DEFAULTS)) $(key)?._write?.();
  $("customFont").hidden = true;
  updateStageGeometry();
  updateExportInfo();
  scheduleLayout();
});

// ---- 状態表示 ----
function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}
function fmtTime(sec) {
  if (!Number.isFinite(sec)) sec = 0;
  const s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

// ---- ファイル読み込み ----
function setVideoSource(url, name, file = null) {
  if (videoUrl.startsWith("blob:")) URL.revokeObjectURL(videoUrl);
  videoUrl = url;
  videoFile = file;
  video.src = url;
  $("videoName").textContent = name;
  setStatus("動画を読み込んでいます…");
}

async function loadCommentFiles(files) {
  const all = [];
  const names = [];
  for (const f of files) {
    try {
      const text = typeof f.text === "function" ? await f.text() : f.content;
      const list = parseCommentText(text, f.name);
      all.push(...list);
      names.push(`${f.name}（${list.length.toLocaleString()}件）`);
    } catch (e) {
      setStatus(`${f.name}: ${e.message}`, true);
      return;
    }
  }
  rawComments = all;
  $("commentName").textContent = names.join("、") || "未選択";
  scheduleLayout();
}

$("videoInput").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) setVideoSource(URL.createObjectURL(f), f.name, f);
});
$("commentInput").addEventListener("change", (e) => {
  if (e.target.files.length) loadCommentFiles([...e.target.files]);
});

for (const ev of ["dragover", "dragenter"]) {
  document.addEventListener(ev, (e) => { e.preventDefault(); document.body.classList.add("dragging"); });
}
document.addEventListener("dragleave", () => document.body.classList.remove("dragging"));
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  const files = [...(e.dataTransfer?.files ?? [])];
  const vid = files.find((f) => f.type.startsWith("video/") || /\.(mp4|webm|mkv|mov|m4v)$/i.test(f.name));
  const coms = files.filter((f) => /\.(json|xml)$/i.test(f.name));
  if (vid) setVideoSource(URL.createObjectURL(vid), vid.name, vid);
  if (coms.length) loadCommentFiles(coms);
});

// ---- 画面の比率と映像の位置 ----
function stageAspect() {
  if (settings.stageAspect === "video" && video.videoWidth && video.videoHeight) return video.videoWidth / video.videoHeight;
  return 16 / 9;
}
function containRect(srcW, srcH, w, h) {
  if (!srcW || !srcH) return { x: 0, y: 0, width: w, height: h };
  const s = Math.min(w / srcW, h / srcH);
  const vw = srcW * s, vh = srcH * s;
  return { x: (w - vw) / 2, y: (h - vh) / 2, width: vw, height: vh };
}
function updateStageGeometry() {
  const aspect = stageAspect();
  stage.style.aspectRatio = String(aspect);
  const r = containRect(video.videoWidth, video.videoHeight, 1000 * aspect, 1000);
  video.style.left = `${(r.x / (1000 * aspect)) * 100}%`;
  video.style.top = `${(r.y / 1000) * 100}%`;
  video.style.width = `${(r.width / (1000 * aspect)) * 100}%`;
  video.style.height = `${(r.height / 1000) * 100}%`;
  resizeOverlay();
}
function resizeOverlay() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(stage.clientWidth * dpr));
  const h = Math.max(1, Math.round(stage.clientHeight * dpr));
  if (overlay.width !== w || overlay.height !== h) {
    overlay.width = w;
    overlay.height = h;
    painter.clear();
  }
  requestDraw();
}
new ResizeObserver(resizeOverlay).observe(stage);

function exportGeometry() {
  const aspect = stageAspect();
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  let height;
  if (settings.outHeight === "source") height = settings.stageAspect === "video" ? vh : Math.max(vh, Math.round(vw / aspect));
  else height = Number(settings.outHeight);
  height = Math.max(2, Math.round(height / 2) * 2);
  const width = Math.max(2, Math.round((height * aspect) / 2) * 2);
  return { width, height, videoRect: containRect(vw, vh, width, height), stage: { x: 0, y: 0, width, height } };
}
function autoBitrate(g, fps) {
  const pixelsPerSec = g.width * g.height * fps;
  return Math.round(Math.min(60e6, Math.max(4e6, pixelsPerSec * 0.15)));
}
function updateExportInfo() {
  const g = exportGeometry();
  const fps = settings.fps;
  const br = settings.bitrate > 0 ? settings.bitrate * 1e6 : autoBitrate(g, fps);
  const parts = [`出力: ${g.width}×${g.height}、${fps}fps、約${(br / 1e6).toFixed(1)}Mbps`];
  if (settings.exportMode === "webcodecs" && !supportsWebCodecs()) parts.push("このブラウザはWebCodecsに対応していないため、録画方式を使います。");
  if (settings.exportMode === "webcodecs" && "showSaveFilePicker" in window) parts.push("保存先を選ぶと、メモリを使わずに直接書き込みます。");
  $("exportInfo").textContent = parts.join(" ");
}

// ---- 配置の計算 ----
let layoutTimer = 0;
function scheduleLayout() {
  clearTimeout(layoutTimer);
  // コメントが多いと配置計算に時間がかかるので、スライダー操作中は待つ
  layoutTimer = setTimeout(rebuildLayout, rawComments.length > 20000 ? 400 : 60);
}
function currentFilter() {
  const lines = (s) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return {
    ngWords: lines(settings.ngWords),
    ngCommands: lines(settings.ngCommands),
    ngScore: settings.ngScore,
    nicoruMin: settings.nicoruMin,
    premiumOnly: settings.premiumOnly,
    hideEasy: settings.hideEasy,
    showOwner: settings.showOwner,
    hideNicoscript: settings.hideNicoscript,
  };
}
function rebuildLayout() {
  if (!rawComments.length) {
    layout = null;
    updateReady();
    requestDraw();
    return;
  }
  const filtered = filterComments(rawComments, currentFilter());
  const durationMs = Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : 0;
  const opts = {
    aspect: stageAspect(),
    durationMs,
    fontScale: settings.fontScale / 100,
    fontFamilies: fontFamiliesFor(settings.font, settings.customFont),
    slotLimit: Number(settings.slotLimit),
    keepCA: settings.keepCA,
    offsetMs: Math.round(settings.offsetSec * 1000),
    seed: 1,
  };
  const key = JSON.stringify({ ...opts, n: filtered.length, raw: rawComments.length, f: currentFilter() });
  if (key === layoutKey && layout) { requestDraw(); return; }
  const t0 = performance.now();
  layout = buildLayout(filtered, opts);
  layoutKey = key;
  painter.clear();
  const ms = Math.round(performance.now() - t0);
  const evicted = layout.evicted ? `、表示枠不足で早めに消えたもの ${layout.evicted.toLocaleString()}件` : "";
  setStatus(`コメント ${filtered.length.toLocaleString()}件 / 読み込み ${rawComments.length.toLocaleString()}件（配置計算 ${ms}ms${evicted}）`);
  updateReady();
  requestDraw();
}

function updateReady() {
  const hasVideo = video.readyState >= 1;
  $("playBtn").disabled = !hasVideo;
  $("seek").disabled = !hasVideo;
  $("exportBtn").disabled = !(hasVideo && videoUrl) || !!exportController;
  $("stageEmpty").hidden = hasVideo;
}

// ---- 描画 ----
function drawStyle() {
  return { strokeAlpha: settings.strokeAlpha, strokeThickness: settings.strokeThickness };
}
function renderCommentsAt(ctx, tMs, rect) {
  if (!layout) return 0;
  return painter.draw(ctx, layout, tMs, rect, drawStyle());
}

let drawRequested = false;
let lastDrawAt = 0;
function requestDraw() {
  drawRequested = true;
}
function frameLoop(now) {
  requestAnimationFrame(frameLoop);
  const playing = !video.paused && !video.ended;
  const minInterval = 1000 / Math.max(1, settings.fps) - 1;
  if (!drawRequested && !(playing && now - lastDrawAt >= minInterval)) return;
  drawRequested = false;
  lastDrawAt = now;
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  overlay.style.opacity = String(settings.opacity / 100);
  const t = video.currentTime * 1000;
  const n = renderCommentsAt(ctx, t, { x: 0, y: 0, width: overlay.width, height: overlay.height });
  if (settings.showCount) {
    const fs = Math.max(12, overlay.height / 30);
    ctx.font = `600 ${fs}px sans-serif`;
    ctx.fillStyle = "rgba(0,0,0,.6)";
    ctx.fillRect(0, 0, fs * 9, fs * 1.6);
    ctx.fillStyle = "#fff";
    ctx.fillText(`描画数: ${n}`, fs * 0.4, fs * 1.15);
  }
  updateTimeUi();
}
requestAnimationFrame(frameLoop);

// ---- 再生操作 ----
function updateTimeUi() {
  const d = video.duration || 0;
  $("timeLabel").textContent = `${fmtTime(video.currentTime)} / ${fmtTime(d)}`;
  if (!seeking) $("seek").value = d ? String(Math.round((video.currentTime / d) * 1000)) : "0";
  $("playIcon").setAttribute("d", video.paused ? "M7 4l13 8-13 8z" : "M6 4h4v16H6zM14 4h4v16h-4z");
  $("playBtn").setAttribute("aria-label", video.paused ? "再生" : "一時停止");
}
let seeking = false;
$("playBtn").addEventListener("click", togglePlay);
function togglePlay() {
  if (video.paused || video.ended) video.play().catch((e) => setStatus(`再生できません: ${e.message}`, true));
  else video.pause();
}
$("seek").addEventListener("input", () => {
  seeking = true;
  if (video.duration) video.currentTime = (Number($("seek").value) / 1000) * video.duration;
  requestDraw();
});
$("seek").addEventListener("change", () => { seeking = false; });
$("volume").addEventListener("input", () => { video.volume = Number($("volume").value); });
video.volume = Number($("volume").value);
$("fullBtn").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen?.().catch(() => {});
});
stage.addEventListener("click", togglePlay);
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select, button")) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (e.code === "ArrowRight") { video.currentTime = Math.min(video.duration || 0, video.currentTime + 5); requestDraw(); }
  else if (e.code === "ArrowLeft") { video.currentTime = Math.max(0, video.currentTime - 5); requestDraw(); }
});
for (const ev of ["seeked", "timeupdate", "pause", "play"]) video.addEventListener(ev, requestDraw);
video.addEventListener("loadedmetadata", () => {
  updateStageGeometry();
  updateExportInfo();
  updateReady();
  scheduleLayout();
  setStatus(`動画: ${video.videoWidth}×${video.videoHeight}、${fmtTime(video.duration)}`);
});
video.addEventListener("durationchange", scheduleLayout);
video.addEventListener("error", () => setStatus("この動画はブラウザで再生できない形式です。MP4(H.264) や WebM を試してください。", true));

// ---- 書き出し ----
function log(text) {
  const el = $("exportLog");
  el.textContent += (el.textContent ? "\n" : "") + text;
  el.scrollTop = el.scrollHeight;
}
function baseName() {
  const n = $("videoName").textContent || "video";
  return n.replace(/\.[^.]+$/, "") + "_comment";
}
$("exportBtn").addEventListener("click", startExport);
$("cancelBtn").addEventListener("click", () => exportController?.abort());

async function startExport() {
  if (!videoUrl) return;
  rebuildLayout();
  const fps = Math.max(1, Math.min(120, Number(settings.fps) || 30));
  const geometry = exportGeometry();
  const bitrate = settings.bitrate > 0 ? settings.bitrate * 1e6 : autoBitrate(geometry, fps);
  const durationSec = video.duration;
  const useWebCodecs = settings.exportMode === "webcodecs" && supportsWebCodecs();
  // 書き出し用の描画は解像度が違うので、プレビュー用とは別の画像キャッシュを使う。
  // 書き出し中に設定を動かしても出力が途中で変わらないよう、開始時の状態を使う。
  const exportPainter = new CommentPainter();
  const exportLayout = layout;
  const exportStyle = drawStyle();
  const opacity = settings.opacity / 100;
  const includeAudio = settings.includeAudio;
  const renderForExport = (ctx, tMs) => (exportLayout ? exportPainter.draw(ctx, exportLayout, tMs, geometry.stage, exportStyle) : 0);

  let writable = null;
  const ext = useWebCodecs ? "mp4" : (MediaRecorder.isTypeSupported?.("video/mp4") ? "mp4" : "webm");
  if (useWebCodecs && "showSaveFilePicker" in window) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: `${baseName()}.mp4`, types: [{ description: "MP4動画", accept: { "video/mp4": [".mp4"] } }] });
      writable = await handle.createWritable();
    } catch (e) {
      if (e.name === "AbortError") return;
      writable = null;
    }
  }

  exportController = new AbortController();
  $("exportLog").textContent = "";
  $("exportProgress").hidden = false;
  $("exportProgress").value = 0;
  $("cancelBtn").hidden = false;
  updateReady();
  video.pause();
  const started = performance.now();
  let exportVideo = null;
  try {
    let result;
    if (useWebCodecs) {
      exportVideo = document.createElement("video");
      exportVideo.muted = true;
      exportVideo.preload = "auto";
      exportVideo.src = videoUrl;
      await new Promise((resolve, reject) => {
        exportVideo.onloadeddata = resolve;
        exportVideo.onerror = () => reject(new Error("動画を読み込めませんでした。"));
      });
      result = await exportWithWebCodecs({
        video: exportVideo,
        file: videoFile ?? (await (await fetch(videoUrl)).blob()),
        geometry, fps, durationSec, bitrate,
        includeAudio,
        renderComments: renderForExport,
        opacity,
        signal: exportController.signal,
        writable,
        log,
        onProgress: (p, elapsed, speed) => {
          $("exportProgress").value = p;
          const remain = speed > 0 ? ((1 - p) * durationSec * fps) / speed : 0;
          $("exportInfo").textContent = `書き出し中 ${(p * 100).toFixed(1)}%（${speed.toFixed(1)}fps、残り約${fmtTime(remain)}）`;
        },
      });
    } else {
      result = await exportWithRecorder({
        videoUrl, geometry, fps, durationSec, bitrate,
        includeAudio,
        renderComments: renderForExport,
        opacity,
        signal: exportController.signal,
        log,
        onProgress: (p) => {
          $("exportProgress").value = p;
          $("exportInfo").textContent = `録画中 ${(p * 100).toFixed(1)}%`;
        },
      });
    }
    const sec = ((performance.now() - started) / 1000).toFixed(1);
    if (result.savedToFile) {
      log(`保存しました（${sec}秒）。`);
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(result.blob);
      a.download = `${baseName()}.${result.blob.type.includes("webm") ? "webm" : ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      log(`完了しました（${sec}秒、${(result.blob.size / 1048576).toFixed(1)}MB）。`);
    }
    $("exportProgress").value = 1;
  } catch (e) {
    if (e.name === "AbortError") log("中止しました。");
    else { log(`失敗しました: ${e.message ?? e}`); console.error(e); }
    try { await writable?.abort?.(); } catch { /* 閉じられなくても続ける */ }
  } finally {
    if (exportVideo) { exportVideo.removeAttribute("src"); exportVideo.load(); }
    exportController = null;
    $("cancelBtn").hidden = true;
    updateReady();
    updateExportInfo();
  }
}

// ---- 起動 ----
bindSettings();
updateExportInfo();
updateReady();

// テストや共有用：?video=URL&comments=URL で同じオリジンのファイルを読み込む
const params = new URLSearchParams(location.search);
if (params.get("video")) {
  const u = params.get("video");
  setVideoSource(u, u.split("/").pop());
}
if (params.get("comments")) {
  const u = params.get("comments");
  fetch(u).then((r) => r.text()).then((text) => loadCommentFiles([{ name: u.split("/").pop(), content: text }])).catch((e) => setStatus(`コメントを取得できません: ${e.message}`, true));
}
window.__app = { get layout() { return layout; }, settings: () => settings, video };
