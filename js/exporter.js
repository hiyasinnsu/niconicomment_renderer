// コメントを合成した動画の書き出し。
// 高速モード：MP4は中身を直接読み、WebCodecsで復号→合成→H.264に符号化する。
//   AAC音声は再符号化せずそのままコピーする。MP4以外はシークしながら1フレームずつ描く。
// 録画モード：再生しながらキャンバスを録画する（WebCodecsが使えない環境向け）。
import { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } from "../lib/mp4-muxer.mjs";

export function supportsWebCodecs() {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

/**
 * 1フレーム分を描く。geometry.videoRect は映像の位置（出力px）。
 */
export function compositeFrame(ctx, source, geometry, drawComments, commentCanvas, opacity) {
  const { width, height, videoRect } = geometry;
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  const ready = source && (typeof HTMLVideoElement === "undefined" || !(source instanceof HTMLVideoElement) || source.readyState >= 2);
  if (ready) ctx.drawImage(source, videoRect.x, videoRect.y, videoRect.width, videoRect.height);
  const cctx = commentCanvas.getContext("2d");
  cctx.clearRect(0, 0, commentCanvas.width, commentCanvas.height);
  drawComments(cctx);
  ctx.globalAlpha = opacity;
  ctx.drawImage(commentCanvas, 0, 0);
  ctx.globalAlpha = 1;
}

// 非表示のタブでは setTimeout が間引かれるので、待機には使わない
function yieldTask() {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}
async function waitForQueue(codec, max, sizeKey = "encodeQueueSize") {
  while (codec[sizeKey] > max) {
    if ("ondequeue" in codec) await new Promise((r) => codec.addEventListener("dequeue", r, { once: true }));
    else await yieldTask();
  }
}

function seek(video, time) {
  return new Promise((resolve, reject) => {
    if (Math.abs(video.currentTime - time) < 1e-6 && !video.seeking && video.readyState >= 2) {
      resolve();
      return;
    }
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("動画のシークに失敗しました。")); };
    const cleanup = () => { video.removeEventListener("seeked", done); video.removeEventListener("error", fail); };
    video.addEventListener("seeked", done);
    video.addEventListener("error", fail);
    video.currentTime = time;
  });
}

async function pickVideoConfig(width, height, fps, bitrate) {
  const candidates = ["avc1.640034", "avc1.640033", "avc1.640028", "avc1.4d0034", "avc1.42003e"];
  for (const codec of candidates) {
    for (const hardwareAcceleration of ["prefer-hardware", "no-preference", "prefer-software"]) {
      const config = { codec, width, height, bitrate, framerate: fps, hardwareAcceleration, avc: { format: "avc" } };
      try {
        const r = await VideoEncoder.isConfigSupported(config);
        if (r.supported) return { config: r.config, muxCodec: "avc" };
      } catch { /* 次の候補 */ }
    }
  }
  for (const codec of ["vp09.00.51.08", "vp09.00.41.08"]) {
    const config = { codec, width, height, bitrate, framerate: fps };
    try {
      const r = await VideoEncoder.isConfigSupported(config);
      if (r.supported) return { config: r.config, muxCodec: "vp9" };
    } catch { /* 次の候補 */ }
  }
  throw new Error(`この環境では ${width}x${height} の動画を符号化できません。解像度を下げてください。`);
}

// ---- MP4の解析 ----
async function readTopLevelBoxes(file) {
  const boxes = [];
  let off = 0;
  while (off + 8 <= file.size && boxes.length < 10000) {
    const view = new DataView(await file.slice(off, Math.min(file.size, off + 16)).arrayBuffer());
    let size = view.getUint32(0);
    const type = String.fromCharCode(view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7));
    let header = 8;
    if (size === 1) {
      if (view.byteLength < 16) break;
      size = Number(view.getBigUint64(8));
      header = 16;
    } else if (size === 0) {
      size = file.size - off;
    }
    if (size < header) break;
    boxes.push({ type, offset: off, size });
    off += size;
  }
  return boxes;
}

const IDENTITY_MATRIX = [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];

