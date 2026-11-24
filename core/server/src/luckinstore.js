/**
 * 瑞幸订单卡片的落盘：一个角色一份，按卡片的 messageGuid 索引。
 *
 * 和 transferstore.js 同一个理由要上盘：卡片的四个 guid 不存下来就改不了状态，
 * 而对方可能隔很久才去点确认，中间进程重启过。也同样不进 config.json、按角色
 * 分文件、超过上限从最旧的丢。
 *
 * 一条记录里除了句柄，还有**下单要用的全部参数**（门店、商品、坐标、券）——
 * 确认那一刻按存下来的这份下单，不重新查一遍：卡片上给对方看的就是这一单，
 * 下出去的必须是同一单。
 */

import fs from "node:fs";
import path from "node:path";

import { LUCKIN_DIR, ensureLayout } from "./datadir.js";
import { logWarn } from "./logs.js";

const SCOPE = "瑞幸";

/** 文件名白名单。roleKey 来自 memorystore.js:memoryKeyFor（同一个正则）。 */
const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

/** 一个角色最多留几单。条目比转账大（带商品列表），所以上限低一些。 */
export const MAX_ENTRIES = 200;

function fileFor(roleKey) {
  if (!SAFE_KEY.test(String(roleKey ?? ""))) return null;
  return path.join(LUCKIN_DIR, `${roleKey}.json`);
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, file);
}

/** 读这个角色的全部订单。坏文件只 warn、当空的用，不动它（照 transferstore.js）。 */
export function readOrders(roleKey) {
  ensureLayout();
  const file = fileFor(roleKey);
  if (!file || !fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8") || "{}");
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch (e) {
    logWarn(SCOPE, `${path.basename(file)} 读不出来，这次当空的用（文件没动）`, e);
    return [];
  }
}

/** 记下或覆盖一单（按 messageGuid 去重）。 */
export function putOrder(roleKey, entry) {
  const file = fileFor(roleKey);
  const guid = String(entry?.messageGuid ?? "").trim();
  if (!file || !guid) return false;
  const next = readOrders(roleKey).filter((it) => String(it?.messageGuid ?? "") !== guid);
  next.push({ ...entry, messageGuid: guid, updatedAt: Date.now() });
  while (next.length > MAX_ENTRIES) next.shift();
  try {
    writeAtomic(file, JSON.stringify({ version: 1, items: next }, null, 2));
    return true;
  } catch (e) {
    logWarn(SCOPE, "订单记录没写进去", e);
    return false;
  }
}

/** 被贴了 emoji 的那条气泡是不是一张订单卡片。两个 guid 都认（同 findTransfer）。 */
export function findOrder(roleKey, guid) {
  const g = String(guid ?? "").trim();
  if (!g) return null;
  return (
    readOrders(roleKey).find(
      (it) => String(it?.messageGuid ?? "") === g || String(it?.targetMessageGuid ?? "") === g
    ) ?? null
  );
}
