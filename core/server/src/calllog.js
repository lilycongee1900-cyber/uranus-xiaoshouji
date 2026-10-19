/**
 * 通话记录 —— 手机上那个「最近通话」列表。
 *
 * ── 只存元信息，不存说了什么 ──
 *
 * 说的话早就跟着 `appendTurn` 进了会话存档（通话和短信共用同一条历史，
 * 这是用户钉死的）。在这儿再存一份正文，就是同一件事存两份、然后各自漂移
 * —— 用户在聊天记录里改一句，通话记录里那份还是旧的。
 *
 * 所以这里只回答「什么时候跟谁通过话、多久、几轮、怎么结束的」。想看说了
 * 什么，去聊天记录里翻那一段（挂断时 finishCall 会在那儿留一条
 * 「通话结束 · 3 分 12 秒 · 8 轮对话」当锚点）。
 *
 * ── 为什么要落盘 ──
 *
 * `callsession.js` 那份是**瞬时**状态，进程一重启就没了（那是刻意的）。
 * 但「上周三跟它通过一次电话」这种事重启之后还得在 —— 控制台上要能翻。
 */

import { CALL_LOG_PATH, readJson, writeJson } from "./datadir.js";
import { logDebug, logWarn } from "./logs.js";

const SCOPE = "通话";

/**
 * 留多少条。
 *
 * 一通电话一条、每条两百来字节，一百条也就二十来 KB —— 对「翻翻最近打过
 * 谁」这个用途足够，又不会让文件无限长。超了丢最老的。
 */
const MAX = 100;

/** @returns {object[]} 最近的在前 */
export function readCallLog() {
  const raw = readJson(CALL_LOG_PATH, []);
  return Array.isArray(raw) ? raw : [];
}

/**
 * 记一通打完的电话。
 *
 * @param {object} call `callsession.js:endCall` 交出来的那份
 * @returns {object|null} 记下的那条
 */
export function noteCall(call) {
  if (!call) return null;

  /*
   * 没接通的不记（state 从来没到过 live，或者压根没算出时长）。
   *
   * 「对方没接 / 节点没起来」属于**没打成**，不是一次通话。手机上也不会
   * 把一次拨号失败记成通话记录里的一条。真要排查那种，日志里有。
   */
  if (!call.startedAt) {
    logDebug(SCOPE, "这通没接通，不记进通话记录");
    return null;
  }

  const entry = {
    id: call.id,
    roleId: call.roleId,
    roleName: call.roleName,
    peer: call.peer,
    sessionId: call.sessionId,
    startedAt: new Date(call.startedAt).toISOString(),
    endedAt: new Date(call.endedAt || Date.now()).toISOString(),
    durationMs: call.durationMs ?? 0,
    turns: call.turns ?? 0,
    // 「对方挂断」「角色挂断」「控制台挂断」「节点断开了」…… 原样留着
    reason: String(call.reason ?? ""),
  };

  try {
    const list = [entry, ...readCallLog()].slice(0, MAX);
    writeJson(CALL_LOG_PATH, list);
  } catch (e) {
    // 记不上不该连累挂断收尾 —— 这只是一份给人看的流水
    logWarn(SCOPE, "通话记录没写进去", e);
    return null;
  }
  return entry;
}

/** 清空。控制台上那个「清空记录」按钮用。 */
export function clearCallLog() {
  try {
    writeJson(CALL_LOG_PATH, []);
    return true;
  } catch (e) {
    logWarn(SCOPE, "通话记录没清掉", e);
    return false;
  }
}
