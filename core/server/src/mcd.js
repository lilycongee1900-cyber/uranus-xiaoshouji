/**
 * 麦当劳点单：把模型写的 `[麦当劳:巨无霸套餐+麦辣鸡翅×2@外送#不要辣]` 变成一张订单卡片。
 *
 * 和瑞幸（luckin.js）一个套路：模型只写吃什么，工具链由这里按固定顺序调麦当劳中国的
 * 官方 MCP（mcp.mcd.cn），最后发卡片，**对方给卡片贴回应才下单**。调用、解信封、断线
 * 重试都共用 luckin.js 那一套（callBrand）。
 *
 * ## 两种方式
 *
 *  - **外送**（默认）：用对方麦当劳账号里存好的收货地址（delivery-query-addresses），
 *    按地址查能送的门店（delivery-query-stores），送到那个地址。
 *  - **到店**：先查对方收藏的门店，没有收藏再按位置查附近的（query-nearby-stores）。
 *
 * 标记里写 `@外送` / `@到店`，不写按外送；`@` 后面写别的词就当门店名筛选（到店）。
 *
 * ## 字段
 *
 * 照麦当劳 MCP 的约定：orderType 整数 1=到店 / 2=外送；外送要 beCode + addressId；
 * 到店下单要 calculate-price 给的 takeWayCode；calculate-price 的金额单位是**分**，
 * query-meals 里的 currentPrice 是元。菜单里只有 categories 里出现过的 code 是这个
 * 时段能下单的（早餐 / 午餐 / 夜宵会换），meals 字典本身是全天的。
 *
 * 套餐里的子单品（可乐换雪碧）麦当劳的接口改不了，规格词一律不认，只记一句给模型。
 */

import { LuckinError, asList, callBrand, nameScore, num, remarkField } from "./luckin.js";
import { logDebug, logInfo, logWarn } from "./logs.js";

const call = (config, tool, args, scope) => callBrand(config, "mcd", tool, args, scope);

const DELIVERY = 2;
const PICKUP = 1;

/** 金额：calculate-price 给的是分。 */
const yuanFromFen = (v) => {
  const n = num(v);
  return n === null ? null : n / 100;
};

/** `@` 后面那段 → 方式 + 门店词。 */
function modeOf(store) {
  const s = String(store ?? "").trim();
  if (!s || /外送|外卖|送到|配送|麦乐送/.test(s)) return { orderType: DELIVERY, storeHint: "" };
  if (/^(到店|自取|自提|堂食)$/.test(s)) return { orderType: PICKUP, storeHint: "" };
  return { orderType: PICKUP, storeHint: s.replace(/到店|自取|自提/g, "").trim() };
}

/** 账号里存的收货地址。 */
export async function mcdAddresses(config, scope = "麦当劳") {
  const raw = await call(config, "delivery-query-addresses", {}, scope);
  return asList(raw?.addresses ?? raw).filter((a) => a?.addressId);
}

/**
 * 外送送到哪个地址。
 *
 * 麦当劳的地址列表**没有「默认」标记**（实测三个地址分在两个城市，第一个是外地的），
 * 所以不能闭眼取第一个：角色上选过就用选的；没选就拿「你」里的常用地址去比，
 * 共用字最多的那个；都没有才取第一个，并在日志里说一声。
 */
function pickAddress(addrs, chosenId, hint, scope) {
  const chosen = chosenId && addrs.find((a) => String(a.addressId) === String(chosenId));
  if (chosen) return chosen;
  if (hint) {
    const best = [...addrs].sort((a, b) => nameScore(hint, b.fullAddress) - nameScore(hint, a.fullAddress))[0];
    if (best && nameScore(hint, best.fullAddress) >= 20) return best;
  }
  if (addrs.length > 1) logWarn(scope, "麦当劳账号里有好几个地址、角色上没选，先用第一个 —— 去角色配置 → 点单 → 麦当劳里选一个");
  return addrs[0];
}

