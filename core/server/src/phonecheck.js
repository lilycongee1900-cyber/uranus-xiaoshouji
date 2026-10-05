/**
 * 查手机：翻一翻**角色自己**手机里的东西 —— 通讯录、聊天、通话、购物、外卖、
 * 浏览记录、钱包、今天的活动轨迹、收藏夹，加上用户自己定义的 App。
 *
 * 玩法参考 SullyOS（手抓糯米机，NMJ 作）的「查手机」App，代码和提示词是按
 * Uranus 的结构重写的。和 Uranus 原有的「查岗」不是一回事：查岗看的是**用户**
 * 的真屏幕（spy.js），这里是让模型按人设**虚构**角色自己的手机内容。
 *
 * ── 生成 ──
 *
 *  - 单个 App 刷新：只生成那一个 App 的几条
 *  - 一键生成：一次请求生成好几个 App（哪几个由用户在设置里勾，config.phone.batchApps）
 *    —— 人设、世界书、聊天记录只发一遍，比一个个刷省得多
 *  - 输入：角色人设、用户人设、勾选的世界书（这个角色关联的那几本）、最近几条聊天、
 *    通讯录里已有的人（让前后对得上）、现在几点
 *  - 模型：默认用这个角色的聊天模型（失败退副 API），也可以在设置里单独选一个
 *
 * ── 去哪儿 ──
 *
 *  - 存在 data/phone/<角色 id>.json（不进 config，理由同小剧场）
 *  - 角色开了「同步到私聊」：之后的聊天里每轮注入一小段摘要（字数和时效都有上限，
 *    见 phoneNote），让角色知道自己手机里有这些、别聊着聊着 OOC
 *  - 角色开了「同步到日记待总结」：生成完往日记流水里记一行，写日记时能顺带提到
 *
 * 和 theater.js 一样，生成是后台任务（POST 只返回任务 id，前端轮询）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyVars, resolveEndpoint, resolveRoleEndpoints, resolveUser } from "./config.js";
import { DATA_DIR, readJson, writeJson } from "./datadir.js";
import { stripEnvPrefix } from "./env.js";
import { chatCompletion } from "./llm.js";
import { logError, logInfo, logWarn } from "./logs.js";
import { appendDiaryLine, diaryLogLine, memoryKeyFor } from "./memorystore.js";
import { listSessions, recentMessages } from "./sessions.js";
import { activate, worldBooksFor } from "./worldinfo.js";

const PHONE_DIR = path.join(DATA_DIR, "phone");
const SCOPE = "查手机";

/** 每个 App 最多留多少条（新的排前面），多了从尾巴上丢。 */
const KEEP_PER_APP = 40;

/**
 * 内置 App。`spec` 是告诉模型这个 App 每条记录长什么样 —— title / detail / value / time
 * 四个字段各自装什么。界面按 id 选样式（client/src/panels/phone.jsx）。
 */