/** MP4なら中身の情報を返す。MP4でない・断片化MP4などは null。 */
async function probeMp4(file) {
  const MP4Box = globalThis.MP4Box;
  const DataStream = globalThis.DataStream;
  if (!MP4Box || !DataStream || !file) return null;
  const boxes = await readTopLevelBoxes(file);
  if (boxes[0]?.type !== "ftyp") return null;
  const moov = boxes.find((b) => b.type === "moov");
  if (!moov || boxes.some((b) => b.type === "moof")) return null;
  if (moov.size > 512 * 1024 * 1024) return null;
  const mp4 = MP4Box.createFile(false);
  let error = null;
  mp4.onError = (e) => { error = e; };
  // ftyp と moov だけを続けて渡す。サンプルの位置は moov 内の絶対位置なので影響しない。
  let pos = 0;
  for (const b of [boxes[0], moov]) {
    const buf = await file.slice(b.offset, b.offset + b.size).arrayBuffer();
    buf.fileStart = pos;
    pos += buf.byteLength;
    mp4.appendBuffer(buf);
  }
  mp4.flush();
  if (error) throw new Error(String(error));
  const info = mp4.getInfo();
  const descriptionOf = (trak) => {
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (box) {
        const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(stream);
        return new Uint8Array(stream.buffer, 8);
      }
    }
    return undefined;
  };
  const aacConfigOf = (trak) => {
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    const data = entry?.esds?.esd?.descs?.[0]?.descs?.[0]?.data;
    return data ? new Uint8Array(data) : undefined;
  };
  const vt = info.videoTracks[0];
  const at = info.audioTracks[0];
  const result = { info };
  if (vt) {
    const trak = mp4.getTrackById(vt.id);
    const matrix = Array.from(vt.matrix ?? IDENTITY_MATRIX);
    result.video = {
      codec: vt.codec,
      width: vt.video?.width ?? vt.track_width,
      height: vt.video?.height ?? vt.track_height,
      description: descriptionOf(trak),
      samples: trak.samples,
      rotated: matrix.some((v, i) => v !== IDENTITY_MATRIX[i]),
    };
  }
  if (at && /^mp4a\.40\./.test(at.codec)) {
    const trak = mp4.getTrackById(at.id);
    result.audio = {
      codec: at.codec,
      sampleRate: at.audio.sample_rate,
      channels: at.audio.channel_count,
      description: aacConfigOf(trak),
      samples: trak.samples,
    };
  }
  return result;
}

// ファイルの中のサンプルを順に読む（まとめて読み込んでから切り出す）
function sampleReader(file) {
  const WINDOW = 8 * 1024 * 1024;
  let start = 0, end = 0, buf = null;
  return async (s) => {
    if (!buf || s.offset < start || s.offset + s.size > end) {
      start = s.offset;
      end = Math.min(file.size, Math.max(s.offset + s.size, s.offset + WINDOW));
      buf = new Uint8Array(await file.slice(start, end).arrayBuffer());
    }
    return buf.subarray(s.offset - start, s.offset - start + s.size);
  };
}

// 元のAAC音声をそのまま出力へコピーする
async function copyAacAudio(file, audio, muxer, durationSec, check) {
  const read = sampleReader(file);
  const meta = { decoderConfig: { codec: audio.codec, sampleRate: audio.sampleRate, numberOfChannels: audio.channels, description: audio.description } };
  const first = audio.samples[0];
  const base = first ? first.cts : 0;
  let isFirst = true;
  for (const s of audio.samples) {
    check();
    const ts = ((s.cts - base) / s.timescale) * 1e6;
    if (ts / 1e6 >= durationSec) break;
    const data = await read(s);
    muxer.addAudioChunkRaw(data, "key", Math.round(ts), Math.round((s.duration / s.timescale) * 1e6), isFirst ? meta : undefined);
    isFirst = false;
  }
}

// 映像を復号して、出力フレームの時刻ごとに直前のフレームを渡す
async function decodeMp4Video(file, v, o) {
  if (typeof VideoDecoder === "undefined" || v.rotated || !v.samples?.length) return false;
  const config = { codec: v.codec, codedWidth: v.width, codedHeight: v.height, description: v.description };
  let supported = false;
  try { supported = (await VideoDecoder.isConfigSupported(config)).supported; } catch { supported = false; }
  if (!supported) return false;
  const tsBase = v.samples.reduce((m, s) => Math.min(m, s.cts / s.timescale), Infinity);
  let current = null;
  let decodeError = null;
  const EPS = 1e-3;
  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        const pts = frame.timestamp / 1e6;
        while (o.written() < o.frameCount && o.written() / o.fps < pts - EPS) o.emit(current ?? frame);
      } catch (e) {
        decodeError = e;
      }
      current?.close();
      current = frame;
    },
    error: (e) => { decodeError = e; },
  });
  decoder.configure(config);
  const read = sampleReader(file);
  try {
    for (const s of v.samples) {
      o.check();
      if (decodeError) throw decodeError;
      if (o.written() >= o.frameCount) break;
      const data = await read(s);
      decoder.decode(new EncodedVideoChunk({
        type: s.is_sync ? "key" : "delta",
        timestamp: Math.round((s.cts / s.timescale - tsBase) * 1e6),
        duration: Math.round((s.duration / s.timescale) * 1e6),
        data,
      }));
      await waitForQueue(decoder, 12, "decodeQueueSize");
      await o.waitEncoder();
    }
    await decoder.flush();
    if (decodeError) throw decodeError;
    while (o.written() < o.frameCount) {
      o.check();
      o.emit(current);
      if (o.written() % 30 === 0) await o.waitEncoder();
    }
  } finally {
    current?.close();
    if (decoder.state !== "closed") decoder.close();
  }
  return true;
}