/** 外送：选定的地址 + 能送它的第一家营业中的店。 */
async function deliveryTarget(config, opts, scope) {
  const addrs = await mcdAddresses(config, scope);
  if (!addrs.length) throw new LuckinError("麦当劳账号里还没有收货地址，先去麦当劳 App 里加一个，或者写 @到店");
  const addr = pickAddress(addrs, opts.addressId, opts.addressHint, scope);
  const stores = asList(await call(config, "delivery-query-stores", { addressId: addr.addressId, beType: 2 }, scope))
    .filter((s) => s?.storeCode);
  const open = stores.filter((s) => s.businessStatus !== false);
  if (!open.length) throw new LuckinError(`${addr.fullAddress ?? "这个地址"}现在没有能送的麦当劳`);
  return open.map((st) => ({
    orderType: DELIVERY,
    storeCode: st.storeCode,
    beCode: st.beCode ?? "",
    beType: 2,
    addressId: addr.addressId,
    shopName: String(st.storeName ?? `门店 ${st.storeCode}`),
    shopAddress: String(addr.fullAddress ?? ""),
  }));
}

/**
 * 到店：先看麦当劳 App 里收藏的门店；没收藏就用「能送到你地址的那几家」当附近的店。
 *
 * 不走 searchType=2 按位置查：实测各种城市名 + 关键词写法都回「没有查询到该地址」。
 * 写了门店词就按名字挑。
 */
async function pickupTarget(config, opts, storeHint, scope) {
  let stores = [];
  try {
    stores = asList(await call(config, "query-nearby-stores", { searchType: 1, beType: 1 }, scope));
  } catch (e) {
    // 没收藏时麦当劳回的是 success:false「收藏餐厅列表为空」，当没有
    logDebug(scope, `没有收藏的门店：${String(e?.message ?? e)}`);
  }
  if (!stores.length) {
    const addrs = await mcdAddresses(config, scope).catch(() => []);
    if (addrs.length) {
      const addr = pickAddress(addrs, opts.addressId, opts.addressHint, scope);
      stores = asList(await call(config, "delivery-query-stores", { addressId: addr.addressId, beType: 2 }, scope));
    }
  }
  stores = stores.filter((s) => s?.storeCode && s.businessStatus !== false);
  if (!stores.length) throw new LuckinError("没查到能去的麦当劳门店（可以在麦当劳 App 里收藏一家常去的）");
  const sorted = storeHint
    ? [...stores].sort((a, b) => nameScore(storeHint, b.storeName) - nameScore(storeHint, a.storeName))
    : stores;
  return sorted.map((st) => ({
    orderType: PICKUP,
    storeCode: st.storeCode,
    // 到店自取不传 beCode（麦当劳的参数说明里写死了，传了会报错）
    beCode: "",
    beType: 1,
    addressId: "",
    shopName: String(st.storeName ?? `门店 ${st.storeCode}`),
    shopAddress: String(st.address ?? ""),
  }));
}

/* ================= 优惠券 ================= */

/** 一键领券多久做一次。领券不花钱，但每轮都去领纯属白等。 */
const CLAIM_EVERY_MS = 6 * 3600_000;
const claimedAt = new Map();

/**
 * 「自动领券」：把麦麦省里当前能领的券一次领进账号（auto-bind-coupons，不花钱）。
 * 同一个 token 6 小时做一次；失败只记一笔，不拦点单。
 */
export async function claimMcdCoupons(config, scope = "麦当劳") {
  const token = String(config?.mcdApi?.token ?? "");
  if (Date.now() - (claimedAt.get(token) ?? 0) < CLAIM_EVERY_MS) return;
  claimedAt.set(token, Date.now());
  try {
    const r = await call(config, "auto-bind-coupons", {}, scope);
    const text = typeof r === "string" ? r : JSON.stringify(r ?? "");
    logInfo(scope, `自动领了一次麦当劳的券：${text.slice(0, 120)}`);
  } catch (e) {
    logDebug(scope, `自动领券没成：${String(e?.message ?? e)}`);
  }
}

/**
 * 这家店这单能用的券。麦当劳的券是「券商品」：每张券对应一个专门的 productCode，
 * 点单时把它当一样商品加进 items，带上 couponId / couponCode 就是用券（实测「麦旋风任选」
 * 对应 9900014239）。查不到当没有。
 *
 * @returns {Promise<{title:string, couponId:string, couponCode:string, productCode:string}[]>}
 */