export const BUILTIN_APPS = [
  {
    id: "contacts",
    name: "通讯录",
    spec:
      "通讯录里的联系人（角色自己的社交圈，不是用户的）。title=联系人姓名；value=机主给 TA 的备注名或关系（如 学长、前任、中间人）；detail=机主视角的一句备注。",
  },
  {
    id: "chat",
    name: "信息",
    spec:
      "角色和自己的联系人之间的聊天片段（不是和用户的）。title=联系人姓名；value=对方身份；time=最后一条的时间；" +
      "detail=3～6 句来回的对话，每句一行，机主说的以「我:」开头，对方说的以「对方:」开头。",
  },
  {
    id: "call",
    name: "电话",
    spec: "最近的通话记录。title=联系人；value=呼入 / 呼出 / 未接 加时长（如「呼出 12分钟」「未接」）；time=通话时间；detail=这通电话大概聊了什么（一句话）。",
  },
  {
    id: "shop",
    name: "购物",
    spec: "最近的网购订单。title=商品名；value=价格（如 ¥129.00）；detail=规格和物流状态；time=下单时间。",
  },
  {
    id: "delivery",
    name: "外卖",
    spec: "最近的外卖订单。title=店名；value=实付金额（如 ¥38.50）；detail=点了什么、备注；time=下单时间。",
  },
  {
    id: "browser",
    name: "浏览器",
    spec: "最近的搜索和浏览记录。title=搜索的关键词或网页标题；value=「搜索」或网站名；detail=看到 / 想知道什么（一句话）；time=时间。",
  },
  {
    id: "wallet",
    name: "钱包",
    spec: "钱包的收支流水。title=交易对象或用途；value=金额，支出写成「-¥38.00」、收入写成「+¥500.00」；detail=一句说明；time=时间。",
  },
  {
    id: "track",
    name: "活动轨迹",
    spec: "角色**今天**的活动轨迹，按时间先后排。title=「从哪儿 → 到哪儿」；value=时间段（如 08:10–08:45）；detail=交通方式和在那儿做了什么。",
  },
  {
    id: "favorites",
    name: "收藏夹",
    spec:
      "收藏夹里最私密的东西：角色的碎碎念、没发出去的话、对 {{user}} 的心事和幻想（可以很露骨，包括性幻想和春梦，按人设来）、收藏的图文。" +
      "title=标题；value=一个标签（如 #碎碎念 #梦 #没发出去的）；detail=正文（可以长一些）；time=时间。",
  },
];

const LAYOUT_SPECS = {
  generic: "title=标题；detail=内容；value=可选的数值或状态。",
  shop: "购物风格：title=商品名；detail=规格或状态；value=价格（如 ¥129.00）。",
  feed: "社交动态：title=发布者或心情；detail=正文；value=点赞数。",
  forum: "论坛：title=帖子标题；detail=正文；value=板块（如 #日常）。",
  novel: "小说：title=章节标题；detail=这一章的正文片段（150 字左右）；value=字数（如 1.2万字）。",
};
export const LAYOUTS = Object.keys(LAYOUT_SPECS);

/** 默认的一键生成范围（用户可以在设置里改）。 */
export const DEFAULT_BATCH = ["contacts", "call", "shop", "delivery"];

const newId = () => crypto.randomBytes(6).toString("hex");

/* ================= 配置规范化（config.js 用） ================= */

/** 自定义 App：全局一份，所有角色都有。 */
function normalizeCustomApps(input) {
  if (!Array.isArray(input)) return [];
  const used = new Set(BUILTIN_APPS.map((a) => a.id));
  return input
    .filter((a) => a && typeof a === "object" && String(a.name ?? "").trim())
    .map((a) => {
      let id = /^c-[a-z0-9]{4,20}$/.test(a.id) ? a.id : `c-${newId()}`;
      while (used.has(id)) id = `c-${newId()}`;
      used.add(id);
      return {
        id,
        name: String(a.name).trim().slice(0, 20),
        icon: String(a.icon ?? "").trim().slice(0, 4) || "📱",
        color: /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : "#8e8e93",
        prompt: String(a.prompt ?? "").trim(),
        layout: LAYOUTS.includes(a.layout) ? a.layout : "generic",
      };
    });
}

const clamp = (v, def, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};
const ref = (r) => ({ provider: String(r?.provider ?? ""), modelId: String(r?.modelId ?? "") });

/** 全局的查手机设置。 */
export function normalizePhoneSettings(input) {
  const customApps = normalizeCustomApps(input?.customApps);
  const known = new Set([...BUILTIN_APPS.map((a) => a.id), ...customApps.map((a) => a.id)]);
  const batch = Array.isArray(input?.batchApps) ? input.batchApps.filter((id) => known.has(id)) : DEFAULT_BATCH;
  return {
    // 空 = 用角色自己的聊天模型
    model: ref(input?.model),
    timeout: clamp(input?.timeout, 180, 30, 1800),
    // 每个 App 一次生成几条
    count: clamp(input?.count, 4, 1, 10),
    // 生成时带最近几条聊天（0 = 不带）
    contextCount: clamp(input?.contextCount, 20, 0, 100),
    batchApps: [...new Set(batch)],
    customApps,
  };
}

