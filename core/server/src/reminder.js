/**
 * 定时提醒：角色写的 `[2026年10月10日08:00 | 提醒她带钥匙]`，和用户自己设的
 * 日程（课表、生日、纪念日）。
 *
 * 这个文件只管「数据 + 算时间」，不发消息：到点叫角色开口在 imessage.js
 * （reminderTick → runProactiveTurn），时间感知里的「XX的生日」在 env.js。
 * 所以这里**不 import env.js / imessage.js**，两边都能放心 import 它。
 *
 * 用户定的规矩（逐条确认过的）：
 *  - 角色设的默认一次性；默认提前 10 分钟先说一声、到点再说一次，提前量全局可改、
 *    单条可改，0 = 只在到点说；
 *  - 时间一律按**用户那边**算（异地时差）—— tz 由调用方从角色的「所在城市」解析好传进来；
 *  - 标记写错 / 时间已过：侧边栏标「已失效」，并给角色一条用户看不见的系统提示让它重设；
 *  - 关机期间错过的：过点 30 分钟以内补发，更早的标「已错过」；
 *  - 一次性的触发完留 7 天再清；
 *  - 用户自己的：一次 / 每天 / 每周（单双周 + 学期起止）/ 每月 / 每年（生日可农历）；
 *    生日和纪念日当天进时间感知的星期后面，纪念日还能开「满整百天」；
 *    课表那一类默认只提醒，设置里开了 scheduleInTime 才也进时间感知（带钟点、只当天）。
 *
 * 落盘在 data/reminders.json，不进 config.json（每触发一次就写一次）。
 */

import chineseDaysPkg from "chinese-days";

import { REMINDERS_PATH, readJson, writeJson } from "./datadir.js";
import { logWarn } from "./logs.js";

const SCOPE = "定时提醒";

/** chinese-days 的默认导出套了两层，挑有函数的那层（同 env.js）。 */
const CD =
  typeof chineseDaysPkg?.getSolarDateFromLunar === "function"
    ? chineseDaysPkg
    : chineseDaysPkg?.default;

/** 过点多久之内还补发。再晚就是「已错过」—— 早上八点的提醒中午才说没有意义。 */
export const GRACE_MS = 30 * 60_000;

/** 一次性的（触发完 / 错过 / 失效 / 取消）在列表里留几天。 */
const KEEP_MS = 7 * 24 * 3600_000;

/** 默认提前量（分钟）。 */
export const DEFAULT_LEAD = 10;

/** 单条提前量上限：一周。再长就不叫「提前说一声」了。 */
const MAX_LEAD = 7 * 24 * 60;

const MAX_ITEMS = 500;

/* ================= 时区 ================= */

const fmtCache = new Map();

export function systemTz() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** 时区名能不能用 —— 拼错的会让 Intl 抛异常。 */
export function safeTz(tz) {
  if (!tz) return systemTz();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return systemTz();
  }
}

