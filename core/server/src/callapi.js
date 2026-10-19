/**
 * 通话节点那三个口子，以及控制台要看的通话状态。
 *
 * ── 为什么节点那几条路径不带 /api/ 前缀 ──
 *
 * `index.js:538` 那个鉴权中间件只管 `/api/` 开头的路径，别的一律放过。节点是
 * 一个**跑在别的机器上的程序**，没有浏览器的 cookie，走不了那套登录 —— 所以
 * 和共感娃娃的 `/doll/hug`（`index.js:1564`）、查岗的 `/phone/screenshot`
 * 一个路子：路径不带 `/api/`，改用预共享密钥。
 *
 * 控制台那两条照常在 `/api/` 下面，跟着登录走。
 *
 * ── 三个口子分别干什么 ──
 *
 *   GET  /facetime/stream     节点挂一条 SSE 上来，等 Uranus 下发指令
 *   POST /facetime/utterance  节点送一段话的 WAV，**响应是流式的**：
 *                             一句一句回「文本 + 合成好的音频」
 *   POST /facetime/event      节点报状态：入会成功、对方挂断、出错
 *
 * 主循环是中间那条。控制通道（SSE）只用来下发节点自己发起不了的事 ——
 * 入会、挂断、静默提醒那条主动开口。
 *
 * ── 为什么是 SSE 不是 WebSocket ──
 *
 * 这个仓库里一个 WebSocket 都没有，实时全靠 SSE（`index.js:1150` 那条日志流）。
 * 不为一个功能引一套新机制。而且 SSE 这边只下发寥寥几条指令，用不着双向。
 */

import { getCall, callStatus, endCall, touchNode } from "./callsession.js";
import { clearCallLog, readCallLog } from "./calllog.js";
import { callTunnelStatus } from "./calltunnel.js";
import { logDebug, logInfo, logWarn } from "./logs.js";

const SCOPE = "通话";

/** 节点那几条路径。不带 /api/ 前缀，故意的，见文件头。 */
export const NODE_PATHS = {
  stream: "/facetime/stream",
  utterance: "/facetime/utterance",
  event: "/facetime/event",
  avatar: "/facetime/avatar",
  frame: "/facetime/frame",
};

/** 一次最多收多大的音频。16kHz 单声道 WAV，30 秒约 1MB，给到 4MB 很宽裕。 */
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

/** 一帧最大多大。640px 的 JPEG 一般三五十 KB。和 callturn.js:MAX_FRAME_BYTES 一致（不 import 它：那边拖着整条模型链路）。 */
const MAX_FRAME_BYTES = 1024 * 1024;

/** 挂在上面的那个节点。一次只有一个。 */
let node = null; // { res, at, ip }

/**
 * 给节点下发一条指令。
 *
 * @returns {boolean} 节点在不在线
 */
export function sendToNode(type, payload = {}) {
  if (!node) return false;
  try {
    node.res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
    logDebug(SCOPE, `给节点发了「${type}」`);
    return true;
  } catch (e) {
    logWarn(SCOPE, "给节点发指令失败，当它掉线了", e);
    node = null;
    return false;
  }
}

/** 节点在线吗。 */
export function nodeOnline() {
  return Boolean(node);
}

/**
 * 挂上这几条路由。
 *
 * @param {import("express").Express} app
 * @param {() => object} loadConfig
 * @param {object} hooks 由 index.js 把 imessage.js 那边的函数传进来 ——
 *   这个文件不 import imessage.js（那边 8000 多行，而且会绕回来 import 配置）
 */
