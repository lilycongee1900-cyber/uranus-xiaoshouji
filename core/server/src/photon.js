/**
 * Photon Spectrum 管理 API 封装。
 *
 * 目前只用到「创建共享用户」这一个接口：把用户自己的手机号登记到项目里，
 * Photon 会从共享号码池分配一条 iMessage 线路，返回 assignedPhoneNumber。
 *
 * 走这条 API 的好处是不需要网页端那套「先给账号绑手机 → 收短信验证码」的流程，
 * 部分地区/运营商收不到 Photon 的验证码，网页流程会卡在 account_phone_missing。
 */

import { logDebug, logError, logInfo, logWarn } from "./logs.js";
import { whyNetwork } from "./net.js";

const PHOTON_BASE = "https://spectrum.photon.codes";

/**
 * 日志里**绝不能出现** Basic auth 那串 base64 —— 它就是
 * `projectId:projectSecret` 换了个编码，等于明文凭据。
 *
 * projectId 本身不是秘密（它在 URL 里），但也只打前 8 位就够定位是哪个项目了。
 */
const shortId = (id) => String(id ?? "").slice(0, 8);

/** E.164：加号 + 国家码起始的 7~15 位数字。 */
export const PHONE_RE = /^\+[1-9]\d{6,14}$/;

/**
 * 把用户输入的手机号规范成 E.164。
 * 允许输入里带空格、横线、括号，缺 + 号时补上。
 */
export function normalizePhone(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

/**
 * 拉这个项目下所有已登记的共享用户。
 *
 * 分出这一层是因为有两个调用方，而它们**对失败的反应完全相反**：
 * `findSharedUser` 查不到就去创建（失败当作「没登记过」继续走），而
 * `checkLineOwnership` 必须分清「确实没有这条登记」和「这次没查成」——
 * 后者绝不能报成「你的线路失效了」。所以这里不吞错，原样把结果交出去。
 *
 * @returns {Promise<{ok: boolean, status: number, users: object[], error: string}>}
 *          `ok` 为 false 时 `users` 是空数组，`error` 是能直接写进日志的一句话
 */
async function fetchSharedUsers({ projectId, projectSecret }) {
  const auth = Buffer.from(`${projectId}:${projectSecret}`).toString("base64");
  let res;
  try {
    res = await fetch(`${PHOTON_BASE}/projects/${projectId}/users/`, {
      headers: { Authorization: `Basic ${auth}` },
    });
  } catch (e) {
    return { ok: false, status: 0, users: [], error: `连不上 Photon：${whyNetwork(e)}` };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, users: [], error: `HTTP ${res.status}` };
  }
  const body = await res.json().catch(() => null);
  // 实测响应形如 { succeed, data: { users: [...], total } }
  const users = body?.data?.users ?? body?.data ?? [];
  if (!Array.isArray(users)) {
    return { ok: false, status: res.status, users: [], error: "返回里没有用户列表，接口可能有变动" };
  }
  return { ok: true, status: res.status, users, error: "" };
}

/**
 * 查项目里已登记的用户，找出手机号匹配的那条。
 * 用来避免重复登记——每次创建都会占用项目的共享用户配额。
 *
 * @returns {Promise<{assignedPhoneNumber: string, userId: string} | null>}
 *          查不到、或接口失败时返回 null（调用方继续走创建流程）
 */
export async function findSharedUser({ projectId, projectSecret, phoneNumber }) {
  if (!projectId || !projectSecret || !PHONE_RE.test(phoneNumber)) return null;

  logDebug("Photon", `查已登记的用户（项目 ${shortId(projectId)}…）`);
  const got = await fetchSharedUsers({ projectId, projectSecret });
  /*
   * 下面这几个 return null 以前是**完全静默**的，于是「凭据错了」「网络
   * 不通」和「这个号确实没登记过」三件完全不同的事在调用方看来一模一样，
   * 排查时无从下手。返回值不改（调用方靠 null 走创建流程），但话要说出来。
   */
  if (!got.ok) {
    logWarn("Photon", `查已登记的用户失败（${got.error}），当作没查过继续`);
    return null;
  }

  const hit = got.users.find((u) => u?.phoneNumber === phoneNumber && u?.assignedPhoneNumber);
  logDebug(
    "Photon",
    `项目里有 ${got.users.length} 个用户，${hit ? `这个号已登记，线路 ${hit.assignedPhoneNumber}` : "没有这个号，走创建流程"}`
  );
  return hit ? { assignedPhoneNumber: hit.assignedPhoneNumber, userId: hit.id ?? "" } : null;
}

