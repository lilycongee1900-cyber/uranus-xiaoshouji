/**
 * 正在进行的那通电话。
 *
 * 一次只有一通（节点那边也是这么限的），所以这里就是一个模块级的单例，
 * 不是一张表。
 *
 * ── 为什么不进配置、也不落盘 ──
 *
 * 通话状态是**纯粹的瞬时值**：接通了多久、说到第几轮、正在等谁说话。进程一重启
 * 这通电话必然已经断了（浏览器是节点那边起的，跟着一起没），所以没有任何
 * 「恢复现场」的意义。
 *
 * 而且 `PUT /api/config` 会顺带重启所有 iMessage 桥接（见 reminderapi.js 开头
 * 那段注释），通话中每说一句就写一次配置的话，等于每句话都把线路重连一遍。
 *
 * 真正要留下来的东西 —— 每一轮的原文、挂断时那条通话记录 —— 走的是和线上
 * 聊天一模一样的路：`appendTurn` 进存档、`recordTurn` 进待总结。那两件事
 * 由 imessage.js 那边做，这个文件只管「现在这通电话是什么状态」。
 */

import { logInfo, logWarn } from "./logs.js";

const SCOPE = "通话";

/**
 * 一通电话最多能打多久。
 *
 * 不是为了限制用户，是**兜底**：节点那边要是崩了、或者网断了没能把「挂断」
 * 报回来，这个状态会一直挂着，之后所有通话都会被「一次只能一通」挡掉。
 * 两小时足够长到不会误伤正常通话。
 */
const MAX_CALL_MS = 2 * 60 * 60 * 1000;

/**
 * 多久没收到节点的动静就认为它掉线了。
 *
 * 节点在通话期间至少每几秒会来一次（取音频、报状态），一分钟没声音
 * 基本可以确定那头没了。
 */
const NODE_SILENT_MS = 60_000;

/** 当前这通电话。null = 现在没人在打。 */
let current = null;

/**
 * 开一通电话。
 *
 * @param {object} info
 * @param {string} info.roleId 哪个角色接的
 * @param {string} info.roleName
 * @param {string} info.sessionId 会话存档的 id —— 通话和短信共用同一条历史
 * @param {string} info.peer 对方的号码
 * @param {string} info.spaceId iMessage 那条会话的 id，挂断后要往里发通话记录
 * @param {string} info.link
 * @returns {object} 这通电话
 */
export function startCall(info) {
  if (current && !isStale(current)) {
    throw new Error("已经有一通电话在进行中了");
  }
  current = {
    id: `call-${Date.now().toString(36)}`,
    ...info,
    state: "connecting",
    startedAt: 0,
    createdAt: Date.now(),
    turns: 0,
    /** 节点最后一次来报到的时刻。用来发现节点掉线。 */
    nodeSeenAt: Date.now(),
    /** 通话期间攒的每一轮，挂断时一起交出去。 */
    log: [],
    /*
     * 接通之后要说的第一句话 —— 角色在答应接电话的**同一轮**里就写好了，
     * 写在 `[接受通话]` 后面（见 calltags.js:inviteNotice）。
     *
     * 为什么要存在这儿：接通要十几秒，这期间那一轮模型早就跑完了。存下来，
     * 节点一报 connected 就直接合成播出去，省掉一整轮模型（实测那一轮
     * 8–25 秒，对方接起来先听一片沉默）。
     *
     * 空 = 角色只写了个标记什么都没说，那就退回原来那条路（现场打一轮模型）。
     */
    greeting: String(info?.greeting ?? "").trim(),
    /*
     * 开场白**合成好的音频**，一个 Promise。
     *
     * 合成在入会之前就开跑（见 imessage.js:beginCall）—— 浏览器要开、对方
     * 还要在 iPhone 上点「允许」，这段死时间十几秒，足够把两三句话合成完。
     * 于是接通那一刻只剩「把字节发给节点」，一句都不用等。
     *
     * 存 Promise 而不是存结果：万一对方点得特别快，接通时合成还没完 ——
     * 那就 await 它，照样是对的，只是少赚了那几秒。
     */
    greetingAudio: null,
  };
  logInfo(SCOPE, `起一通电话：${info.roleName} ← ${info.peer}`);
  return current;
}

/** 现在这通电话。没有、或者已经过期的话返回 null。 */
export function getCall() {
  if (!current) return null;
  if (isStale(current)) {
    logWarn(SCOPE, `那通电话（${current.id}）太久没动静了，当它已经结束`);
    current = null;
    return null;
  }
  return current;
}

/** 现在是不是正在通话中（接通了的才算）。 */
export function inCall() {
  const c = getCall();
  return Boolean(c && c.state === "live");
}