// ---- 音声の再符号化（AACをコピーできない場合） ----
async function decodeAudio(file, log) {
  if (typeof AudioEncoder === "undefined") return null;
  if (file.size > 1.5 * 1024 ** 3) {
    log("動画が大きいため音声を読み込めません。MP4(AAC音声)なら音声も含めて書き出せます。");
    return null;
  }
  try {
    const buf = await file.arrayBuffer();
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 48000 });
    return await ctx.decodeAudioData(buf);
  } catch (e) {
    log(`音声を読み込めなかったため、音声なしで書き出します（${e?.message ?? e}）。`);
    return null;
  }
}

async function pickAudioConfig(audio) {
  const channels = Math.min(2, audio.numberOfChannels);
  for (const [codec, muxCodec] of [["mp4a.40.2", "aac"], ["opus", "opus"]]) {
    const config = { codec, sampleRate: audio.sampleRate, numberOfChannels: channels, bitrate: 192000 };
    try {
      const r = await AudioEncoder.isConfigSupported(config);
      if (r.supported) return { config: r.config, muxCodec, channels };
    } catch { /* 次の候補 */ }
  }
  return null;
}

async function encodePcmAudio(audio, aConfig, muxer, durationSec, check, onError) {
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: onError,
  });
  audioEncoder.configure(aConfig.config);
  const ch = aConfig.channels;
  const total = Math.min(audio.length, Math.ceil(durationSec * audio.sampleRate));
  const block = 4096;
  const planes = [];
  for (let c = 0; c < ch; c++) planes.push(audio.getChannelData(Math.min(c, audio.numberOfChannels - 1)));
  for (let pos = 0; pos < total; pos += block) {
    check();
    const n = Math.min(block, total - pos);
    const data = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) data.set(planes[c].subarray(pos, pos + n), c * n);
    const ad = new AudioData({ format: "f32-planar", sampleRate: audio.sampleRate, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((pos / audio.sampleRate) * 1e6), data });
    audioEncoder.encode(ad);
    ad.close();
    await waitForQueue(audioEncoder, 64);
  }
  await audioEncoder.flush();
  audioEncoder.close();
}

/**
 * WebCodecsで書き出す。
 * @returns {Promise<{blob?: Blob, savedToFile: boolean}>}
 */