/**
 * 连上之后核对一次：配置里这个线路号码，**现在**还归不归这个项目。
 *
 * 为什么非要有这么一次 —— `linePhone` 有两条写入路径，两条都是「写一次就
 * 再也没人管了」：enroll 成功那一刻写盘（index.js 的 /photon/enroll），
 * 或者用户在「手动填线路号码」里自己打一个（client 的 ManualLineBox，
 * 那条路连 `myPhone` 都不经手）。而桥接从头到尾就拿着这个字段当真。
 *
 * 于是「线路被 Photon 回收/重分配」「登记失效」「手打错一位」这三件事的
 * 表现一模一样：对方发过去石沉大海，我们这边**连一条日志都没有**（消息
 * 压根没进程序），桥接还一直显示「已连接，等消息中」，重启一百次也一样 ——
 * 因为坏的是落盘的那个号，不是进程状态。
 *
 * 原来唯一那道预检（delivery.js:checkLineRegistered）在共享线路上等于没有：
 * 它拿线路号去 `addresses.isIMessageAvailable`，而共享线路对这个调用**永远**
 * 回「Target is a Photon-managed shared line, not a valid recipient」，于是
 * 只落一条 debug 就跳过了。这个函数走的是管理 REST API，不受那条限制。
 *
 * 查不成一律只记 debug，**绝不报警** —— 开机时网络还没通就喊一句
 * 「你的线路失效了」，比不喊更糟。只有真问出了结果、而且结果是坏的，才报。
 *
 * @param {object} opts
 * @param {string} opts.label 日志 scope
 * @param {string} opts.myPhone 配置里登记用的那个号（可能是空的，手填线路那条路不写它）
 * @param {string} opts.linePhone 配置里存的线路号码
 * @returns {Promise<object[] | null>} 查成了就给登记用户表（调用方拿去核对聊天对象，
 *          见 imessage.js:checkPeersRegistered），没查成给 null
 */
export async function checkLineOwnership({ projectId, projectSecret, label, myPhone, linePhone }) {
  if (!projectId || !projectSecret || !linePhone) return null;

  let got;
  try {
    got = await fetchSharedUsers({ projectId, projectSecret });
  } catch (e) {
    logDebug(label, `核对线路归属时出错，跳过这次预检：${String(e?.message ?? e)}`);
    return null;
  }

  if (!got.ok) {
    // 凭据被拒是硬结论，和「网络不通」不一样 —— 这个要说
    if (got.status === 401 || got.status === 403) {
      logError(
        label,
        `Photon 凭据被拒绝（${got.status}），这条线路收不到任何消息`,
        `Project ID / Project Secret 对不上了，多半是 Secret 被轮换过。\n` +
          `去 Photon 后台重新取一份，填回「iMessage → 项目」里保存。`
      );
      return null;
    }
    logDebug(label, `没能核对线路 ${linePhone} 的归属（${got.error}），跳过这次预检`);
    return null;
  }

  const owner = got.users.find((u) => u?.assignedPhoneNumber === linePhone);
  if (owner) {
    logInfo(
      label,
      `预检：线路 ${linePhone} 归这个项目，登记号 ${owner.phoneNumber}` +
        `${myPhone && myPhone !== owner.phoneNumber ? `（注意：配置里 myPhone 填的是 ${myPhone}，对不上）` : ""}`
    );
    return got.users;
  }

  /*
   * 线路不在这个项目名下。到这儿结论已经是硬的（接口查成了、列表拿到了），
   * 所以这条必须喊出来 —— 它就是「发过去没反应、控制台一行都没有」的原因。
   *
   * 话要分两种说，因为改法不同：这个号自己有另一条线路（那是号码换了，
   * 照着新的发就行），还是整个项目都没有它（那得重新登记）。
   */
  const mine = myPhone ? got.users.find((u) => u?.phoneNumber === myPhone) : null;
  const all = got.users
    .map((u) => `${u?.phoneNumber ?? "?"} → ${u?.assignedPhoneNumber || "（没分配线路）"}`)
    .join("\n  ") || "（这个项目下一个登记用户都没有）";

  logError(
    label,
    `线路号码 ${linePhone} 不归这个项目 —— 发到这个号上的消息我们这边收不到`,
    (mine?.assignedPhoneNumber
      ? `${myPhone} 现在分到的是 ${mine.assignedPhoneNumber}，不是配置里存的 ${linePhone}。\n` +
        `线路被 Photon 换过了。去「iMessage → 项目」里点一次「开通线路」把号码刷新，` +
        `然后改用 ${mine.assignedPhoneNumber} 发消息。\n`
      : `这个项目下现在登记着：\n  ${all}\n` +
        `配置里那个 ${linePhone} 不在其中 —— 要么登记失效了，要么是手动填线路时打错了。\n` +
        `去「iMessage → 项目」里填上自己的手机号、点「开通线路」重新登记。\n`) +
      `（在此之前桥接会一直显示「已连接」，但一条消息都收不到：` +
      `没登记的号码发给共享线路，Photon 在它那头就丢了。）`
  );
  return got.users;
}