/** 节点来过了。每次收到节点的请求都调一下，用来发现它掉线。 */
export function touchNode() {
  if (current) current.nodeSeenAt = Date.now();
}

/** 接通了。 */
export function markConnected() {
  const c = getCall();
  if (!c) return null;
  c.state = "live";
  c.startedAt = Date.now();
  logInfo(SCOPE, `接通了：${c.roleName} ← ${c.peer}`);
  return c;
}

/**
 * 开场白开始合成了 —— 把那个 Promise 存起来，接通时再来取。
 *
 * **Promise 上的失败在这里就吃掉**：没人 await 的 rejected promise 会让
 * Node 打一条 unhandledRejection（严格模式下直接退进程）。合成失败不该
 * 把整通电话连累掉，退回「接通后现场打一轮模型」就是了。
 */
export function primeGreeting(promise) {
  const c = getCall();
  if (!c) return;
  c.greetingAudio = Promise.resolve(promise).catch((e) => {
    logWarn(SCOPE, "开场白没提前合成出来，接通后会现场打一轮模型", e);
    return null;
  });
}

/**
 * 取出接通后要说的第一句话（文字 + 提前合成好的音频），**并且清掉**。
 *
 * 一次性的：拿过就没了。不这么做的话，节点因为什么原因重问一次 greeting
 * （重连、超时重试），角色会把同一句开场白再说一遍。
 *
 * @returns {{text: string, audio: Promise<object[]|null>|null}}
 *   `text` 为空串 = 没有开场白，调用方据此退回「现场打一轮模型」
 */
export function takeGreeting() {
  const c = getCall();
  if (!c?.greeting) return { text: "", audio: null };
  const out = { text: c.greeting, audio: c.greetingAudio };
  c.greeting = "";
  c.greetingAudio = null;
  return out;
}

/**
 * 记一轮对话。
 *
 * 只记在内存里。真正进存档和待总结是 imessage.js 那边做的事 —— 那条路和
 * 发短信完全一样，不该在这儿分叉。
 */
export function recordCallTurn(user, assistant) {
  const c = getCall();
  if (!c) return null;
  c.turns += 1;
  c.log.push({ at: new Date().toISOString(), user, assistant });
  return c;
}

/**
 * 挂断。
 *
 * @returns {object|null} 这通电话的最终状态，给调用方写通话记录用
 */
export function endCall(reason = "") {
  const c = current;
  current = null;
  /*
   * 已经结束过了就返回 null，调用方据此跳过收尾。
   *
   * 「挂断」这件事会从好几个方向同时到达：节点报 `ended`、控制台点挂断、
   * 节点的 SSE 断开。不挡的话会往聊天记录里写好几条「通话结束」。
   */
  if (!c) return null;
  c.state = "ended";
  c.endedAt = Date.now();
  c.reason = reason;
  c.durationMs = c.startedAt ? c.endedAt - c.startedAt : 0;
  logInfo(SCOPE, `挂了：${reason || "未知原因"}，${Math.round(c.durationMs / 1000)} 秒、${c.turns} 轮`);
  return c;
}

/** 已接通多久（毫秒）。没接通是 0。 */
export function elapsedMs() {
  const c = getCall();
  return c?.startedAt ? Date.now() - c.startedAt : 0;
}

/**
 * 给控制台看的那份状态。
 *
 * 不含链接 —— 那东西等于一把能加入通话的钥匙，没必要摆在接口里。
 */
export function callStatus() {
  const c = getCall();
  if (!c) return { active: false };
  return {
    active: true,
    id: c.id,
    state: c.state,
    roleId: c.roleId,
    roleName: c.roleName,
    peer: c.peer,
    turns: c.turns,
    elapsedMs: elapsedMs(),
    nodeSeenMsAgo: Date.now() - c.nodeSeenAt,
  };
}

/** 这通电话是不是已经没人管了（节点掉线，或者打了太久）。 */
function isStale(c) {
  if (Date.now() - c.createdAt > MAX_CALL_MS) return true;
  return Date.now() - c.nodeSeenAt > NODE_SILENT_MS;
}

/**
 * 把毫秒说成「3 分 12 秒」。
 *
 * 给模型的时间戳（`[Facetime已接通 3 分 12 秒]`）和挂断时那条通话记录都用它，
 * 两处必须是同一个写法。
 *
 * 脏数据要兜住：`Math.max(0, NaN)` 还是 `NaN`，不处理的话模型会收到
 * 「已接通 NaN 秒」。
 */
export function sayDuration(ms) {
  const n = Number(ms);
  const total = Number.isFinite(n) ? Math.max(0, Math.round(n / 1000)) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (!m) return `${s} 秒`;
  return `${m} 分 ${s} 秒`;
}

/** 测试用：把状态清干净。 */
export function resetForTest() {
  current = null;
}