function fmtFor(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 某个时刻在某时区的年月日时分秒 + 星期几（0 = 周日）。 */
export function localParts(ms, tz) {
  const p = Object.fromEntries(fmtFor(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const H = Number(p.hour) % 24;
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    H,
    M: Number(p.minute),
    S: Number(p.second),
    dow: DOW[p.weekday] ?? 0,
  };
}

/** 某时区的墙上时间 → 时间戳。偏移量交给 Intl 反推，DST 那一小时按 Intl 的说法算。 */
export function zonedMs(y, m, d, H, M, S, tz) {
  const want = Date.UTC(y, m - 1, d, H, M, S);
  let guess = want;
  for (let i = 0; i < 3; i += 1) {
    const p = localParts(guess, tz);
    const got = Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S);
    if (got === want) break;
    guess += want - got;
  }
  return guess;
}

const pad = (n) => String(n).padStart(2, "0");

export function ymdOf(p) {
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

function ymdSplit(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  return { y, m, d };
}

/** 日期加减天数（纯日历，不碰时区）。 */
function ymdAdd(ymd, n) {
  const { y, m, d } = ymdSplit(ymd);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function ymdDow(ymd) {
  const { y, m, d } = ymdSplit(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function ymdDiff(a, b) {
  const x = ymdSplit(a);
  const y = ymdSplit(b);
  return Math.round((Date.UTC(y.y, y.m - 1, y.d) - Date.UTC(x.y, x.m - 1, x.d)) / 86400_000);
}

function validYmd(y, m, d) {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? "")) && validYmd(...String(s).split("-").map(Number));
const isHms = (s) => /^\d{2}:\d{2}:\d{2}$/.test(String(s ?? ""));

const WEEK_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 「2026年10月10日08:00」，有秒才带秒 —— 和教给模型的写法一个样子。 */
export function fmtWhen(ms, tz) {
  const p = localParts(ms, tz);
  const sec = p.S ? `:${pad(p.S)}` : "";
  return `${p.y}年${p.m}月${p.d}日${pad(p.H)}:${pad(p.M)}${sec}`;
}

/** 「2026年10月7日 周三 14:03」：告诉模型现在几点，它才算得出「明天」是哪天。 */
export function fmtNow(ms, tz) {
  const p = localParts(ms, tz);
  return `${p.y}年${p.m}月${p.d}日 ${WEEK_CN[p.dow]} ${pad(p.H)}:${pad(p.M)}`;
}

/* ================= 农历 ================= */

const lunarCache = new Map();

/**
 * 农历 m 月 d 日落在公历 year 年的哪几天（通常一天，偶尔零天）。
 *
 * 农历年和公历年错开一截：腊月的生日落在下一个公历年的一二月，所以两个农历年都试。
 * 小月没有三十，三十就退到廿九过。闰月不算 —— 生日按正月份过。
 */
function lunarDatesIn(year, m, d) {
  const key = `${year}-${m}-${d}`;
  if (lunarCache.has(key)) return lunarCache.get(key);
  const out = [];
  for (const ly of [year - 1, year]) {
    for (const day of d === 30 ? [30, 29] : [d]) {
      try {
        const hit = CD?.getSolarDateFromLunar?.(`${ly}-${pad(m)}-${pad(day)}`)?.date;
        // chinese-days 碰到不存在的日子不一定抛错，转回去核对一遍
        if (hit && String(hit).startsWith(`${year}-`)) {
          const back = CD.getLunarDate(hit);
          if (back && back.lunarMon === m && !back.isLeap && (back.lunarDay === day)) {
            out.push(hit);
            break;
          }
        }
      } catch {
        /* 超出它的表就当这年没有 */
      }
    }
  }
  lunarCache.set(key, out);
  return out;
}

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 「十五」「廿七」「三十」「初一」→ 数字。认不出返回 NaN。 */
function cnNumber(s) {
  let t = String(s ?? "").trim().replace(/^初/, "");
  if (/^\d+$/.test(t)) return Number(t);
  t = t.replace(/^廿/, "二十").replace(/^卅/, "三十");
  if (t === "十") return 10;
  const m = /^([一二三四五六七八九两])?十([一二三四五六七八九])?$/.exec(t);
  if (m) return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0);
  if (t.length === 1 && t in CN_DIGIT) return CN_DIGIT[t];
  return NaN;
}

/** 农历的月日：「八月十五」「正月初一」「腊月廿三」「8月15日」。 */
function parseLunarMd(s) {
  const t = String(s ?? "").replace(/\s+/g, "");
  const num = /^(\d{1,2})[月\-/.](\d{1,2})[日号]?$/.exec(t);
  if (num) return { m: Number(num[1]), d: Number(num[2]) };
  const cn = /^(正|冬|腊|[一二三四五六七八九十]{1,2})月(.{1,3})$/.exec(t);
  if (!cn) return null;
  const m = cn[1] === "正" ? 1 : cn[1] === "冬" ? 11 : cn[1] === "腊" ? 12 : cnNumber(cn[1]);
  const d = cnNumber(cn[2].replace(/[日号]$/, ""));
  return m >= 1 && m <= 12 && d >= 1 && d <= 30 ? { m, d } : null;
}

const LUNAR_MONTH = ["", "正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"];
const LUNAR_DAY_TEN = ["初", "十", "廿", "三"];
function lunarLabel(m, d) {
  const day =
    d === 10 ? "初十" : d === 20 ? "二十" : d === 30 ? "三十" : `${LUNAR_DAY_TEN[Math.floor(d / 10)]}${"一二三四五六七八九"[(d % 10) - 1] ?? ""}`;
  return `农历${LUNAR_MONTH[m]}月${day}`;
}

/* ================= 规则 → 日期 ================= */

/**
 * 某一天是不是这条日程的日子。
 *
 * repeat.type：
 *  - once     date 那一天
 *  - daily    每天（有学期起止就只在区间里）
 *  - weekly   weekdays 里的那几天；parity 单周/双周按学期开始那周算第 1 周
 *  - monthly  每月 date 的那个「日」；没有 31 号的月份跳过
 *  - yearly   每年 date 的月日，lunar 时按 lunar 的农历月日；2 月 29 日平年按 28 日过
 *
 * 纪念日的第 0 年（就是起始那天本身）不算。
 */
export function matchesDate(item, ymd) {
  const r = item.repeat ?? {};
  if (r.termStart && ymd < r.termStart) return false;
  if (r.termEnd && ymd > r.termEnd) return false;
  switch (r.type) {
    case "once":
      return ymd === item.date;
    case "daily":
      return !item.date || ymd >= item.date;
    case "weekly": {
      if (!(r.weekdays ?? []).includes(ymdDow(ymd))) return false;
      if (r.parity === "odd" || r.parity === "even") {
        const base = r.termStart || item.date || ymd;
        const monday = (s) => ymdAdd(s, -((ymdDow(s) + 6) % 7));
        const week = Math.floor(ymdDiff(monday(base), monday(ymd)) / 7) + 1;
        if (week < 1) return false;
        if ((week % 2 === 1) !== (r.parity === "odd")) return false;
      }
      return true;
    }
    case "monthly": {
      const want = ymdSplit(item.date).d;
      return ymdSplit(ymd).d === want && ymd >= item.date;
    }
    case "yearly": {
      const { y, m, d } = ymdSplit(ymd);
      if (item.kind === "anniversary" && ymd <= item.date) return false;
      if (r.lunar && item.lunar) return lunarDatesIn(y, item.lunar.m, item.lunar.d).includes(ymd);
      const base = ymdSplit(item.date);
      if (base.m === 2 && base.d === 29 && !validYmd(y, 2, 29)) return m === 2 && d === 28;
      return m === base.m && d === base.d;
    }
    default:
      return false;
  }
}

const nextCache = new Map();

/**
 * 从 fromMs 起（含）的下一次到点时刻；没有了返回 null。
 *
 * 逐天往后找，最多两年多 —— 每年一次的日程也够得着。结果按「条目 + 起点 + 时区」缓存，
 * 心跳每 20 秒跑一遍，不用每次都重算。
 */
export function nextOccurrence(item, fromMs, tz) {
  if (!isHms(item.time)) return null;
  const [H, M, S] = item.time.split(":").map(Number);
  const at = (ymd) => {
    const { y, m, d } = ymdSplit(ymd);
    return zonedMs(y, m, d, H, M, S, tz);
  };
  if (item.repeat?.type === "once") {
    if (!isYmd(item.date)) return null;
    const t = at(item.date);
    return item.handledUntil && t < item.handledUntil ? null : t;
  }
  const key = `${item.id}|${item.updatedAt}|${fromMs}|${tz}`;
  if (nextCache.has(key)) return nextCache.get(key);
  let found = null;
  const start = ymdOf(localParts(fromMs, tz));
  for (let i = -1; i < 800; i += 1) {
    const ymd = ymdAdd(start, i);
    if (item.repeat?.termEnd && ymd > item.repeat.termEnd) break;
    if (!matchesDate(item, ymd)) continue;
    const t = at(ymd);
    if (t >= fromMs) {
      found = t;
      break;
    }
  }
  if (nextCache.size > 2000) nextCache.clear();
  nextCache.set(key, found);
  return found;
}

/**
 * 给人看的「下一次」：从现在（或者上一次响过之后）往后找。
 * 起点按分钟取整，免得每次调用都是新的缓存键。
 */
export function upcoming(item, tz, now = Date.now()) {
  if (item.repeat?.type === "once") return nextOccurrence(item, 0, tz);
  const from = Math.max(item.handledUntil ?? item.createdAt ?? 0, now - GRACE_MS);
  return nextOccurrence(item, Math.floor(from / 60_000) * 60_000, tz);
}

/** 这一条实际用的提前量（分钟）：自己设了用自己的，没设用全局的。 */
export function leadOf(item, settings) {
  const own = item.lead;
  if (Number.isFinite(own)) return own;
  return Number.isFinite(settings?.leadMinutes) ? settings.leadMinutes : DEFAULT_LEAD;
}

/**
 * 心跳到这一条时该干什么。
 *
 * @returns {{stage: "lead"|"due"|"missed"|null, occ: number|null, ended?: boolean}}
 *   lead = 提前说一声；due = 到点；missed = 过点超过 GRACE_MS，不发了；
 *   ended = 以后都不会再到点了（一次性的已经过了 / 学期结束了）
 */
export function dueAction(item, now, tz, settings) {
  const from = item.handledUntil ?? item.createdAt ?? 0;
  const occ = nextOccurrence(item, from, tz);
  if (occ === null) return { stage: null, occ: null, ended: true };
  if (now >= occ) return { stage: now - occ <= GRACE_MS ? "due" : "missed", occ };
  const lead = leadOf(item, settings);
  if (lead > 0 && now >= occ - lead * 60_000 && item.leadFor !== occ) return { stage: "lead", occ };
  return { stage: null, occ };
}

/* ================= 解析：时间 / 提前量 ================= */

function halfwidth(s) {
  return String(s ?? "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ":")
    .replace(/[｜]/g, "|")
    .replace(/　/g, " ");
}

/**
 * 「2026年10月10日08:00」「10月10日 8:00:30」「明天早上8点半」「20:00」→ 时间戳。
 *
 * 用户定的：没写年份 / 日期就按当前时间补。补出来的已经过了的话往后挪一档
 * （只写了几点 → 明天；只写了月日 → 明年）—— 深夜说「6 点叫我」意思一定是明早。
 * 写全了年月日还在过去，那就是真写错了，由调用方判「已失效」。
 *
 * @returns {{ok:true, at:number, date:string, time:string} | {ok:false, why:string}}
 */
export function parseWhen(raw, now, tz) {
  let s = halfwidth(raw).trim();
  const cur = localParts(now, tz);
  let y = cur.y;
  let m = cur.m;
  let d = cur.d;
  let hasYear = false;
  let hasDate = false;

  const full = /(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*[日号]?/.exec(s);
  const md = !full && /(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*[日号]?/.exec(s);
  const dOnly = !full && !md && /(\d{1,2})\s*[日号]/.exec(s);
  if (full) {
    [y, m, d] = [Number(full[1]), Number(full[2]), Number(full[3])];
    hasYear = hasDate = true;
    s = s.replace(full[0], " ");
  } else if (md) {
    [m, d] = [Number(md[1]), Number(md[2])];
    hasDate = true;
    s = s.replace(md[0], " ");
  } else if (dOnly) {
    d = Number(dOnly[1]);
    hasDate = true;
    s = s.replace(dOnly[0], " ");
  } else {
    const rel = /大后天|后天|明天|明早|明晚|今天|今晚|今早/.exec(s);
    if (rel) {
      const off = { 大后天: 3, 后天: 2, 明天: 1, 明早: 1, 明晚: 1 }[rel[0]] ?? 0;
      const t = ymdSplit(ymdAdd(ymdOf(cur), off));
      [y, m, d] = [t.y, t.m, t.d];
      hasDate = true;
    }
  }
  if (!validYmd(y, m, d)) return { ok: false, why: `日期「${raw}」不存在` };

  const tm = /(\d{1,2})\s*(?::|点|时)\s*(半|\d{1,2})?\s*分?(?:\s*:\s*(\d{1,2})\s*秒?)?/.exec(s);
  if (!tm) return { ok: false, why: "没写具体几点几分" };
  let H = Number(tm[1]);
  const M = tm[2] === "半" ? 30 : Number(tm[2] ?? 0);
  const S = Number(tm[3] ?? 0);
  if (/下午|晚上|今晚|明晚|傍晚|夜里/.test(s) && H < 12) H += 12;
  else if (/中午/.test(s) && H < 11) H += 12;
  else if (/凌晨/.test(s) && H === 12) H = 0;
  if (H > 23 || M > 59 || S > 59) return { ok: false, why: `时间「${raw}」不对` };

  let at = zonedMs(y, m, d, H, M, S, tz);
  if (!hasDate && at < now - 60_000) {
    const t = ymdSplit(ymdAdd(ymdOf(cur), 1));
    [y, m, d] = [t.y, t.m, t.d];
    at = zonedMs(y, m, d, H, M, S, tz);
  } else if (hasDate && !hasYear && at < now - 86400_000 && validYmd(y + 1, m, d)) {
    y += 1;
    at = zonedMs(y, m, d, H, M, S, tz);
  }
  return { ok: true, at, date: `${y}-${pad(m)}-${pad(d)}`, time: `${pad(H)}:${pad(M)}:${pad(S)}` };
}

/**
 * 「提前30分钟」「提前1小时」「提前半小时」「准时」→ 分钟数；不像提前量就返回 null。
 */
export function parseLead(raw) {
  const s = halfwidth(raw).replace(/\s+/g, "");
  if (!s) return null;
  if (/^(?:准时|不提前|到点(?:再说|提醒)?|提前0(?:分钟?)?)$/.test(s)) return 0;
  if (!/提前|^\d/.test(s)) return null;
  const body = s.replace(/^提前/, "");
  if (/^半(?:个)?小时$/.test(body)) return 30;
  const m = /^(\d+(?:\.\d+)?|[一二两三四五六七八九十]+)(?:个)?(分钟|分|小时|钟头|天)$/.exec(body);
  if (!m) return null;
  const n = /^\d/.test(m[1]) ? Number(m[1]) : cnNumber(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = m[2] === "天" ? 1440 : /小时|钟头/.test(m[2]) ? 60 : 1;
  return Math.max(0, Math.min(MAX_LEAD, Math.round(n * mult)));
}

/* ================= 角色输出里的标记 ================= */

/** `[取消提醒 | 带钥匙]` */
const CANCEL_RE = /[[［]\s*(?:取消提醒|删除提醒)\s*[|｜:：]\s*([^\]］\n]{1,200}?)\s*[\]］]/g;

/**
 * `[2026年10月10日08:00 | 提醒她带钥匙]` / `[… | … | 提前30分钟]`
 *
 * 第一段必须**像个时间**（数字或者今天明天这种词开头）—— 别的标记也有用竖线的
 * （`[瑞幸:生椰拿铁|大杯]`、`[poll:注释|选项1|选项2]`），它们都是字母或别的字开头，
 * 这一条正好把它们挡在外面。
 */
const SET_RE =
  /[[［]\s*((?:\d|今天|明天|后天|大后天|今晚|明早|明晚|今早|早上|上午|中午|下午|晚上|凌晨)[^[\]［］|｜\n]{0,40}?)\s*[|｜]\s*([^[\]［］|｜\n]{1,200}?)\s*(?:[|｜]\s*([^[\]［］|｜\n]{1,40}?)\s*)?[\]］]/g;

/**
 * 把提醒标记从一段输出里摘出来。
 *
 * @returns {{rest: string, tags: Array<{raw:string, cancel?:true, when?:string, title:string, leadText?:string}>}}
 */
export function splitReminderTags(text) {
  const tags = [];
  let rest = String(text ?? "").replace(CANCEL_RE, (raw, title) => {
    tags.push({ raw, cancel: true, title: title.trim() });
    return "";
  });
  rest = rest.replace(SET_RE, (raw, when, title, leadText) => {
    tags.push({ raw, when: when.trim(), title: title.trim(), leadText: leadText?.trim() ?? "" });
    return "";
  });
  if (!tags.length) return { rest: String(text ?? ""), tags };
  // 标记单独占一行时摘完会留空行，收一下
  rest = rest.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { rest, tags };
}

export function hasReminderTags(text) {
  CANCEL_RE.lastIndex = 0;
  SET_RE.lastIndex = 0;
  const hit = CANCEL_RE.test(String(text ?? "")) || SET_RE.test(String(text ?? ""));
  CANCEL_RE.lastIndex = 0;
  SET_RE.lastIndex = 0;
  return hit;
}

/* ================= 落盘 ================= */

function newId() {
  return `rm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

const KINDS = new Set(["once", "schedule", "birthday", "anniversary", "custom"]);
const REPEATS = new Set(["once", "daily", "weekly", "monthly", "yearly"]);
const STATUSES = new Set(["pending", "done", "missed", "invalid", "cancelled"]);

const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const numOrNull = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * 一条日程的规范形状。前端传来的、硬盘上读出来的都过一遍。
 *
 *  - source   "role"（角色写标记设的）/ "user"（用户在面板或指令里加的）
 *  - kind     once 一次性 / schedule 日程（课表这类）/ birthday 生日 / anniversary 纪念日
 *  - roleId   谁来提醒；空串 = 所有角色（生日纪念日进所有角色的时间感知，提醒由先轮到的那个发）
 *  - lead     提前几分钟；null = 跟全局
 *  - notify   到点要不要发消息（纪念日可以只进时间感知）
 *  - milestones 纪念日：满 100 / 200 / 300… 天也进时间感知
 */
export function normalizeItem(input) {
  const repeat = input?.repeat ?? {};
  const type = REPEATS.has(repeat.type) ? repeat.type : "once";
  const weekdays = [...new Set((Array.isArray(repeat.weekdays) ? repeat.weekdays : []).map(Number))]
    .filter((n) => n >= 0 && n <= 6)
    .sort();
  const lunar =
    input?.lunar && Number(input.lunar.m) >= 1 && Number(input.lunar.m) <= 12 && Number(input.lunar.d) >= 1 && Number(input.lunar.d) <= 30
      ? { m: Number(input.lunar.m), d: Number(input.lunar.d) }
      : null;
  const lead = numOrNull(input?.lead);
  return {
    id: str(input?.id, 60) || newId(),
    source: input?.source === "role" ? "role" : "user",
    kind: KINDS.has(input?.kind) ? input.kind : "once",
    roleId: str(input?.roleId, 80),
    title: str(input?.title) || "提醒",
    date: isYmd(input?.date) ? input.date : "",
    time: isHms(input?.time) ? input.time : "09:00:00",
    repeat: {
      type,
      weekdays,
      parity: repeat.parity === "odd" || repeat.parity === "even" ? repeat.parity : "all",
      termStart: isYmd(repeat.termStart) ? repeat.termStart : "",
      termEnd: isYmd(repeat.termEnd) ? repeat.termEnd : "",
      lunar: Boolean(repeat.lunar && lunar),
    },
    lunar,
    lead: lead === null ? null : Math.max(0, Math.min(MAX_LEAD, Math.round(lead))),
    notify: input?.notify === undefined ? true : Boolean(input.notify),
    milestones: Boolean(input?.milestones),
    // 自定义类型：用户自己起的类型名（「吃药」「考试」），和「当天进不进时间感知」
    label: str(input?.label, 20),
    showInTime: Boolean(input?.showInTime),
    status: STATUSES.has(input?.status) ? input.status : "pending",
    note: str(input?.note, 300),
    raw: str(input?.raw, 300),
    projectRefId: str(input?.projectRefId, 80),
    spaceId: str(input?.spaceId, 200),
    peer: str(input?.peer, 200),
    tz: str(input?.tz, 80),
    createdAt: Number(input?.createdAt) || Date.now(),
    updatedAt: Number(input?.updatedAt) || Date.now(),
    handledUntil: numOrNull(input?.handledUntil),
    leadFor: numOrNull(input?.leadFor),
    firedAt: numOrNull(input?.firedAt),
  };
}

function normalizeSettings(input) {
  const lead = Number(input?.leadMinutes);
  return {
    leadMinutes: Number.isFinite(lead) ? Math.max(0, Math.min(MAX_LEAD, Math.round(lead))) : DEFAULT_LEAD,
    /*
     * 课表那一类（kind === "schedule"）当天要不要也写进时间感知。
     *
     * 默认**关**，和原来的行为一致（那时候是写死的「课表只提醒，不进时间感知」）。
     * 一张课表一周能有十几节，全缀在星期后面每轮都要花 token，所以这是用户
     * 自己要开的东西，不是默认值。
     *
     * 一个总开关而不是每条一个：课表是整张表一起用的，一节一节地勾太碎。
     * 生日纪念日和自定义类型各有自己的路（见 itemNamesOn）。
     */
    scheduleInTime: Boolean(input?.scheduleInTime),
  };
}

/** 已经了结的一次性条目（触发完 / 错过 / 失效 / 取消）过了 7 天就清。 */
function prune(items, now = Date.now()) {
  return items.filter((it) => it.status === "pending" || now - (it.updatedAt || 0) < KEEP_MS);
}

export function loadReminders() {
  const raw = readJson(REMINDERS_PATH, null);
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    logWarn(SCOPE, "reminders.json 的形状不对，这次当空的用（文件没动）");
  }
  const items = Array.isArray(raw?.items) ? raw.items.map(normalizeItem) : [];
  const lastChat = raw?.lastChat && typeof raw.lastChat === "object" ? raw.lastChat : {};
  return { version: 1, settings: normalizeSettings(raw?.settings), items: prune(items), lastChat };
}

function saveReminders(state) {
  const items = prune(state.items);
  while (items.length > MAX_ITEMS) {
    const i = items.findIndex((it) => it.status !== "pending");
    items.splice(i >= 0 ? i : 0, 1);
  }
  try {
    writeJson(REMINDERS_PATH, { version: 1, settings: state.settings, items, lastChat: state.lastChat ?? {} });
  } catch (e) {
    logWarn(SCOPE, "reminders.json 没写进去", e);
  }
}

/** 读一份、改一下、写回去。改动函数返回 false 表示不用写。 */
export function updateReminders(fn) {
  const state = loadReminders();
  const out = fn(state);
  if (out !== false) saveReminders(state);
  return state;
}

export function addItem(input) {
  let made = null;
  updateReminders((s) => {
    made = normalizeItem({ ...input, id: "", createdAt: Date.now(), updatedAt: Date.now() });
    s.items.push(made);
  });
  return made;
}

/** 改一条。改了时间 / 规则就从现在起重新数，提前那一声也重新算。 */
export function patchItem(id, patch, { reschedule = false } = {}) {
  let hit = null;
  updateReminders((s) => {
    const i = s.items.findIndex((it) => it.id === id);
    if (i < 0) return false;
    const merged = { ...s.items[i], ...patch, id, updatedAt: Date.now() };
    if (reschedule) {
      merged.handledUntil = null;
      merged.leadFor = null;
      merged.createdAt = Date.now();
      if (merged.status !== "cancelled") merged.status = "pending";
    }
    s.items[i] = normalizeItem(merged);
    hit = s.items[i];
  });
  return hit;
}

export function removeItem(id) {
  let gone = false;
  updateReminders((s) => {
    const before = s.items.length;
    s.items = s.items.filter((it) => it.id !== id);
    gone = s.items.length !== before;
    return gone;
  });
  return gone;
}

export function setSettings(patch) {
  return updateReminders((s) => {
    s.settings = normalizeSettings({ ...s.settings, ...patch });
  }).settings;
}

/** 这个角色最近在哪个会话里说话 —— 用户自己的日程到点要往那儿发。没变就不写盘。 */
const lastChatSeen = new Map();
export function noteLastChat(roleId, chat) {
  if (!roleId || !chat?.spaceId) return;
  const key = `${chat.projectRefId}|${chat.spaceId}|${chat.peer}`;
  if (lastChatSeen.get(roleId) === key) return;
  lastChatSeen.set(roleId, key);
  updateReminders((s) => {
    const old = s.lastChat[roleId];
    if (old && `${old.projectRefId}|${old.spaceId}|${old.peer}` === key) return false;
    s.lastChat[roleId] = { projectRefId: chat.projectRefId ?? "", spaceId: chat.spaceId, peer: chat.peer ?? "" };
  });
}

/* ================= 给模型 / 给面板看的 ================= */

/** 条目是不是该由这个角色管。 */
export function belongsTo(item, roleId) {
  return !item.roleId || item.roleId === roleId;
}

/**
 * 提示词那条子条目的三个变量：现在几点、默认提前量、这个角色还没到点的提醒。
 * 提醒清单让模型能写 `[取消提醒 | …]`，也免得它把同一件事设两遍。
 */
export function reminderPromptState(roleId, tz, now = Date.now()) {
  const zone = safeTz(tz);
  const state = loadReminders();
  const pending = state.items
    .filter((it) => it.source === "role" && it.status === "pending" && it.roleId === roleId)
    .map((it) => ({ it, at: upcoming(it, zone, now) }))
    .filter((x) => x.at !== null)
    .sort((a, b) => a.at - b.at)
    .slice(0, 30);
  const list = pending.length
    ? "你已经设好、还没到点的提醒：\n" +
      pending
        .map(({ it, at }) => {
          const lead = leadOf(it, state.settings);
          return `- ${fmtWhen(at, zone)} | ${it.title}${lead ? `（提前${lead}分钟说一声）` : "（只在到点说）"}`;
        })
        .join("\n")
    : "";
  return { now: fmtNow(now, zone), lead: state.settings.leadMinutes, list };
}

const CN_ORD = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
function cnOrdinal(n) {
  if (n <= 10) return CN_ORD[n];
  if (n < 20) return `十${CN_ORD[n - 10]}`;
  if (n < 100) return `${CN_ORD[Math.floor(n / 10)]}十${CN_ORD[n % 10]}`;
  return String(n);
}

/** 生日 / 纪念日这一天叫什么。 */
export function specialName(item, ymd) {
  const name = item.title.replace(/纪念日$/, "").trim() || item.title;
  if (item.kind === "birthday") return /生日/.test(item.title) ? item.title : `${item.title}的生日`;
  const years = ymdSplit(ymd).y - ymdSplit(item.date).y;
  return `${name}第${cnOrdinal(years)}年纪念日`;
}

/**
 * 某一天（用户那边的日期）有哪些要进时间感知的日子：「宝宝的生日」
 * 「在一起第一年纪念日」「在一起满300天」。
 *
 * 四类进得来：
 *  - 生日、纪念日   —— 一直都进
 *  - 自定义类型     —— 那一条开了「当天进时间感知」（showInTime）
 *  - 课表           —— 设置里开了 scheduleInTime（总开关，见 normalizeSettings）
 *
 * 课表那一类**带上钟点**（「高数 08:00」）而别的不带：生日是一整天的事，
 * 而「今天有课」不说几点就没用 —— 角色得知道这会儿你是在上课还是已经下课了。
 *
 * @param {boolean} [ahead] 这一天是「提前感知」的那几天之一（明天、后天……）。
 *   课表**只报当天**：一张课表一周十几节，提前报会让每条消息的时间戳后面拖上
 *   「明天高数 08:00、明天线代 10:00、明天体育 14:00」—— 那是噪音，不是感知。
 *   生日纪念日反过来，提前知道才有用（能准备）。
 */
function itemNamesOn(items, ymd, roleId, settings = {}, ahead = false) {
  const out = [];
  for (const it of items) {
    if (it.status !== "pending" || !belongsTo(it, roleId)) continue;
    if (it.kind === "custom") {
      if (it.showInTime && matchesDate(it, ymd)) out.push(it.title);
      continue;
    }
    if (it.kind === "schedule") {
      if (!ahead && settings.scheduleInTime && matchesDate(it, ymd)) {
        out.push(`${it.title} ${clockOf(it)}`.trim());
      }
      continue;
    }
    if (it.kind !== "birthday" && it.kind !== "anniversary") continue;
    if (matchesDate(it, ymd)) out.push(specialName(it, ymd));
    if (it.kind === "anniversary" && it.milestones && it.date) {
      const days = ymdDiff(it.date, ymd);
      // 整年那天已经报过「第几年纪念日」了，满百天撞上同一天就不重复报
      if (days > 0 && days % 100 === 0 && !matchesDate(it, ymd)) {
        out.push(`${it.title.replace(/纪念日$/, "").trim() || it.title}满${days}天`);
      }
    }
  }
  return out;
}

/* ================= 节日 ================= */

/** 公历固定日子的节日。法定假日 env.js 那边另有一套（cnDayTag），这里管的是「过节」的感觉。 */
const SOLAR_FESTIVALS = {
  "01-01": "元旦",
  "02-14": "情人节",
  "03-08": "妇女节",
  "03-12": "植树节",
  "04-01": "愚人节",
  "05-01": "劳动节",
  "05-04": "青年节",
  "05-20": "520",
  "06-01": "儿童节",
  "09-10": "教师节",
  "10-01": "国庆节",
  "10-31": "万圣节",
  "11-11": "双十一",
  "12-24": "平安夜",
  "12-25": "圣诞节",
  "12-31": "跨年夜",
};

/** chinese-days 的农历节日里混着「封井」「祭井神」这种民俗条目，只留大家真过的。 */
const LUNAR_FESTIVALS = new Set(["春节", "元宵节", "龙抬头", "端午节", "七夕节", "中元节", "中秋节", "重阳节", "腊八节", "小年", "除夕"]);

/** 某月第 n 个星期几（dow 0 = 周日）是几号。 */
function nthWeekday(y, m, dow, n) {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
}

const festivalCache = new Map();

/** 某一天是什么节。 */
export function festivalsOn(ymd) {
  if (festivalCache.has(ymd)) return festivalCache.get(ymd);
  const { y, m, d } = ymdSplit(ymd);
  const out = [];
  const solar = SOLAR_FESTIVALS[`${pad(m)}-${pad(d)}`];
  if (solar) out.push(solar);
  if (m === 5 && d === nthWeekday(y, 5, 0, 2)) out.push("母亲节");
  if (m === 6 && d === nthWeekday(y, 6, 0, 3)) out.push("父亲节");
  if (m === 11 && d === nthWeekday(y, 11, 4, 4)) out.push("感恩节");
  try {
    for (const f of CD?.getLunarFestivals?.(ymd) ?? []) {
      for (const name of f.name ?? []) if (LUNAR_FESTIVALS.has(name) && !out.includes(name)) out.push(name);
    }
    // 清明是节气，不在农历节日表里；节气那张表给的是一段日子，只认第一天
    const term = (CD?.getSolarTermsInRange?.(ymd, ymd) ?? []).find((t) => t.name === "清明" && t.index === 1);
    if (term) out.push("清明节");
  } catch {
    /* 超出它的表就只有公历的那几个 */
  }
  if (festivalCache.size > 1000) festivalCache.clear();
  festivalCache.set(ymd, out);
  return out;
}

const AHEAD_WORD = ["", "明天", "后天"];

/**
 * 某一天（用户那边的日期）星期后面要缀的东西：
 *  - 当天的：「宝宝的生日」「在一起第一年纪念日」「万圣节」—— 当天每条消息的时间戳上都带，一整天都在；
 *  - 提前感知：「明天万圣节」「后天宝宝的生日」「3天后在一起第一年纪念日」（默认提前一天，设置里改）。
 *
 * 哪几类进得来见 itemNamesOn（生日、纪念日、开了开关的自定义类型和课表），再加节日。
 * 提前几天、报不报节日是角色时间感知里的设置（role.env.time.aheadDays / festivals），由 env.js 传进来。
 *
 * 课表那一类进不进是**提醒自己的**设置（settings.scheduleInTime），不是角色的 ——
 * 所以从这里读出来传下去，调用方不用管。
 *
 * @param {string[]} [skip] 当天已经由别处报过的名字（法定假日 env.js 已经写了「国庆节」），别重复
 */
export function specialDayNames(ymd, roleId, skip = [], { aheadDays = 1, festivals = true } = {}) {
  if (!isYmd(ymd)) return [];
  const state = loadReminders();
  const namesOn = (day, ahead = false) => [
    ...itemNamesOn(state.items, day, roleId, state.settings, ahead),
    ...(festivals ? festivalsOn(day) : []),
  ];
  const out = namesOn(ymd).filter((n) => !skip.includes(n));
  for (let k = 1; k <= aheadDays; k += 1) {
    const word = AHEAD_WORD[k] ?? `${k}天后`;
    // 「满300天」这种提前报没意思（明天满300天还行，但「后天在一起满300天」读着别扭也照报，规则简单）
    for (const n of namesOn(ymdAdd(ymd, k), true)) out.push(`${word}${k > 2 ? "是" : ""}${n}`);
  }
  return [...new Set(out)];
}

/** 「08:00:00」→「08:00」，有秒的保留秒。describeRule 和时间感知那截共用。 */
function clockOf(item) {
  const t = String(item?.time ?? "");
  return t.endsWith(":00") ? t.slice(0, 5) : t;
}

/** 规则的一句人话：「每周一三 08:00（单周，9/1–1/15）」 */
export function describeRule(item) {
  const r = item.repeat;
  const t = clockOf(item);
  const term = r.termStart || r.termEnd ? `，${r.termStart || "…"} ~ ${r.termEnd || "…"}` : "";
  switch (r.type) {
    case "once":
      return `${item.date} ${t}`;
    case "daily":
      return `每天 ${t}${term}`;
    case "weekly": {
      const days = r.weekdays.map((d) => "日一二三四五六"[d]).join("");
      const par = r.parity === "odd" ? "，单周" : r.parity === "even" ? "，双周" : "";
      return `每周${days} ${t}${par}${term}`;
    }
    case "monthly":
      return `每月${ymdSplit(item.date).d}号 ${t}`;
    case "yearly":
      return r.lunar && item.lunar
        ? `每年${lunarLabel(item.lunar.m, item.lunar.d)} ${t}`
        : `每年${ymdSplit(item.date).m}月${ymdSplit(item.date).d}日 ${t}`;
    default:
      return t;
  }
}

/* ================= 角色标记 → 条目 ================= */

/**
 * 角色这一轮写的提醒标记落成条目。
 *
 * @returns {{set: object[], cancelled: object[], failed: Array<{raw:string, why:string}>}}
 *   failed 由调用方拿去给角色递系统提示（用户看不见），并且已经作为「已失效」存进列表了
 */
export function applyRoleTags(tags, { roleId, tz, now = Date.now(), chat = {} }) {
  const zone = safeTz(tz);
  const out = { set: [], cancelled: [], failed: [] };
  if (!tags.length) return out;
  updateReminders((s) => {
    for (const tag of tags) {
      if (tag.cancel) {
        const want = tag.title.replace(/\s+/g, "");
        const hits = s.items.filter((it) => {
          if (it.source !== "role" || it.roleId !== roleId || it.status !== "pending") return false;
          const have = it.title.replace(/\s+/g, "");
          return have === want || have.includes(want) || want.includes(have);
        });
        if (!hits.length) {
          out.failed.push({ raw: tag.raw, why: "清单里没有这条还没到点的提醒，取消不了", cancel: true });
          continue;
        }
        for (const it of hits) {
          it.status = "cancelled";
          it.updatedAt = now;
          out.cancelled.push(it);
        }
        continue;
      }

      let lead = null;
      let title = tag.title;
      if (tag.leadText) {
        lead = parseLead(tag.leadText);
        // 第三段不像提前量：多半是事件里本来就有个竖线，接回去
        if (lead === null) title = `${title} ${tag.leadText}`.trim();
      }
      const base = {
        source: "role",
        kind: "once",
        roleId,
        title,
        repeat: { type: "once" },
        lead,
        raw: tag.raw,
        tz: zone,
        ...chat,
        createdAt: now,
        updatedAt: now,
      };
      const when = parseWhen(tag.when, now, zone);
      let why = when.ok ? "" : when.why;
      if (when.ok && when.at < now - 60_000) why = `${fmtWhen(when.at, zone)} 已经过了`;
      if (when.ok && when.at > now + 2 * 366 * 86400_000) why = "定得太远了（超过两年）";
      if (why) {
        s.items.push(normalizeItem({ ...base, status: "invalid", note: why }));
        out.failed.push({ raw: tag.raw, why });
        continue;
      }
      // 同一个时间同一件事已经有了：别设两遍（模型重说一遍确认时常会把标记再写一次）
      const dup = s.items.find(
        (it) =>
          it.source === "role" &&
          it.roleId === roleId &&
          it.status === "pending" &&
          it.date === when.date &&
          it.time === when.time &&
          it.title === title
      );
      if (dup) {
        if (lead !== null) dup.lead = lead;
        continue;
      }
      const item = normalizeItem({ ...base, date: when.date, time: when.time });
      s.items.push(item);
      out.set.push(item);
    }
  });
  return out;
}

/* ================= 快捷指令 ================= */

const WEEK_CHAR = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 7: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };

/** 拆「时间部分 + 事件」：`明天 8:00 带钥匙` / `明天8点半带钥匙` / `10月10日08:00 | 带钥匙`。 */
function splitWhenWhat(s) {
  if (s.includes("|")) {
    const [when, ...rest] = s.split("|");
    return { when: when.trim(), what: rest.join("|").trim() };
  }
  const m = /^(.*?\d{1,2}\s*(?::\s*\d{1,2}(?:\s*:\s*\d{1,2})?|点(?:\s*半|\s*\d{1,2}\s*分?)?|时))\s*(.+)$/.exec(s);
  return m ? { when: m[1].trim(), what: m[2].trim() } : null;
}

/** 事件末尾的「提前30分钟」/「准时」摘出来。 */
function takeTrailingLead(what) {
  const m = /\s*[|，,]?\s*(提前\s*(?:半(?:个)?小时|[\d一二两三四五六七八九十.]+\s*(?:个)?(?:分钟|分|小时|钟头|天))|准时|不提前)\s*$/.exec(what);
  if (!m) return { what, lead: null };
  return { what: what.slice(0, m.index).trim(), lead: parseLead(m[1]) };
}

/**
 * `/提醒 …` 的参数 → 一条用户日程（还没存）。
 *
 *   /提醒 明天8:00 带钥匙
 *   /提醒 10月10日 09:00 交作业 提前1小时
 *   /提醒 每天 7:30 吃药
 *   /提醒 每周一三 8:00 高数
 *   /提醒 每月15号 9:00 交房租
 *   /提醒 每年 3月8日 9:00 妇女节
 */
export function parseRemindCommand(args, { now = Date.now(), tz } = {}) {
  const zone = safeTz(tz);
  let s = halfwidth(args).trim();
  if (!s) return { ok: false, why: "写法：/提醒 明天8:00 带钥匙（也可以 每天 / 每周一三 / 每月15号 / 每年 开头）" };
  const repeat = { type: "once" };
  let date = "";
  const cur = ymdOf(localParts(now, zone));

  let rp;
  if ((rp = /^每天\s*/.exec(s))) {
    repeat.type = "daily";
    date = cur;
  } else if ((rp = /^每(?:周|星期|礼拜)\s*([一二三四五六日天1-7、,，和]+)\s*/.exec(s))) {
    repeat.type = "weekly";
    repeat.weekdays = [...rp[1].replace(/[、,，和]/g, "")].map((c) => WEEK_CHAR[c]).filter((n) => n !== undefined);
    date = cur;
  } else if ((rp = /^每月\s*(\d{1,2})\s*[日号]\s*/.exec(s))) {
    repeat.type = "monthly";
    const n = Number(rp[1]);
    if (n < 1 || n > 31) return { ok: false, why: "每月几号写错了" };
    // 拿一个有 31 号的月份当起点，只用它的「日」
    const p = ymdSplit(cur);
    const base = validYmd(p.y, p.m, n) ? `${p.y}-${pad(p.m)}-${pad(n)}` : `${p.y}-01-${pad(n)}`;
    date = base;
  } else if ((rp = /^每年\s*/.exec(s))) {
    repeat.type = "yearly";
  }
  if (rp) s = s.slice(rp[0].length);

  const parts = splitWhenWhat(s);
  if (!parts || !parts.what) return { ok: false, why: "没认出几点和要提醒什么。写法：/提醒 明天8:00 带钥匙" };
  const { what, lead } = takeTrailingLead(parts.what);
  if (!what) return { ok: false, why: "要提醒什么没写" };

  const when = parseWhen(parts.when, now, zone);
  if (!when.ok) return { ok: false, why: when.why };
  if (repeat.type === "once" && when.at < now - 60_000) return { ok: false, why: `${fmtWhen(when.at, zone)} 已经过了` };
  if (repeat.type === "yearly") date = when.date;
  if (repeat.type === "weekly" && !repeat.weekdays.length) return { ok: false, why: "每周几没写对，例如 每周一三" };

  return {
    ok: true,
    item: {
      source: "user",
      kind: repeat.type === "once" ? "once" : "schedule",
      title: what,
      date: repeat.type === "once" ? when.date : date || when.date,
      time: when.time,
      repeat,
      lead,
      notify: true,
      tz: zone,
    },
  };
}

/** 日期串（可带「农历」）：`2025年10月10日` `2025-10-10` `10月10日` `农历八月十五` `农历8月15`。 */
function parseDay(raw, { needYear } = {}) {
  const s = halfwidth(raw).replace(/\s+/g, "");
  if (/^农历/.test(s)) {
    const body = s.replace(/^农历/, "").replace(/^\d{4}[年\-/.]/, "");
    const md = parseLunarMd(body);
    if (!md) return null;
    return { lunar: md };
  }
  const full = /^(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})[日号]?$/.exec(s);
  if (full && validYmd(+full[1], +full[2], +full[3])) return { date: `${full[1]}-${pad(+full[2])}-${pad(+full[3])}` };
  if (needYear) return null;
  const md = /^(\d{1,2})[月\-/.](\d{1,2})[日号]?$/.exec(s);
  if (md && validYmd(2000, +md[1], +md[2])) return { date: `2000-${pad(+md[1])}-${pad(+md[2])}` };
  return null;
}

/** 名字和日期谁在前都行：`在一起 2025年10月10日` / `2025年10月10日 在一起`。 */
function splitNameDay(args) {
  const s = halfwidth(args).trim().replace(/\s*\|\s*/g, " ");
  const DAY = /((?:农历\s*)?(?:\d{4}\s*[年\-/.]\s*)?(?:\d{1,2}\s*[月\-/.]\s*\d{1,2}\s*[日号]?|(?:正|冬|腊|[一二三四五六七八九十]{1,2})月\s*[初十廿卅一二三四五六七八九]{1,3}[日号]?))/;
  const m = DAY.exec(s);
  if (!m) return null;
  const name = (s.slice(0, m.index) + " " + s.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
  return { name, day: m[1] };
}

/**
 * `/增加纪念日 在一起 2025年10月10日`：要写全年份，不然算不出第几年。
 * `/增加生日 宝宝 10月10日`、`/增加生日 宝宝 农历八月十五`。
 */
export function parseDayCommand(kind, args) {
  const usage =
    kind === "anniversary"
      ? "写法：/增加纪念日 在一起 2025年10月10日"
      : "写法：/增加生日 宝宝 10月10日（农历就写 农历八月十五）";
  const parts = splitNameDay(args);
  if (!parts || !parts.name) return { ok: false, why: usage };
  const day = parseDay(parts.day, { needYear: kind === "anniversary" });
  if (!day) return { ok: false, why: kind === "anniversary" ? `日期要写全年份。${usage}` : usage };
  if (kind === "anniversary" && day.lunar) return { ok: false, why: "纪念日按公历算，不用写农历" };
  return {
    ok: true,
    item: {
      source: "user",
      kind,
      title: parts.name,
      date: day.date ?? "",
      lunar: day.lunar ?? null,
      time: "09:00:00",
      repeat: { type: "yearly", lunar: Boolean(day.lunar) },
      lead: 0,
      notify: true,
      milestones: kind === "anniversary",
    },
  };
}

/** `/提醒列表` 的那张表：还会响的都列上，编号给 `/删除提醒 2` 用。 */
export function listForCommand(roleId, tz, now = Date.now()) {
  const zone = safeTz(tz);
  const rows = loadReminders()
    .items.filter((it) => it.status === "pending" && belongsTo(it, roleId))
    .map((it) => ({ it, at: it.notify ? upcoming(it, zone, now) : null }))
    .filter((x) => x.at !== null || !x.it.notify)
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  return rows.map((x) => x.it);
}

export function describeForList(item, tz) {
  const who = item.source === "role" ? "角色设的" : { birthday: "生日", anniversary: "纪念日", custom: item.label || "自定义" }[item.kind] ?? "日程";
  const at = item.repeat.type === "once" ? fmtWhen(nextOccurrence(item, 0, safeTz(tz)) ?? 0, safeTz(tz)) : describeRule(item);
  return `${at}  ${item.title}（${who}）`;
}