export function mountCall(app, loadConfig, hooks = {}) {
  /** 密钥对不对。对不上就把响应写好并返回 false。 */
  const checkSecret = (req, res) => {
    const cfg = loadConfig()?.callNode ?? {};
    const want = String(cfg.secret ?? "").trim();

    if (!cfg.enabled) {
      /*
       * 回 404 而不是 403：别告诉扫端口的人这儿有东西。
       * 但**日志里要说明白** —— 节点那头只看得到一个 404，而 404 既可能是
       * 「地址填错了」也可能是「功能没开」，不说的话用户只能干瞪眼。
       * 这条和 doll 那边（index.js:1570 附近）是同一个处理。
       */
      logWarn(SCOPE, "有节点来连，但通话功能没开 —— 回了 404");
      res.status(404).end();
      return false;
    }

    /*
     * ── 本机的节点不用配对码 ──
     *
     * 回环地址直连进来的放行，不看密钥。**外面来的照旧要密钥** —— 这是
     * 「多一条路」，不是「换一条路」：已经配对过的远程节点一点不受影响。
     *
     * 第一版写成了「开着就只收本机、外面来的密钥对了也拒」，那会把已经
     * 用配对码连着的节点（配对码里的地址常常是公网 IP，同机连自己的公网
     * IP 来源也不是回环）一更新就踢掉。改成现在这样，不会有人因为升级断线。
     *
     * 为什么敢对回环放行：回环在这儿不是一道真的防线。能在这台机器上跑
     * 进程的人直接读 data.config.json 就拿到了全部 API 密钥，比插进一通电话
     * 严重得多。为一个挡不住任何东西的边界，让每个本机用户都走一遍生成
     * 密钥、复制、粘贴，不划算。经过反代的请求不算回环，见 isLoopback。
     */
    if (cfg.trustLocal !== false && isLoopback(req)) return true;

    if (!want) {
      /*
       * 没设密钥、又不是本机直连来的。回 404 的理由同上（别暴露这儿有东西），
       * 日志说清楚是哪种情况 —— 「节点在别的机器上却没配对」和「本机的被
       * 当成外部（多半是填了局域网 IP 或者经过了反代）」修法完全不同。
       */
      logWarn(
        SCOPE,
        cfg.trustLocal !== false
          ? `有节点从 ${remoteOf(req)} 来连，不是本机直连、又还没设配对密钥 —— 回了 404。` +
              "节点在别的机器上的话去生成一串配对码；在本机的话，节点的 config.json 里 uranus 要填 http://127.0.0.1:8787"
          : "有节点来连，但「本机的节点不用配对码」关着、又还没设配对密钥 —— 回了 404"
      );
      res.status(404).end();
      return false;
    }

    const got = String(req.query?.secret ?? req.get("x-call-secret") ?? "").trim();
    if (got !== want) {
      logWarn(SCOPE, "有节点来连，但配对密钥不对");
      res.status(403).json({ ok: false, error: "配对密钥不对" });
      return false;
    }
    return true;
  };

  /* ── 控制通道：节点挂一条 SSE 上来 ───────────────────────── */

  app.get(NODE_PATHS.stream, (req, res) => {
    if (!checkSecret(req, res)) return;

    // 已经有一个节点挂着的话，把旧的踢掉 —— 多半是它掉线了又重连
    if (node) {
      logInfo(SCOPE, "又来了一个节点，把旧的那条连接关掉");
      try {
        node.res.end();
      } catch {
        // 已经断了，无所谓
      }
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // 反代（Nginx）默认会缓冲 SSE，这个头让它别缓冲 —— 和日志流那条一样
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    node = { res, at: Date.now(), ip: req.ip };
    logInfo(SCOPE, `通话节点连上来了（${req.ip}）`);
    res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);

    // 25 秒一次心跳，别让中间的代理掐掉这条长连接
    const beat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(beat);
      }
    }, 25_000);

    req.on("close", () => {
      clearInterval(beat);
      if (node?.res === res) {
        node = null;
        logInfo(SCOPE, "通话节点断开了");
        /*
         * 节点没了，正在进行的通话也就没了 —— 浏览器是它那边起的。
         * 不收尾的话这通电话会一直挂着，之后所有来电都被「一次只能一通」挡掉。
         */
        const call = getCall();
        if (call) {
          logWarn(SCOPE, "节点断开时还有一通电话在进行，按挂断处理");
          void hooks.onCallEnded?.(endCall("节点断开了"));
        }
      }
    });
  });

  /* ── 主循环：节点送一段话，流式拿回角色的回答 ─────────────── */

  app.post(
    NODE_PATHS.utterance,
    // 自收原始字节。全局那个 express.json 挂在 index.js:725，比这儿靠后，
    // 所以这里拿到的是未解析的流
    (req, res, next) => {
      if (!checkSecret(req, res)) return;
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_AUDIO_BYTES) {
          res.status(413).json({ ok: false, error: "这段音频太大了" });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        req.rawAudio = Buffer.concat(chunks);
        next();
      });
      req.on("error", () => res.status(400).end());
    },
    async (req, res) => {
      touchNode();
      const call = getCall();
      if (!call) {
        return res.status(409).json({ ok: false, error: "现在没有正在进行的通话" });
      }

      /*
       * 响应是**流式的**：一句一句往回写，节点收到一句就播一句。
       *
       * 格式和这个仓库里别的 SSE 一致（`client/src/store.jsx:73` 那个 apiStream
       * 解的就是这个），所以前端以后要复用也不用另写解析。
       */
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      const send = (type, data) => {
        try {
          res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
        } catch (e) {
          logDebug(SCOPE, "往回写的时候断了", e);
        }
      };

      try {
        await hooks.onUtterance?.({
          audio: req.rawAudio,
          kind: String(req.query?.kind ?? "said"),
          seconds: Number(req.query?.seconds ?? 0),
          send,
        });
        send("done", {});
      } catch (e) {
        logWarn(SCOPE, "这一轮没答上来", e);
        send("error", { error: String(e?.message ?? e) });
      } finally {
        res.end();
      }
    }
  );

  /* ── 头像：节点入会前来拿 ────────────────────────────────── */

  /**
   * 角色的头像。
   *
   * 节点入会时来取，取不到就用它自己画的占位图（深色底 + 角色名）。
   *
   * 为什么让节点来拿、而不是让用户往节点目录里拷一张：头像 Uranus 这边
   * 本来就有（线下模式那栏配的），让用户再传一次是白费事，而且换头像还要
   * 记得两边都换。
   */
  app.get(NODE_PATHS.avatar, async (req, res) => {
    if (!checkSecret(req, res)) return;

    const call = getCall();
    const roleId = String(req.query?.roleId ?? call?.roleId ?? "");
    const role = (loadConfig()?.roles ?? []).find((r) => r.id === roleId);
    const name = String(role?.offline?.avatar ?? "").trim();

    if (!name) {
      // 没配头像不是错，节点会退回占位图
      return res.status(404).json({ ok: false, error: "这个角色没配头像" });
    }

    try {
      const { readFileSync } = await import("node:fs");
      const { join, basename } = await import("node:path");
      const { OFFLINE_MEDIA_DIR } = await import("./datadir.js");
      // basename 挡掉 ../ 那类路径穿越 —— 这个字段是从配置读的，但配置也可能被手改
      const file = join(OFFLINE_MEDIA_DIR, basename(name));
      const bytes = readFileSync(file);
      res.setHeader("Content-Type", guessImageMime(name));
      res.setHeader("Cache-Control", "no-store");
      res.end(bytes);
    } catch (e) {
      logWarn(SCOPE, `头像读不出来（${name}），节点会用占位图`, e);
      res.status(404).json({ ok: false, error: "头像文件读不出来" });
    }
  });

  /* ── 摄像头：节点截一帧送过来 ────────────────────────────── */

  /**
   * 对方一开口，节点就从 FaceTime 的视频里截一帧（640px JPEG，base64 放 JSON 里），
   * 或者报一句「摄像头关着」。**立刻回**，识图在后台跑 —— 见 callturn.js:seeFrame。
   *
   * 老版本的 Uranus 没有这条路，节点收到 404 就不再送了（这通电话里）。
   */
  app.post(NODE_PATHS.frame, (req, res) => {
    if (!checkSecret(req, res)) return;
    touchNode();
    const body = req.body ?? {};
    const jpeg = String(body.jpeg ?? "");
    // base64 比原始字节大三分之一
    if (jpeg.length > (MAX_FRAME_BYTES * 4) / 3 + 16) {
      return res.status(413).json({ ok: false, error: "这一帧太大了" });
    }
    try {
      hooks.onFrame?.({ off: Boolean(body.off), jpeg });
    } catch (e) {
      logDebug(SCOPE, "处理这一帧时出错", e);
    }
    res.json({ ok: true });
  });

  /* ── 节点报状态 ──────────────────────────────────────────── */

  app.post(NODE_PATHS.event, async (req, res) => {
    if (!checkSecret(req, res)) return;
    touchNode();

    const body = req.body ?? {};
    const type = String(body.type ?? "");
    logInfo(SCOPE, `节点报告：${type}${body.reason ? `（${body.reason}）` : ""}`);

    try {
      await hooks.onEvent?.(type, body);
      res.json({ ok: true });
    } catch (e) {
      logWarn(SCOPE, `处理「${type}」时出错`, e);
      res.status(400).json({ ok: false, error: String(e?.message ?? e) });
    }
  });

  /* ── 控制台：看状态、手动挂断 ─────────────────────────────── */

  app.get("/api/call/status", (req, res) => {
    const cfg = loadConfig()?.callNode ?? {};
    res.json({
      ok: true,
      // 不回配对密钥。前端要显示「配好了没有」，给个布尔值就够了
      node: {
        enabled: Boolean(cfg.enabled),
        direction: cfg.direction ?? "node",
        hasSecret: Boolean(String(cfg.secret ?? "").trim()),
        // 本机的节点不用密钥 —— 前端据此决定要不要提示「还没生成配对密钥」
        trustLocal: cfg.trustLocal !== false,
        url: cfg.direction === "uranus" ? String(cfg.url ?? "") : "",
        online: nodeOnline(),
        // 「Uranus 去连节点」那条隧道连上没有、没连上的话卡在哪
        tunnel: callTunnelStatus(),
      },
      call: callStatus(),
      // 最近通话。状态和记录一起回，界面上那一栏只打一次接口
      recent: readCallLog().slice(0, 20),
    });
  });

  app.post("/api/call/hangup", async (req, res) => {
    const call = getCall();
    if (!call) return res.json({ ok: true, call: { active: false } });

    /*
     * 控制台手动挂断**不 drain** —— 人点这个按钮就是要它立刻停下来
     * （角色自己写 `[结束通话]` 那条才等它把话说完，见 call.mjs:hangUp）。
     */
    sendToNode("hangup", { reason: "控制台挂断" });
    await hooks.onCallEnded?.(endCall("控制台挂断"));
    res.json({ ok: true, call: callStatus(), recent: readCallLog().slice(0, 20) });
  });

  app.post("/api/call/log/clear", (req, res) => {
    const ok = clearCallLog();
    res.status(ok ? 200 : 500).json({ ok, recent: readCallLog() });
  });
}