async function storeCoupons(config, target, scope) {
  const args = { storeCode: target.storeCode, orderType: target.orderType, beType: target.beType };
  if (target.orderType === DELIVERY && target.beCode) args.beCode = target.beCode;
  try {
    return asList(await call(config, "query-store-coupons", args, scope))
      .map((c) => ({
        title: String(c?.title ?? ""),
        couponId: String(c?.couponId ?? ""),
        couponCode: String(c?.couponCode ?? ""),
        productCode: String(c?.products?.[0]?.productCode ?? ""),
      }))
      .filter((c) => c.title && c.productCode && (c.couponId || c.couponCode));
  } catch (e) {
    logDebug(scope, `这家店的券没查到：${String(e?.message ?? e)}`);
    return [];
  }
}

/** 一行商品 → calculate-price / create-order 的 items 项。用券的那一项带上券号。 */
const itemOf = (l) => ({
  productCode: l.productCode,
  quantity: l.coupon ? 1 : l.qty,
  ...(l.coupon ? { couponId: l.coupon.couponId, couponCode: l.coupon.couponCode } : {}),
});

/** 这家店这个时段能点的：code → {name, price}。 */
async function orderableMeals(config, target, scope) {
  const args = { storeCode: target.storeCode, orderType: target.orderType, beType: target.beType };
  if (target.orderType === DELIVERY && target.beCode) args.beCode = target.beCode;
  const d = await call(config, "query-meals", args, scope);
  const dict = d?.meals && typeof d.meals === "object" ? d.meals : {};
  const live = new Set();
  for (const c of Array.isArray(d?.categories) ? d.categories : []) {
    for (const m of Array.isArray(c?.meals) ? c.meals : []) if (m?.code) live.add(String(m.code));
  }
  const out = new Map();
  for (const [code, m] of Object.entries(dict)) {
    if (live.size && !live.has(code)) continue;
    if (m?.name) out.set(code, { name: String(m.name), price: num(m.currentPrice) });
  }
  return out;
}

/** 最多试几家店。 */
const MAX_TRY_STORES = 4;

/**
 * 定门店并拿到它此刻能点的菜单。
 *
 * 候选店按顺序**一家家试 query-meals**，第一家能点的就用它：门店列表里的
 * businessStatus 只说「今天营业」，不说「现在还接这种单」。实测晚上 22:50，
 * 列表第一家（营业到 23:00）到店点餐已经停了、回「门店可能已关闭或不在营业时间」，
 * 而后面两家开到凌晨两点，照常能点。闭眼取第一家就会说「麦当劳关门了」。
 *
 * 写了门店词（@XX）的话只试最像的那一家 —— 对方点名要这家，换一家就是下错单。
 *
 * opts：{ addressId（角色上选的收货地址）, addressHint（「你」里的常用地址，用来猜） }
 * @returns {Promise<{target: object, meals: Map}>}
 */
async function targetOf(config, spec, opts, scope) {
  const { orderType, storeHint } = modeOf(spec.store);
  const all =
    orderType === DELIVERY
      ? await deliveryTarget(config, opts, scope)
      : await pickupTarget(config, opts, storeHint, scope);
  const list = all.slice(0, storeHint ? 1 : MAX_TRY_STORES);
  let lastErr = null;
  for (const target of list) {
    try {
      const meals = await orderableMeals(config, target, scope);
      if (meals.size) return { target, meals };
      lastErr = new LuckinError(`${target.shopName}这个时段没有能点的`);
    } catch (e) {
      if (!(e instanceof LuckinError)) throw e;
      lastErr = e;
    }
    logDebug(scope, `${target.shopName}现在点不了（${lastErr.message}），换下一家`);
  }
  const how = orderType === DELIVERY ? "能送到这个地址的" : "能去的";
  throw new LuckinError(
    list.length > 1 ? `${how}麦当劳现在都点不了（${lastErr?.message ?? ""}）` : (lastErr?.message ?? "这家店现在点不了")
  );
}