/** 角色上的查手机开关。全默认关。 */
export function normalizeRolePhone(input) {
  return {
    // 同步到私聊：之后每轮注入一小段摘要
    injectChat: Boolean(input?.injectChat),
    injectChars: clamp(input?.injectChars, 300, 50, 3000),
    // 生成后多久之内注入（小时）。过了就不再注入，token 也就不再花了
    injectHours: clamp(input?.injectHours, 24, 1, 720),
    // 同步到日记待总结
    toDiary: Boolean(input?.toDiary),
    // 允许在 iMessage 里发 /查手机
    command: Boolean(input?.command),
  };
}

/* ================= 存储 ================= */

const SAFE_ROLE_ID = /^[A-Za-z0-9_-]{1,80}$/;

function statePath(roleId) {
  if (!SAFE_ROLE_ID.test(String(roleId))) throw new Error("角色 id 不对");
  return path.join(PHONE_DIR, `${roleId}.json`);
}

function loadState(roleId) {
  const raw = readJson(statePath(roleId), null);
  return {
    // appId → [{id, title, detail, value, time, at, real?}]
    apps: raw?.apps && typeof raw.apps === "object" ? raw.apps : {},
    // appId → 上次生成的时间戳
    updatedAt: raw?.updatedAt && typeof raw.updatedAt === "object" ? raw.updatedAt : {},
    walletBalance: String(raw?.walletBalance ?? ""),
    bookIds: Array.isArray(raw?.bookIds) ? raw.bookIds : [],
    // 最近一次生成：注入私聊用的就是这一批
    last: raw?.last && typeof raw.last === "object" ? raw.last : null,
  };
}

function saveState(roleId, state) {
  writeJson(statePath(roleId), state);
}

/* ================= 拼请求 ================= */

function appsOf(config) {
  const custom = (config.phone?.customApps ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    custom: true,
    spec: `自定义 App「${a.name}」。这个 App 是干什么的：${a.prompt || "（没写，按名字猜）"}。${LAYOUT_SPECS[a.layout] ?? LAYOUT_SPECS.generic}`,
  }));
  return [...BUILTIN_APPS, ...custom];
}

function nowText() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const wd = "日一二三四五六"[d.getDay()];
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 星期${wd} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function recentChat(config, role, user) {
  const n = config.phone?.contextCount ?? 20;
  if (!n) return "";
  const s = listSessions().find((x) => x.roleId === role.id && x.kind !== "legacy-preset");
  if (!s) return "";
  return recentMessages(s.id, n)
    .map((m) => `${m.role === "user" ? user?.name || "用户" : role.name}: ${stripEnvPrefix(m.content).trim()}`)
    .filter((l) => !l.endsWith(": "))
    .join("\n");
}

/**
 * 一次请求的全部消息。`apps` 是这次要生成的那几个 App。
 * 返回格式统一成一个 JSON 对象：键是 App id，值是记录数组 —— 单个 App 刷新也一样，
 * 解析只有一条路。
 */
/** 同一天（本地时间）。活动轨迹「接着往下写」只在同一天里接。 */
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/**
 * 继续生成时给模型看的「手机里已经有的」：每个 App 最近几条的标题。
 * 只给标题和一点点值，不给正文 —— 够它别写重复、接得上，又不至于把提示词撑大。
 */
function existingNote(apps, state) {
  const lines = [];
  for (const a of apps) {
    let list = state.apps[a.id] ?? [];
    if (a.id === "track") list = list.filter((x) => sameDay(x.at, Date.now()));
    if (!list.length) continue;
    const shown = list.slice(0, a.id === "track" ? 12 : 8).map((x) => x.title + (x.value ? `（${x.value}）` : ""));
    lines.push(`- ${a.id}（${a.name}）：${shown.join("；")}`);
  }
  return lines.join("\n");
}

/**
 * @param {"append"|"reset"} mode append = 在原来的手机上接着加（模型能看到已有的条目）；
 *        reset = 当这台手机是全新的，不给它看旧内容
 */
