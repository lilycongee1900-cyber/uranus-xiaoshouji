/**
 * 定时提醒的接口，给侧边栏「提醒」那个面板用（client/src/panels/reminders.jsx）。
 *
 * 条目和默认提前量都在 data/reminders.json（reminder.js），不走 PUT /api/config ——
 * 那条会把所有 iMessage 桥接重启一遍，而这边点一下开关就要写。
 *
 * 时间一律按**用户那边**的时区显示和解析：条目绑了哪个角色就看那个角色的「所在城市」，
 * 绑的是「所有角色」就看第一个角色的（都没填就是系统时区）。
 */

import { userTzOf } from "./env.js";
import {
  addItem,
  describeRule,
  fmtWhen,
  leadOf,
  loadReminders,
  normalizeItem,
  patchItem,
  removeItem,
  setSettings,
  upcoming,
} from "./reminder.js";

/** 前端的「08:00」补成「08:00:00」。 */
function fixTime(t) {
  const s = String(t ?? "").trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) return `${s.padStart(5, "0")}:00`;
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(s)) return s.padStart(8, "0");
  return s;
}

/** 用户在面板上建的那条够不够格：缺什么就说什么。 */
function checkUserItem(it) {
  if (!it.title.trim()) return "要提醒什么没写";
  if (it.kind === "birthday" && !it.date && !it.lunar) return "生日哪天没填";
  if (it.kind === "anniversary" && !it.date) return "纪念日从哪天开始没填";
  if (it.repeat.type === "once" && !it.date) return "日期没填";
  if (it.repeat.type === "weekly" && !it.repeat.weekdays.length) return "每周哪几天没勾";
  if ((it.repeat.type === "monthly" || it.repeat.type === "yearly") && !it.date && !it.lunar) return "日期没填";
  if (it.repeat.termStart && it.repeat.termEnd && it.repeat.termStart > it.repeat.termEnd) return "学期结束早于开始";
  return "";
}

/** 改了这几样就得从现在起重新数（提前那一声也重新算）。 */
const RESCHEDULE_KEYS = ["date", "time", "repeat", "lunar", "lead", "notify", "status", "roleId"];

export function mountReminders(app, loadConfig) {
  const roles = () => loadConfig()?.roles ?? [];
  const tzFor = async (roleId) => {
    const list = roles();
    const role = list.find((r) => r.id === roleId) ?? list[0] ?? null;
    return userTzOf(role);
  };

  async function view() {
    const state = loadReminders();
    const list = roles();
    const tzCache = new Map();
    const tzOf = async (roleId) => {
      if (!tzCache.has(roleId)) tzCache.set(roleId, await tzFor(roleId));
      return tzCache.get(roleId);
    };
    const items = [];
    for (const it of state.items) {
      const tz = it.repeat.type === "once" && it.tz ? it.tz : await tzOf(it.roleId);
      const next = it.status === "pending" ? upcoming(it, tz) : null;
      items.push({
        ...it,
        nextAt: next,
        nextText: next ? fmtWhen(next, tz) : "",
        ruleText: describeRule(it),
        leadUsed: leadOf(it, state.settings),
        roleName: list.find((r) => r.id === it.roleId)?.name ?? (it.roleId ? "（角色已删除）" : "所有角色"),
      });
    }
    return {
      settings: state.settings,
      items,
      roles: list.map((r) => ({ id: r.id, name: r.name, enabled: Boolean(r.reminder?.enabled) })),
    };
  }

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req);
      res.json({ ok: true, ...(await view()) });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message ?? e) });
    }
  };

  app.get("/api/reminders", wrap(async () => {}));

  app.put(
    "/api/reminders/settings",
    wrap(async (req) => {
      const b = req.body ?? {};
      setSettings(
        Object.fromEntries(["leadMinutes", "scheduleInTime"].filter((k) => k in b).map((k) => [k, b[k]]))
      );
    })
  );

  app.post(
    "/api/reminders",
    wrap(async (req) => {
      const body = req.body ?? {};
      const draft = normalizeItem({ ...body, source: "user", time: fixTime(body.time), id: "" });
      const why = checkUserItem(draft);
      if (why) throw new Error(why);
      addItem({ ...draft, tz: await tzFor(draft.roleId) });
    })
  );

  app.put(
    "/api/reminders/:id",
    wrap(async (req) => {
      const body = { ...(req.body ?? {}) };
      if ("time" in body) body.time = fixTime(body.time);
      // 这几样不让面板改：来源、记账的那几个时间戳
      for (const k of ["id", "source", "createdAt", "handledUntil", "leadFor", "firedAt", "raw"]) delete body[k];
      const old = loadReminders().items.find((it) => it.id === req.params.id);
      if (!old) throw new Error("这条提醒已经不在了");
      const merged = normalizeItem({ ...old, ...body });
      if (old.source === "user") {
        const why = checkUserItem(merged);
        if (why) throw new Error(why);
      }
      const reschedule = RESCHEDULE_KEYS.some((k) => k in body && JSON.stringify(body[k]) !== JSON.stringify(old[k]));
      // 改了时间的一次性提醒：时区跟着现在这个角色走（面板上显示的就是这个时区的钟点）
      if (reschedule && merged.repeat.type === "once") body.tz = await tzFor(merged.roleId);
      patchItem(req.params.id, body, { reschedule });
    })
  );

  app.delete(
    "/api/reminders/:id",
    wrap(async (req) => {
      removeItem(req.params.id);
    })
  );
}
