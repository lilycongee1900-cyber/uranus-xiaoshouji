/**
 * 「Uranus 去连节点」：Uranus 主动用 WebSocket 连到通话节点，节点的请求从这条
 * 连接里送过来。
 *
 * ── 为什么要这条路 ──
 *
 * 默认是节点来连 Uranus，那要求 Uranus 有一个节点够得着的地址。Uranus 跑在
 * **安卓手机**或者**家里的电脑**上时没有：它在路由器后面，放在 VPS 上的节点
 * 连不进来。反过来就通了 —— 节点在 VPS 上开个端口，Uranus 连出去。
 *
 * ── 节点那边看到的是什么 ──
 *
 * 一模一样的 HTTP。节点发来的每条 {"type":"req"} 就是一个原封不动的请求
 * （送一段话、报状态、挂控制通道……），这里把它**原样交给自己的那几条路由**
 * （callapi.js），再把响应一块一块送回去。所以 callapi.js、handleCallTurn、
 * 密钥校验全都不知道有隧道这回事，一行没改。
 *
 * 协议细节见节点那边的 facetime-node/src/tunnel.mjs 文件头，两边必须一致。
 *
 * ── 请求怎么交给自己的路由 ──
 *
 * 默认是 fetch 本机的 http://127.0.0.1:<端口>。小手机（Cloudflare Worker）上
 * 没有真的端口，Worker 那边在 globalThis.__uranusLocalDispatch 上挂一个
 * 「把 Request 递进 express」的函数，这里优先用它。
 */

import { logDebug, logInfo, logWarn } from "./logs.js";

const SCOPE = "通话";

/** 重连退避：刚断时多半马上能连上，一直连不上就别猛打。 */
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/** 现在这条隧道。 */
let state = {
  /** 当前目标（url + secret），用来判断配置改了没有 */
  target: "",
  ws: null,
  timer: null,
  delay: RETRY_MIN_MS,
  /** 正在转的请求：id → AbortController */
  inflight: new Map(),
  connected: false,
  lastError: "",
};

/** 启动时由 index.js 填：本机端口、配置读取函数。 */
let options = { port: 8787, loadConfig: null, dispatch: null };

/**
 * 按当前配置把隧道对齐：该连就连、该断就断、地址或密钥变了就重连。
 *
 * 启动时和每次保存配置后各调一次。只在真的要变时才动，保存别的配置不会把
 * 隧道断了重来。
 *
 * @param {object} [opts]
 * @param {Function} [opts.loadConfig]
 * @param {number} [opts.port] Uranus 自己的端口
 * @param {(req: Request) => Promise<Response>} [opts.dispatch] 测试用：换掉「交给自己的路由」那一步
 */
export function syncCallTunnel(opts = {}) {
  options = { ...options, ...opts };
  const cfg = options.loadConfig?.()?.callNode ?? {};
  const want =
    cfg.enabled && cfg.direction === "uranus" && cfg.url && cfg.secret
      ? `${cfg.url}\n${cfg.secret}`
      : "";

  if (want === state.target) return;
  stopCallTunnel();
  state.target = want;
  if (!want) return;

  state.delay = RETRY_MIN_MS;
  connect();
}

/** 断掉，不再重连。 */
export function stopCallTunnel() {
  clearTimeout(state.timer);
  state.timer = null;
  const ws = state.ws;
  state.ws = null;
  state.target = "";
  state.connected = false;
  state.lastError = "";
  if (ws) {
    try {
      ws.close();
    } catch {
      // 已经断了
    }
  }
  abortAll();
}

/** 控制台要看的状态。 */
export function callTunnelStatus() {
  return { active: Boolean(state.target), connected: state.connected, error: state.lastError };
}

/* ───────────────────────── 内部 ───────────────────────── */

/** http(s)://节点:端口 → ws(s)://节点:端口/tunnel?secret=… */
export function tunnelUrl(base, secret) {
  const u = new URL(String(base).replace(/\/+$/, "") + "/tunnel");
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("secret", secret);
  return u.toString();
}

function connect() {
  const target = state.target;
  if (!target) return;
  const [base, secret] = target.split("\n");

  let ws;
  try {
    ws = new WebSocket(tunnelUrl(base, secret));
  } catch (e) {
    fail(`节点地址不对：${e?.message ?? e}`);
    return;
  }
  state.ws = ws;

  ws.addEventListener("open", () => {
    if (state.ws !== ws) return;
    state.connected = true;
    state.lastError = "";
    state.delay = RETRY_MIN_MS;
    logInfo(SCOPE, `连上通话节点了（${base}）`);
  });

  ws.addEventListener("message", (ev) => {
    if (state.ws !== ws) return;
    onMessage(ws, typeof ev.data === "string" ? ev.data : String(ev.data));
  });

  const onGone = (why) => {
    if (state.ws !== ws) return;
    state.ws = null;
    const was = state.connected;
    state.connected = false;
    // 正在转的请求都掐掉：本机那条控制通道一断，callapi 会把节点标成离线、
    // 把进行中的通话收尾 —— 和节点自己掉线是同一条路
    abortAll();
    if (was) logWarn(SCOPE, `和通话节点的连接断了（${why}），等会儿重连`);
    fail(why);
  };
  ws.addEventListener("close", (ev) => onGone(ev?.code ? `关闭码 ${ev.code}` : "断开"));
  ws.addEventListener("error", () => onGone("连不上"));
}