function buildMessages(config, role, apps, bookIds, mode = "append") {
  const user = resolveUser(config, role);
  const vars = { char: role.name ?? "", user: user?.name ?? "" };
  const fill = (t) => applyVars(String(t ?? ""), vars).trim();
  const count = config.phone?.count ?? 4;
  const chat = recentChat(config, role, user);

  // 世界书：只从这个角色关联的那几本里挑勾上的
  const books = worldBooksFor(config, role).filter((b) => bookIds.includes(b.id));
  let world = "";
  if (books.length) {
    const hit = activate(books, [
      { role: "system", content: fill(role.description) },
      { role: "user", content: chat },
    ]);
    world = [hit.before, ...[...hit.depths.values()].map((d) => d.content), hit.after]
      .map(fill)
      .filter(Boolean)
      .join("\n\n");
  }

  // 其他角色：通讯录里出现了就算「真实存在的人」
  const others = (config.roles ?? [])
    .filter((r) => r.id !== role.id && r.name)
    .map((r) => `- ${r.name}：${fill(r.description).replace(/\s+/g, " ").slice(0, 80) || "（没有人设）"}`);
  const state = loadState(role.id);
  const fresh = mode === "reset";
  const known = fresh ? [] : (state.apps.contacts ?? []).slice(0, 15).map((c) => `${c.title}（${c.value || "—"}）`);
  const existing = fresh ? "" : existingNote(apps, state);

  const system = [
    `你是 ${vars.char}。下面是你的人设，接下来要生成的是**你自己手机里的内容**。`,
    `<人设>\n${fill(role.description) || "（没有写人设）"}\n</人设>`,
    user?.description ? `<${vars.user || "用户"}的人设>\n${fill(user.description)}\n</${vars.user || "用户"}的人设>` : "",
    world ? `<世界设定>\n${world}\n</世界设定>` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const task = [
    `现在是 ${nowText()}。`,
    chat ? `<你和${vars.user || "用户"}最近的聊天（背景参考）>\n${chat}\n</你和${vars.user || "用户"}最近的聊天>` : "",
    others.length ? `<其他真实存在的人（可以出现在你的通讯录里，关系要贴合他们的设定，不认识就别硬塞）>\n${others.join("\n")}\n</其他真实存在的人>` : "",
    known.length ? `你通讯录里已经有这些人，前后要对得上：${known.join("、")}` : "",
    existing
      ? `<手机里已经有的（这次是接着往下加新的，别重复这些；时间往后走，情节能接上就接上，活动轨迹从最后一站接着走）>\n${existing}\n</手机里已经有的>`
      : "",
    [
      "视角：这些全是**你自己**的生活和社交，用你的第一人称视角写；",
      `${vars.user || "用户"}正在翻看你的手机，TA 不是你通讯录里的路人（要提到 TA 就用你平时对 TA 的称呼）。`,
      "内容要贴合人设、最近发生的事和现在的时间，细节具体，别写成千篇一律的模板。",
    ].join(""),
    `这次要生成下面这些 App，每个 ${count} 条左右（活动轨迹按今天实际走过的地方来，不够就少写）：`,
    apps.map((a) => `- ${a.id}（${a.name}）：${fill(a.spec)}`).join("\n"),
    [
      "只输出一个 JSON 对象，不要解释、不要代码块以外的文字。",
      `键是上面的 App id，值是记录数组，每条 {"title": "…", "detail": "…", "value": "…", "time": "…"}，四个字段都是字符串。`,
      apps.some((a) => a.id === "wallet") ? `另外加一个键 "walletBalance"，值是钱包余额（如 "¥3,281.40"）。` : "",
    ].join(""),
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: task },
  ];
}