/**
 * 在项目里登记一个共享用户，拿到分配的 iMessage 线路号码。
 *
 * @param {{projectId: string, projectSecret: string, phoneNumber: string}} args
 * @returns {Promise<{assignedPhoneNumber: string, userId: string, raw: object}>}
 * @throws {Error} 带 .status（HTTP 状态码，网络层失败时为 0）
 */
export async function enrollSharedUser({ projectId, projectSecret, phoneNumber }) {
  if (!projectId || !projectSecret) {
    throw fail("缺少 Project ID 或 Project Secret", 0);
  }
  if (!PHONE_RE.test(phoneNumber)) {
    throw fail("手机号格式不对，需要 E.164 格式（例如 +8613800138000）", 0);
  }

  const auth = Buffer.from(`${projectId}:${projectSecret}`).toString("base64");
  let res;
  try {
    logDebug("Photon", `登记共享用户 ${phoneNumber}（项目 ${shortId(projectId)}…）`);
    res = await fetch(`${PHOTON_BASE}/projects/${projectId}/users/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ type: "shared", phoneNumber }),
    });
    logDebug("Photon", `登记共享用户：HTTP ${res.status}`);
  } catch (e) {
    /*
     * 这句话会出现在「开通线路」那个按钮下面，是用户唯一能看到的原因。
     * 原来是 `e.message`，也就是一句 `fetch failed` —— Photon 实测直连就通，
     * 所以真正的原因多半是「这台机器出不了网」，whyNetwork 会把错误码挖出来。
     */
    throw fail(`连不上 Photon：${whyNetwork(e)}`, 0);
  }

  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON，下面按状态码报错 */
  }

  if (!res.ok) {
    const detail =
      body?.message ??
      body?.error ??
      (text ? text.slice(0, 200) : `HTTP ${res.status}`);
    throw fail(describe(res.status, detail), res.status);
  }

  const data = body?.data ?? body;
  const assigned = data?.assignedPhoneNumber;
  if (!assigned) {
    throw fail("Photon 返回里没有 assignedPhoneNumber，可能接口有变动", res.status);
  }

  logDebug("Photon", `登记成功，分到线路 ${assigned}`);
  return {
    assignedPhoneNumber: assigned,
    userId: data?.id ?? "",
    raw: data,
  };
}

function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** 把常见状态码翻译成能照着做的中文提示。 */
function describe(status, detail) {
  if (status === 401 || status === 403) {
    return `凭据被拒绝（${status}）：检查 Project ID / Project Secret 是否配对、有没有多余空格。`;
  }
  if (status === 404) {
    return `找不到这个项目（404）：Project ID 可能写错了。`;
  }
  if (status === 409) {
    return `这个手机号已经登记过了（409）。如果之前登记成功，直接用当时拿到的线路号码即可。`;
  }
  if (status === 422 || status === 400) {
    return `请求被拒绝（${status}）：${detail}`;
  }
  if (status === 429) {
    return `请求太频繁（429），稍等再试。`;
  }
  return `Photon 返回 ${status}：${detail}`;
}