/** 记下原因，排一次重连。 */
function fail(why) {
  state.lastError = why;
  if (!state.target || state.timer) return;
  const wait = state.delay;
  state.delay = Math.min(state.delay * 2, RETRY_MAX_MS);
  logDebug(SCOPE, `${Math.round(wait / 1000)} 秒后重连通话节点（${why}）`);
  state.timer = setTimeout(() => {
    state.timer = null;
    connect();
  }, wait);
}

function abortAll() {
  for (const ctl of state.inflight.values()) {
    try {
      ctl.abort();
    } catch {
      // 已经结束了
    }
  }
  state.inflight.clear();
}

function onMessage(ws, text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }

  if (msg.type === "ping") return send(ws, { type: "pong" });
  if (msg.type === "hello") return;
  if (msg.type === "cancel") {
    state.inflight.get(String(msg.id))?.abort();
    state.inflight.delete(String(msg.id));
    return;
  }
  if (msg.type === "req") void relay(ws, msg);
}

function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

/**
 * 只放行节点那几个口子。
 *
 * 隧道是节点发起请求的通道，它只该碰得到 /facetime/*。不挡的话，节点（或者
 * 抢了那个端口的什么东西）能借这条路调 Uranus 的任何接口 —— 包括 /api/ 下面
 * 那些本该要登录的。本机 fetch 进来的请求来源是回环，那道门挡不住它。
 */
function allowed(path) {
  return /^\/facetime\/[a-z]+(\?|$)/.test(String(path));
}

/** 把一个请求交给自己的路由，响应一块一块送回节点。 */
async function relay(ws, msg) {
  const id = String(msg.id);
  if (!allowed(msg.path)) {
    logWarn(SCOPE, `通话节点想通过隧道访问 ${String(msg.path).slice(0, 60)}，不让`);
    send(ws, { id, status: 403, headers: { "content-type": "application/json" } });
    send(ws, { id, chunk: Buffer.from('{"ok":false,"error":"隧道只通节点那几个口子"}').toString("base64") });
    send(ws, { id, end: true });
    return;
  }

  const ctl = new AbortController();
  state.inflight.set(id, ctl);
  try {
    const method = String(msg.method ?? "GET").toUpperCase();
    const body = method === "GET" || method === "HEAD" ? undefined : Buffer.from(msg.body ?? "", "base64");
    /*
     * 打上「经过转发」的记号。
     *
     * 转进来的请求是从 127.0.0.1 发给自己的，不打记号的话 callapi.js 会把它当成
     * 本机的节点 ——「本机的节点不用配对码」那条就放它过去了，密钥一眼都不看。
     * 带上 X-Forwarded-For，isLoopback 就当它是外面来的，照旧校验密钥
     * （隧道这条路上节点一定有密钥，见 facetime-node/src/index.mjs）。
     */
    const headers = { ...(msg.headers ?? {}), "x-forwarded-for": "call-tunnel" };
    const req = new Request(`http://127.0.0.1:${options.port}${msg.path}`, {
      method,
      headers,
      body,
      signal: ctl.signal,
    });

    const dispatch =
      options.dispatch ?? globalThis.__uranusLocalDispatch ?? ((r) => fetch(r));
    const res = await dispatch(req);

    const outHeaders = {};
    const type = res.headers.get("content-type");
    if (type) outHeaders["content-type"] = type;
    send(ws, { id, status: res.status, headers: outHeaders });

    if (res.body) {
      const reader = res.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value?.length && !send(ws, { id, chunk: Buffer.from(value).toString("base64") })) {
          ctl.abort();
          break;
        }
      }
    }
    send(ws, { id, end: true });
  } catch (e) {
    if (!ctl.signal.aborted) {
      logDebug(SCOPE, `隧道里转一个请求失败：${msg.path}`, e);
      send(ws, { id, error: String(e?.message ?? e) });
    }
  } finally {
    state.inflight.delete(id);
  }
}

/** 测试用。 */
export function resetCallTunnelForTest() {
  stopCallTunnel();
  options = { port: 8787, loadConfig: null, dispatch: null };
}