/**
 * 一整单走到算价：定方式和门店 → 菜单里对名字 → calculate-price。
 * 返回的形状和 luckin.js:draftOrder 一致，imessage.js 那边一套代码管两家的卡片。
 */
export async function draftMcdOrder(config, spec, opts, scope = "麦当劳") {
  if (opts?.claim) await claimMcdCoupons(config, scope);
  const { target, meals } = await targetOf(config, spec, opts ?? {}, scope);
  const coupons = await storeCoupons(config, target, scope);
  const used = new Set();
  const lines = [];
  const missed = [];
  for (const item of spec.items) {
    let best = null;
    for (const [code, m] of meals) {
      const s = nameScore(item.name, m.name);
      if (!best || s > best.s) best = { code, m, s };
    }
    /*
     * 券也当候选：模型照菜单上的「券」写了 `[麦当劳:麦旋风任选]`，就用券点。
     * 同分时券优先（券后价更低）。**一单只能用一张券**（实测两张一起回「暂不支持多张券使用」），
     * 用过一张后面的就按原价对菜单。
     */
    for (const c of used.size ? [] : coupons) {
      const s = nameScore(item.name, c.title);
      if (!best || s >= best.s) best = { code: c.productCode, m: { name: `${c.title}（券）`, price: null }, s, coupon: c };
    }
    if (!best || best.s < 30) {
      missed.push(`现在没有「${item.name}」`);
      continue;
    }
    if (item.specs.length) missed.push(`「${item.name}」的 ${item.specs.join("、")} 改不了（麦当劳的接口不能换套餐里的单品）`);
    if (best.coupon) {
      used.add(best.coupon.couponCode || best.coupon.couponId);
      lines.push({ productCode: best.code, name: best.m.name, spec: "", qty: 1, unitPrice: null, coupon: best.coupon });
      if (item.qty > 1) missed.push(`「${best.coupon.title}」的券只有一张，只点了 1 份`);
    } else {
      lines.push({ productCode: best.code, name: best.m.name, spec: "", qty: item.qty, unitPrice: best.m.price });
    }
  }
  if (!lines.length) throw new LuckinError(missed.join("；") || "一样都没配出来");

  const args = {
    storeCode: target.storeCode,
    orderType: target.orderType,
    beType: target.beType,
    items: lines.map(itemOf),
  };
  if (target.orderType === DELIVERY && target.beCode) args.beCode = target.beCode;
  const p = await call(config, "calculate-price", args, scope);
  /*
   * 到店的取餐方式：实测给两个，第一个是「堂食」（eat-in），第二个才是「外带」（take-in-store）。
   * 角色帮人点的多半是带走的，优先外带，没有再用第一个。
   */
  const ways = Array.isArray(p?.takeWayList) ? p.takeWayList : [];
  const tw = ways.find((w) => /take|外带|自提/i.test(`${w?.code ?? ""}${w?.title ?? ""}`)) ?? ways[0] ?? null;
  // 外送实测会单列配送费（deliveryPrice）和打包费（packingPrice），都是分，都已经算在 price 里

  return {
    ...target,
    lines,
    total: yuanFromFen(p?.price) ?? lines.reduce((s, l) => s + (l.unitPrice ?? 0) * l.qty, 0),
    original: yuanFromFen(p?.originalPrice),
    privilege: yuanFromFen(p?.discount),
    delivery: (yuanFromFen(p?.deliveryPrice) ?? 0) + (yuanFromFen(p?.packingPrice) ?? 0) || null,
    takeWayCode: String(tw?.takeWayCode ?? tw?.code ?? ""),
    remark: spec.remark ?? "",
    missed,
  };
}

