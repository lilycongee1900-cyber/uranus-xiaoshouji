/**
 * 自定义 CSS：控制台一份、查手机的那台手机一份（client/src/customcss.jsx 负责注入）。
 *
 * 存在 data/custom-css.json，不进 config.json —— 那边是「草稿 + 点保存」，保存还会对齐
 * 所有 iMessage 桥接；这里要的是贴进去点一下立刻生效。
 *
 * 进云备份的「配置」那一块（cloudbackup.js:SCOPES）。
 */

import path from "node:path";

import { DATA_DIR, readJson, writeJson } from "./datadir.js";

const FILE = path.join(DATA_DIR, "custom-css.json");

/** 一份最多多大。主题 CSS 一般几 KB，给足 200 KB；再大多半是贴错了东西（比如整张 base64 图）。 */
const MAX_CHARS = 200_000;

const KEYS = ["console", "phone"];

export function readCustomCss() {
  const raw = readJson(FILE, {});
  return Object.fromEntries(KEYS.map((k) => [k, typeof raw?.[k] === "string" ? raw[k] : ""]));
}

export function mountCustomCss(app) {
  app.get("/api/custom-css", (_req, res) => res.json(readCustomCss()));

  app.put("/api/custom-css", (req, res) => {
    const next = readCustomCss();
    for (const k of KEYS) {
      if (!(k in (req.body ?? {}))) continue;
      const css = String(req.body[k] ?? "");
      if (css.length > MAX_CHARS) {
        return res.status(400).json({ error: `CSS 太长了（${css.length} 字，上限 ${MAX_CHARS}）` });
      }
      next[k] = css;
    }
    writeJson(FILE, next);
    res.json(next);
  });
}