/**
 * 这个请求是从哪个地址来的。日志和回环判断共用。
 *
 * 看 socket 上的地址，不看 `req.ip` —— 后者在开了 Express 的 trust proxy
 * 之后会改读 X-Forwarded-For，那是谁都能伪造的。现在没开，但别让本机模式
 * 的安全性取决于一个别处的开关。
 */
function remoteOf(req) {
  return String(req?.socket?.remoteAddress ?? req?.ip ?? "");
}

/**
 * 这个请求是不是从本机来的。
 *
 * 要认三种写法：IPv4 的 `127.0.0.0/8`、IPv6 的 `::1`，以及 Node 在双栈
 * 监听下给的 IPv4 映射地址 `::ffff:127.0.0.1`（**最常见的就是这个**，
 * 日志里那些 `::ffff:…` 就是它）。
 *
 * 故意**不**走 `req.ips` / `X-Forwarded-For`：那是反代填的，谁都能伪造。
 * 这里要的是「TCP 连接真的来自本机」，只能看 socket 上那个地址。
 * 反代后面跑 Uranus 又想用本机模式的话，反代和节点本来也都在本机。
 */
function isLoopback(req) {
  /*
   * ── 经过反代的一律不算本机 ──
   *
   * VPS 上常见的部署是 nginx / Caddy 在前面、Uranus 在 127.0.0.1 后面。
   * 那样**外网来的每个请求**到了 Uranus 这儿，socket 地址都是 127.0.0.1 ——
   * 只看地址的话，本机模式等于对整个公网敞开。
   *
   * 反代一定会带转发头（不带的反代几乎不存在，而且它自己的日志也要用），
   * 本机节点直连则一个都不带。所以见到任何转发头就当外部请求处理，
   * 不管它声称自己来自哪里 —— 这里只拿它当「有没有经过反代」的信号，
   * 不信它的内容。
   */
  const h = req?.headers ?? {};
  if (h["x-forwarded-for"] || h["x-real-ip"] || h["forwarded"] || h["x-forwarded-host"]) {
    return false;
  }

  /*
   * ── 浏览器发来的也不算 ──
   *
   * 回环还有第二个口子：这台机器上开着的**任何网页**都能往 127.0.0.1:8787
   * 发请求（CSRF），DNS 重绑定也是同一个路子。来源地址照样是回环。
   *
   * 节点用的是 Node 自带的 fetch，实测它**不带** Origin、也不带
   * Sec-Fetch-Site；浏览器对跨源请求一定带 Origin，对 localhost 一定带
   * Sec-Fetch-*Site*。所以见到这两个就当外部请求 —— 它照样能用配对密钥进来，
   * 只是不能白嫖本机这条路。
   *
   * Host 也查一下：DNS 重绑定时浏览器认为是同源（可能不带 Origin），但 Host
   * 是攻击者的域名，不是 127.0.0.1 / localhost。
   */
  if (h["origin"] || h["sec-fetch-site"]) return false;
  const host = String(h["host"] ?? "")
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  /*
   * **必须认完整的 IPv4 字面量**，不能只看「127.」前缀：
   * `127.0.0.1.evil.example` 是个合法域名，恰恰就是 DNS 重绑定会用的那种
   * 名字。前缀匹配会把它放进来，这道检查就白做了。
   */
  if (host && host !== "localhost" && host !== "::1" && !LOOPBACK_V4.test(host)) return false;

  const raw = remoteOf(req);
  if (!raw) return false;
  // 去掉 IPv6 映射前缀和可能带的 zone id（fe80::1%eth0 那种）
  const ip = raw.replace(/^::ffff:/i, "").split("%")[0];
  if (ip === "::1") return true;
  return LOOPBACK_V4.test(ip);
}

/** 127.0.0.0/8 的完整字面量。只认四段数字，见 isLoopback 里的说明。 */
const LOOPBACK_V4 = /^127(\.\d{1,3}){3}$/;

/** 测试用。 */
export function resetNodeForTest() {
  node = null;
}

/** 按扩展名猜图片类型。猜不出来当 png —— 浏览器自己也会嗅探。 */
function guessImageMime(name) {
  const ext = String(name).toLowerCase().split(".").pop();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
}