export async function exportWithWebCodecs(o) {
  const { video, file, geometry, fps, durationSec, renderComments, opacity, signal, onProgress, log, writable } = o;
  const { width, height } = geometry;
  const bitrate = o.bitrate;
  const { config: vConfig, muxCodec: vMux } = await pickVideoConfig(width, height, fps, bitrate);
  log(`映像: ${vConfig.codec} ${width}x${height} ${fps}fps ${(bitrate / 1e6).toFixed(1)}Mbps`);

  let encodeError = null;
  const check = () => {
    if (signal?.aborted) throw new DOMException("中止しました", "AbortError");
    if (encodeError) throw encodeError;
  };

  let mp4 = null;
  try { mp4 = await probeMp4(file); } catch (e) { log(`MP4の解析に失敗しました（${e?.message ?? e}）。`); }

  // 音声の方針を決める
  let audioMode = null; // "copy" | "encode"
  let pcm = null, aConfig = null;
  if (o.includeAudio) {
    if (mp4?.audio?.description) {
      audioMode = "copy";
      log(`音声: 元のAAC音声をそのまま使います（${mp4.audio.sampleRate}Hz ${mp4.audio.channels}ch）`);
    } else {
      pcm = await decodeAudio(file, log);
      if (pcm) {
        aConfig = await pickAudioConfig(pcm);
        if (aConfig) { audioMode = "encode"; log(`音声: ${aConfig.config.codec} ${pcm.sampleRate}Hz ${aConfig.channels}ch に変換します`); }
        else log("音声の符号化に対応していないため、音声なしで書き出します。");
      }
    }
  }

  const target = writable ? new FileSystemWritableFileStreamTarget(writable) : new ArrayBufferTarget();
  const audioOpt = audioMode === "copy"
    ? { codec: "aac", numberOfChannels: mp4.audio.channels, sampleRate: mp4.audio.sampleRate }
    : audioMode === "encode" ? { codec: aConfig.muxCodec, numberOfChannels: aConfig.channels, sampleRate: pcm.sampleRate } : undefined;
  const muxer = new Muxer({
    target,
    video: { codec: vMux, width, height, frameRate: fps },
    audio: audioOpt,
    fastStart: writable ? false : "in-memory",
    firstTimestampBehavior: "offset",
  });

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e; },
  });
  videoEncoder.configure(vConfig);

  if (audioMode === "copy") await copyAacAudio(file, mp4.audio, muxer, durationSec, check);
  else if (audioMode === "encode") {
    await encodePcmAudio(pcm, aConfig, muxer, durationSec, check, (e) => { encodeError = e; });
    pcm = null;
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: false });
  const commentCanvas = new OffscreenCanvas(width, height);
  const frameCount = Math.max(1, Math.floor(durationSec * fps));
  const keyInterval = Math.max(1, Math.round(fps * 2));
  const started = performance.now();
  let written = 0;
  // 次の出力フレームを source から作って符号化する
  const emit = (source) => {
    const t = written / fps;
    compositeFrame(ctx, source, geometry, (c) => renderComments(c, t * 1000), commentCanvas, opacity);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((written * 1e6) / fps), duration: Math.round(1e6 / fps) });
    videoEncoder.encode(frame, { keyFrame: written % keyInterval === 0 });
    frame.close();
    written++;
    if (written % 5 === 0 || written === frameCount) {
      const elapsed = (performance.now() - started) / 1000;
      onProgress?.(written / frameCount, elapsed, written / Math.max(elapsed, 1e-3));
    }
  };

  let decoded = false;
  if (mp4?.video && o.preferDecoder !== false) {
    try {
      decoded = await decodeMp4Video(file, mp4.video, {
        frameCount, fps, emit, check,
        written: () => written,
        waitEncoder: () => waitForQueue(videoEncoder, 6),
      });
      if (decoded) log("映像: MP4を直接復号しました。");
    } catch (e) {
      if (e?.name === "AbortError" || e === encodeError || written > 0) throw e;
      log(`映像の直接復号に失敗したため、シーク方式に切り替えます（${e?.message ?? e}）。`);
    }
  }
  if (!decoded) {
    log("映像: 再生位置を1フレームずつ移動して読み込みます（時間がかかります）。");
    video.pause();
    while (written < frameCount) {
      check();
      const t = written / fps;
      await seek(video, Math.min(t, Math.max(0, video.duration - 0.001)));
      emit(video);
      await waitForQueue(videoEncoder, 6);
    }
  }
  await videoEncoder.flush();
  videoEncoder.close();
  if (encodeError) throw encodeError;
  muxer.finalize();
  if (writable) {
    await writable.close();
    return { savedToFile: true };
  }
  return { blob: new Blob([target.buffer], { type: "video/mp4" }), savedToFile: false };
}

/**
 * 再生しながら録画する。所要時間は動画の長さと同じ。
 */
export async function exportWithRecorder(o) {
  const { videoUrl, geometry, fps, durationSec, renderComments, opacity, signal, onProgress, log } = o;
  const { width, height } = geometry;
  const video = document.createElement("video");
  video.src = videoUrl;
  video.playsInline = true;
  video.preload = "auto";
  await new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = () => reject(new Error("動画を読み込めませんでした。"));
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  const commentCanvas = new OffscreenCanvas(width, height);
  const stream = canvas.captureStream(fps);
  let audioCtx;
  if (o.includeAudio) {
    try {
      audioCtx = new AudioContext();
      const src = audioCtx.createMediaElementSource(video);
      const dest = audioCtx.createMediaStreamDestination();
      src.connect(dest);
      for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
    } catch (e) {
      log(`音声を取り込めませんでした（${e.message}）。`);
    }
  }
  const types = [
    "video/mp4;codecs=avc1.640028,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  log(`録画形式: ${mimeType || "既定"}`);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: o.bitrate, audioBitsPerSecond: 192000 });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { recorder.onstop = r; });

  // 描画のきっかけはWorkerのタイマーにする（requestAnimationFrame は非表示のタブで止まるため）
  log("録画中はこのタブを表示したままにしてください。");
  const ticker = new Worker(URL.createObjectURL(new Blob(
    ["let id;onmessage=(e)=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data);};"],
    { type: "text/javascript" },
  )));
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  ticker.onmessage = () => {
    compositeFrame(ctx, video, geometry, (c) => renderComments(c, video.currentTime * 1000), commentCanvas, opacity);
    onProgress?.(Math.min(1, video.currentTime / durationSec));
    if (signal?.aborted || video.ended || video.currentTime >= durationSec) finish();
  };
  compositeFrame(ctx, video, geometry, (c) => renderComments(c, 0), commentCanvas, opacity);
  recorder.start(1000);
  await video.play();
  ticker.postMessage(1000 / fps);
  video.addEventListener("ended", () => finish(), { once: true });
  await finished;
  ticker.terminate();
  video.pause();
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  video.removeAttribute("src");
  video.load();
  if (signal?.aborted) throw new DOMException("中止しました", "AbortError");
  return { blob: new Blob(chunks, { type: (mimeType || "video/webm").split(";")[0] }), savedToFile: false };
}
