// コメントファイルの読み込みと絞り込み。
// コメント増量が保存するJSON（スレッドの配列）を主な対象とし、
// ニコニコのAPIが返す {data:{threads}}、コメントだけの配列、旧形式のJSON、
// コメント増量の「XMLでダウンロード」で保存したXMLも読める。

function toSeconds(postedAt) {
  if (postedAt === undefined || postedAt === null || postedAt === "") return 0;
  if (typeof postedAt === "number") return postedAt > 1e11 ? postedAt / 1000 : postedAt;
  if (/^\d+$/.test(postedAt)) return Number(postedAt);
  const t = Date.parse(postedAt);
  return Number.isFinite(t) ? t / 1000 : 0;
}

function splitCommands(commands) {
  if (Array.isArray(commands)) return commands.filter((c) => typeof c === "string" && c !== "");
  if (typeof commands === "string") return commands.split(/\s+/).filter(Boolean);
  return [];
}

function fromV1(comment, thread) {
  if (!comment || typeof comment.body !== "string") return null;
  const vposMs = Number(comment.vposMs ?? (comment.vpos !== undefined ? comment.vpos * 10 : NaN));
  if (!Number.isFinite(vposMs)) return null;
  const fork = String(thread?.fork ?? "main");
  return {
    body: comment.body,
    commands: splitCommands(comment.commands ?? comment.mail),
    vposMs,
    no: Number(comment.no),
    userId: comment.userId ?? comment.user_id ?? "",
    isPremium: !!comment.isPremium,
    score: Number(comment.score ?? 0),
    nicoruCount: Number(comment.nicoruCount ?? 0),
    postedAtSec: toSeconds(comment.postedAt ?? comment.date),
    owner: fork === "owner",
    fork,
    thread: thread?.id ?? 0,
  };
}

function fromLegacyChat(chat) {
  if (!chat || typeof chat.content !== "string") return null;
  return {
    body: chat.content,
    commands: splitCommands(chat.mail),
    vposMs: Number(chat.vpos) * 10,
    no: Number(chat.no),
    userId: chat.user_id ?? "",
    isPremium: chat.premium === 1 || chat.premium === "1",
    score: Number(chat.score ?? 0),
    nicoruCount: Number(chat.nicoru ?? 0),
    postedAtSec: Number(chat.date ?? 0),
    owner: String(chat.fork) === "1" || chat.fork === "owner",
    fork: String(chat.fork) === "1" ? "owner" : "main",
    thread: chat.thread ?? 0,
  };
}

export function parseCommentText(text, fileName = "") {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (trimmed.startsWith("<")) return parseXml(trimmed);
  const data = JSON.parse(trimmed);
  return parseJson(data, fileName);
}

function parseJson(data) {
  let threads = Array.isArray(data) ? data : data?.data?.threads ?? data?.threads;
  if (!Array.isArray(threads)) throw new Error("対応していないJSON形式です（スレッドの配列が見つかりません）。");
  const out = [];
  // 旧形式：[{thread:...},{chat:{...}}]
  if (threads.some((t) => t && typeof t === "object" && "chat" in t)) {
    for (const item of threads) {
      const c = fromLegacyChat(item?.chat);
      if (c) out.push(c);
    }
    return out;
  }
  // コメントだけの配列
  if (threads.length && typeof threads[0]?.body === "string") threads = [{ fork: "main", comments: threads }];
  for (const thread of threads) {
    if (!thread || !Array.isArray(thread.comments)) continue;
    for (const comment of thread.comments) {
      const c = fromV1(comment, thread);
      if (c) out.push(c);
    }
  }
  return out;
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("XMLとして読み込めませんでした。");
  const out = [];
  for (const el of doc.getElementsByTagName("chat")) {
    const attr = (n) => el.getAttribute(n);
    const c = fromLegacyChat({
      content: el.textContent ?? "",
      mail: attr("mail") ?? "",
      vpos: Number(attr("vpos")),
      no: Number(attr("no")),
      user_id: attr("user_id") ?? "",
      premium: attr("premium"),
      date: Number(attr("date") ?? 0),
      score: Number(attr("score") ?? 0),
      fork: attr("fork") ?? "",
      thread: attr("thread") ?? 0,
    });
    if (c && Number.isFinite(c.vposMs)) out.push(c);
  }
  return out;
}

const NG_SCORE = { none: -Infinity, weak: -10000, medium: -4800, strong: -1000, strongest: -1 };
export const NG_SCORE_LEVELS = NG_SCORE;

/**
 * コメント増量の絞り込み（NGコマンド、NGワード、NGスコア、ニコられ数、プレミアム）と同じ規則。
 * 投稿者コメントには適用しない。
 */
export function filterComments(comments, f) {
  const ngCommands = (f.ngCommands ?? []).map((s) => s.toLowerCase().split(/\s+/).filter(Boolean)).filter((a) => a.length);
  const ngWords = (f.ngWords ?? []).filter((s) => s !== "");
  const minScore = NG_SCORE[f.ngScore] ?? -Infinity;
  const nicoruMin = Number(f.nicoruMin) || 0;
  return comments.filter((c) => {
    if (c.owner) {
      if (!f.showOwner) return false;
      // 「＠ボタン」などのニコスクリプトは画面に出さない
      if (f.hideNicoscript && /^[@＠]/.test(c.body)) return false;
      return true;
    }
    if (f.hideEasy && c.fork === "easy") return false;
    if (ngCommands.length) {
      const lower = c.commands.map((x) => x.toLowerCase());
      if (ngCommands.some((tokens) => tokens.every((t) => lower.includes(t)))) return false;
    }
    if (ngWords.some((w) => c.body.includes(w))) return false;
    if (c.score < minScore) return false;
    if (c.nicoruCount < nicoruMin) return false;
    if (f.premiumOnly && !c.isPremium) return false;
    return true;
  });
}