/** 按存下来的那份草稿真下单。麦当劳给的是 H5 付款页（https），发成链接卡片点开就能付。 */
export async function placeMcdOrder(config, draft, scope = "麦当劳") {
  const args = {
    storeCode: draft.storeCode,
    orderType: draft.orderType,
    beType: draft.beType,
    items: draft.lines.map(itemOf),
  };
  if (draft.orderType === DELIVERY) {
    if (draft.beCode) args.beCode = draft.beCode;
    args.addressId = draft.addressId;
  } else if (draft.takeWayCode) {
    args.takeWayCode = draft.takeWayCode;
  }
  const field = draft.remark ? await remarkField(config, "mcd", "create-order", scope) : "";
  if (field) args[field] = draft.remark;
  else if (draft.remark) logInfo(scope, `麦当劳的下单接口没有备注这一项，「${draft.remark}」只写在卡片上`);

  const r = await call(config, "create-order", args, scope);
  const orderId = String(r?.orderId ?? r?.orderDetail?.orderId ?? "");
  logInfo(scope, `麦当劳下单成功，订单号 ${orderId || "（没给）"}`);
  return { orderId, remarkSent: Boolean(field), payUrl: String(r?.payH5Url ?? ""), qrUrl: "" };
}

/** 「自动带上菜单」：这家店这个时段能点的，最多列 60 样。缓存 30 分钟。 */
const menuCache = new Map();
export async function autoMcdMenuText(config, opts, mode, scope = "麦当劳") {
  if (opts?.claim) await claimMcdCoupons(config, scope);
  const { target, meals } = await targetOf(config, { store: mode }, opts ?? {}, scope);
  const key = `${target.storeCode}|${target.orderType}`;
  const hit = menuCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.text;
  const rows = [...meals.values()].slice(0, 60).map((m) => `- ${m.name}${m.price !== null ? ` ¥${m.price.toFixed(2)}` : ""}`);
  const how = target.orderType === DELIVERY ? `外送到账号里的地址，由 ${target.shopName} 配送` : `到店：${target.shopName}`;
  const coupons = await storeCoupons(config, target, scope);
  const couponText = coupons.length
    ? `\n对方账号里能在这家用的券（想用就照券名写进 [麦当劳:…]；一单只能用一张券、点一份）：\n${coupons.map((c) => `- ${c.title}`).join("\n")}`
    : "";
  const text =
    (rows.length ? `${how}。现在能点的：\n${rows.join("\n")}` : `${how}，这个时段没查到能点的。`) + couponText;
  menuCache.set(key, { at: Date.now(), text });
  if (!rows.length) logWarn(scope, `${target.shopName} 这个时段没查到能点的`);
  else logInfo(scope, `查好了 ${target.shopName} 的菜单（${rows.length} 样），缓存 30 分钟`);
  return text;
}

/** 平时只注入这一句，聊到吃的才换成完整说明（同 luckin.js:LUCKIN_SHORT_HINT）。 */
export const MCD_SHORT_HINT = "你能帮对方点麦当劳（对方聊到饿了、想吃东西时，完整的写法会告诉你）。想先看看麦当劳现在有什么再挑，就单独写一个 [看菜单:麦当劳]，系统会把菜单拿给你看，看完再回对方。";

/** 聊到吃的那些词。宽一点无所谓：判错的代价只是这一轮多带几百字。 */
const WANT_RE = /麦当劳|麦记|金拱门|汉堡|巨无霸|麦辣|薯条|鸡块|麦乐鸡|麦旋风|板烧|麦满分|鸡翅|饿了|好饿|饿死|吃点|吃啥|吃什么|外卖|夜宵|宵夜/i;

/** 这一轮要不要换上完整说明：最近三句聊到吃的，或者最近几条里刚点过一单。 */
export function mcdWanted(sent) {
  const list = Array.isArray(sent) ? sent : [];
  const text = (m) => (typeof m?.content === "string" ? m.content : "");
  const users = list.filter((m) => m?.role === "user").slice(-3);
  if (users.some((m) => WANT_RE.test(text(m)))) return true;
  return list.slice(-6).some((m) => /[[［]\s*(?:麦当劳|mcd)|麦当劳订单/i.test(text(m)));
}

/** 取消一单（cancel-order）。原因填「改主意了」—— 角色替人取消，说不清具体原因。 */
export async function cancelMcdOrder(config, orderId, scope = "麦当劳") {
  await call(config, "cancel-order", { orderId: String(orderId), cancelReasonCode: "1" }, scope);
  logInfo(scope, `取消了麦当劳订单 ${orderId}`);
}