/** 从模型回复里抠出 JSON 对象：剥代码块、取第一个 { 到最后一个 }，再把尾逗号去掉。 */
export function extractJson(text) {
  let t = String(text ?? "").replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "");
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1];
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  const body = t.slice(a, b + 1);
  for (const candidate of [body, body.replace(/,\s*([}\]])/g, "$1")]) {
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

const asText = (v) =>
  typeof v === "string" ? v.trim() : v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

/** 角色自己的模型（失败退副 API），或者设置里单独选的那个。 */
async function callModel(config, role, messages) {
  const timeout = (config.phone?.timeout ?? 180) * 1000;
  const custom = config.phone?.model?.provider ? resolveEndpoint(config, config.phone.model) : null;
  const eps = custom ? { chat: custom, fallback: null } : resolveRoleEndpoints(config, role);
  if (!eps.chat) throw new Error("这个角色没配聊天模型，查手机也就没法用（或者在「查手机 → 设置」里单独选一个）");
  try {
    return await chatCompletion(eps.chat, messages, { label: `查手机（${eps.chat.label}）`, timeout });
  } catch (e) {
    if (!eps.fallback) throw e;
    logWarn(SCOPE, "主 API 没成，换副 API 再试一次", String(e?.message ?? e));
    return await chatCompletion(eps.fallback, messages, { label: `查手机（${eps.fallback.label}）`, timeout });
  }
}

/* ================= 摘要（私聊注入 / 日记） ================= */

function itemLine(appName, it, detailChars) {
  const d = it.detail.replace(/\s+/g, " ");
  const tail = detailChars && d ? `：${d.length > detailChars ? `${d.slice(0, detailChars)}…` : d}` : "";
  return `${appName}｜${it.title}${it.value ? `（${it.value}）` : ""}${tail}`;
}

/** 一批生成结果压成几行字。超过 maxChars 就停。 */
function summarize(config, batch, maxChars, detailChars) {
  const names = Object.fromEntries(appsOf(config).map((a) => [a.id, a.name]));
  const lines = [];
  let used = 0;
  for (const [appId, items] of Object.entries(batch ?? {})) {
    for (const it of items) {
      const line = itemLine(names[appId] ?? appId, it, detailChars);
      if (used + line.length + 1 > maxChars) return lines.join("\n");
      lines.push(line);
      used += line.length + 1;
    }
  }
  return lines.join("\n");
}

/**
 * 「同步到私聊」那一段：最近一次查手机的摘要。
 *
 * **只在这一轮请求里注入、不进存档**（和天气同一个道理），所以 token 花费是
 * 「每轮固定多这几百字」，不会越攒越多：
 *  - 字数上限 injectChars（默认 300，中文约 300 token）
 *  - 时效 injectHours（默认 24 小时）：生成超过这个时间就不再注入，花费归零
 * 长期的记忆交给日记那条路（toDiary）。
 *
 * @returns {string} 空串 = 这轮不注入
 */
export function phoneNote(config, role) {
  const p = role?.phone;
  if (!p?.injectChat || !role?.id || !SAFE_ROLE_ID.test(role.id)) return "";
  let state;
  try {
    state = loadState(role.id);
  } catch {
    return "";
  }
  if (!state.last?.at || Date.now() - state.last.at > p.injectHours * 3600_000) return "";
  const body = summarize(config, state.last.items, p.injectChars, 24);
  if (!body) return "";
  return (
    `<Phone>\n这是你自己手机里最近的东西（只是让你知道自己的近况，别主动念出来，被问到时对得上就行）：\n${body}\n</Phone>`
  );
}

/** 插在开头那一串 system 之后。 */
export function injectPhoneNote(messages, note) {
  if (!note) return messages;
  const at = messages.findIndex((m) => m.role !== "system");
  const i = at === -1 ? messages.length : at;
  return [...messages.slice(0, i), { role: "system", content: note }, ...messages.slice(i)];
}

/* ================= 生成 ================= */

/**
 * 真去生成一批，落盘，按开关同步日记。返回这一批（appId → 记录）。
 * 后台任务和 /查手机 指令都走这里。
 */
export async function runGenerate(config, role, appIds, opts = {}) {
  const all = appsOf(config);
  const apps = all.filter((a) => appIds.includes(a.id));
  if (!apps.length) throw new Error("没选要生成哪些 App");
  const state = loadState(role.id);
  const bookIds = Array.isArray(opts.bookIds) ? opts.bookIds : state.bookIds;
  const reset = opts.mode === "reset";

  logInfo(SCOPE, `${reset ? "重置并重新生成" : "开始翻"} ${role.name} 的手机：${apps.map((a) => a.name).join("、")}`);
  const reply = await callModel(config, role, buildMessages(config, role, apps, bookIds, reset ? "reset" : "append"));
  const json = extractJson(reply);
  if (!json) throw new Error(`模型回的不是 JSON，没法解析：${String(reply).slice(0, 120)}`);

  const otherNames = new Set((config.roles ?? []).filter((r) => r.id !== role.id).map((r) => r.name?.trim()).filter(Boolean));
  const now = Date.now();
  const batch = {};
  /*
   * 重置：整台手机换成这一批 —— 但要等**生成成功之后**才清。前面任何一步抛错
   * （模型没回、回的不是 JSON），旧内容都还在，不会落得一台空手机。
   */
  if (reset) {
    state.apps = {};
    state.updatedAt = {};
    state.walletBalance = "";
  }
  for (const app of apps) {
    const raw = Array.isArray(json[app.id]) ? json[app.id] : [];
    const items = raw
      .filter((x) => x && typeof x === "object")
      .map((x) => ({
        id: newId(),
        title: asText(x.title) || "（无标题）",
        detail: asText(x.detail),
        value: asText(x.value),
        time: asText(x.time),
        at: now,
        ...(app.id === "contacts" || app.id === "chat" ? { real: otherNames.has(asText(x.title).replace(/[（(].*?[）)]/g, "").trim()) } : {}),
      }));
    if (!items.length) continue;
    batch[app.id] = items;
    if (app.id === "track") {
      // 活动轨迹按时间先后排、只算今天：今天已经有的就接在后面，跨天了就整个换掉
      const today = (state.apps.track ?? []).filter((x) => sameDay(x.at, now));
      state.apps.track = [...today, ...items].slice(-KEEP_PER_APP);
    } else {
      // 其余的新的排前面，旧的往后挤
      state.apps[app.id] = [...items, ...(state.apps[app.id] ?? [])].slice(0, KEEP_PER_APP);
    }
    state.updatedAt[app.id] = now;
  }
  if (json.walletBalance) state.walletBalance = asText(json.walletBalance);
  if (!Object.keys(batch).length) throw new Error("模型回了 JSON，但里面一条能用的记录都没有");
  // ↑ 这一句在 reset 清空 state 之后，但 state 还没落盘 —— 抛出去旧文件照样完好

  state.bookIds = bookIds;
  state.last = { at: now, items: batch };
  saveState(role.id, state);

  const total = Object.values(batch).reduce((n, l) => n + l.length, 0);
  logInfo(SCOPE, `${role.name} 的手机生成好了：${total} 条`, summarize(config, batch, 4000, 60));

  // 日记待总结：写日记时能顺带提到手机里的事
  if (role.phone?.toDiary && role.memories?.diary?.enabled) {
    try {
      const text = summarize(config, batch, 1500, 60).replace(/\n/g, "；");
      appendDiaryLine(memoryKeyFor(role), diaryLogLine(`${role.name}的手机`, text));
    } catch (e) {
      logWarn(SCOPE, "没记进日记待总结（不影响查手机本身）", e);
    }
  }
  return batch;
}

/** 给 /查手机 指令回的那条消息。 */
export function batchText(config, batch) {
  return summarize(config, batch, 1500, 40);
}

/* ================= 后台任务 + 路由 ================= */

const jobs = new Map();

function startJob(roleId, title, run) {
  const job = { id: newId(), roleId, title, status: "running", startedAt: Date.now(), error: "" };
  jobs.set(job.id, job);
  while (jobs.size > 30) jobs.delete(jobs.keys().next().value);
  run().then(
    () => {
      job.status = "done";
    },
    (e) => {
      job.status = "error";
      job.error = String(e?.message ?? e);
      logError(SCOPE, `「${title}」没生成出来`, job.error);
    }
  );
  return job;
}

function roleOr404(config, id) {
  const role = (config.roles ?? []).find((r) => r.id === id);
  if (!role) throw new Error("没有这个角色（可能删了）");
  return role;
}

/**
 * 「信息」App 里和用户的那个对话：直接取真实存档的最近五轮（一轮 = 用户的一条
 * 加上角色的回复），不打模型。环境前缀剥掉，只给界面看。
 */
const USER_ROUNDS = 5;
function userThread(config, role) {
  const s = listSessions().find((x) => x.roleId === role.id && x.kind !== "legacy-preset");
  if (!s) return [];
  const msgs = recentMessages(s.id, 200);
  let i = msgs.length;
  let seen = 0;
  while (i > 0) {
    i -= 1;
    if (msgs[i].role === "user" && ++seen >= USER_ROUNDS) break;
  }
  return msgs
    .slice(seen ? i : msgs.length)
    .map((m) => ({ from: m.role === "user" ? "user" : "me", text: stripEnvPrefix(m.content).trim() }))
    .filter((m) => m.text);
}

function publicState(config, roleId) {
  const role = roleOr404(config, roleId);
  const s = loadState(roleId);
  const user = resolveUser(config, role);
  return {
    userName: user?.name || "",
    userThread: userThread(config, role),
    apps: s.apps,
    updatedAt: s.updatedAt,
    walletBalance: s.walletBalance,
    bookIds: s.bookIds,
    lastAt: s.last?.at ?? 0,
    books: worldBooksFor(config, role).map((b) => ({ id: b.id, name: b.name, global: b.global })),
    jobs: [...jobs.values()].filter((j) => j.roleId === roleId).reverse(),
    builtin: BUILTIN_APPS.map(({ id, name }) => ({ id, name })),
  };
}

export function mountPhone(app, loadConfig) {
  const wrap = (fn) => async (req, res) => {
    try {
      const config = loadConfig();
      const out = await fn(req, config);
      res.json({ ok: true, ...(out ?? {}), state: publicState(config, req.params.roleId) });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message ?? e) });
    }
  };

  app.get("/api/phone/:roleId", wrap(() => null));

  // body: { apps: [...ids], bookIds: [...] }。apps 不传 = 一键生成那一组
  app.post(
    "/api/phone/:roleId/generate",
    wrap((req, config) => {
      const role = roleOr404(config, req.params.roleId);
      const ids = Array.isArray(req.body?.apps) && req.body.apps.length ? req.body.apps : config.phone?.batchApps ?? DEFAULT_BATCH;
      const bookIds = Array.isArray(req.body?.bookIds) ? req.body.bookIds : undefined;
      // mode: "append"（默认，在原来的手机上接着加）| "reset"（整台手机换成新的一批）
      const mode = req.body?.mode === "reset" ? "reset" : "append";
      const title =
        ids.length > 1
          ? `${mode === "reset" ? "重置并重新生成" : "继续生成"}（${ids.length} 个 App）`
          : appsOf(config).find((a) => a.id === ids[0])?.name ?? ids[0];
      return { job: startJob(role.id, title, () => runGenerate(config, role, ids, { bookIds, mode })) };
    })
  );

  app.post(
    "/api/phone/:roleId/books",
    wrap((req, config) => {
      roleOr404(config, req.params.roleId);
      const s = loadState(req.params.roleId);
      s.bookIds = Array.isArray(req.body?.bookIds) ? req.body.bookIds.map(String) : [];
      saveState(req.params.roleId, s);
    })
  );

  // 删一条（itemId）或者清空一个 App（不带 itemId）
  app.delete(
    "/api/phone/:roleId/apps/:appId",
    wrap((req, config) => {
      roleOr404(config, req.params.roleId);
      const s = loadState(req.params.roleId);
      const itemId = String(req.query.item ?? "");
      if (itemId) s.apps[req.params.appId] = (s.apps[req.params.appId] ?? []).filter((x) => x.id !== itemId);
      else delete s.apps[req.params.appId];
      saveState(req.params.roleId, s);
    })
  );
}

export { PHONE_DIR };
