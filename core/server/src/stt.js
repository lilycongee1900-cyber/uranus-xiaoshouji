/**
 * 语音转文字（STT）：把一段音频变成一句话。
 *
 * ── 为什么要专门的 STT，而不是继续用多模态模型 ──
 *
 * 原来两条路（iMessage 的语音条、通话）都走 `llm.js:transcribeAudio` ——
 * 把音频塞给 Gemini 那类多模态模型，让它「听」。那条路还留着（它能做
 * 专门的 STT 做不到的事：听出情绪、描述环境音、数说话人），但有两个毛病：
 *
 *  1. **慢**。一次要好几秒，通话里这个代价受不了。
 *  2. **它在"理解"而不是"转写"**。实测它会把一句「Hi」扩写成一份六段式
 *     报告，或者对着静音编出鸟鸣和狗叫（config.js:55 那段注释记了这件事）。
 *
 * 专门的 STT 通常 1 秒内返回，只给原话，而且便宜一个数量级。
 *
 * ── 三家 ──
 *
 * | 家 | 怎么接 | 适合 |
 * |---|---|---|
 * | OpenAI 兼容 | POST /audio/transcriptions，multipart | 最通用，中转站普遍支持 |
 * | 阿里云 Qwen-Audio | OpenAI 兼容的 chat 接口 + 音频 | 中文好，有免费额度 |
 * | 讯飞 | WebSocket + HMAC 签名 | 国内节点，中文最好，延迟最低 |
 *
 * 和 `media.js:pickTtsSource` 一个路子：按顺序挑第一个「开着且凭据齐」的，
 * 都没配就返回 null，调用方退回多模态那条路。
 *
 * ── 凭据全局一份 ──
 *
 * 和 ttsApi 一个待遇：`config.sttApi`，只住密钥文件。转写是「把声音变成字」，
 * 和哪个角色在听无关。
 */

import { logDebug, logInfo, logWarn } from "./logs.js";

const SCOPE = "转写";

/** 一次转写等多久。通话里超过这个数就没有意义了，宁可当没听清。 */
const TIMEOUT_MS = 20_000;

/**
 * 地址规整：去掉首尾空白和末尾斜杠。**空的返回空串**，由调用方 `||` 兜默认值。
 *
 * 单独一个函数是因为这里踩过一次：原来两家都写 `cfg.url ?? "默认地址"`，
 * 而配置里存的是空串（不是 undefined），`??` 不认空串 —— 于是没填地址时
 * 拼出来的是相对路径，fetch 报「Failed to parse URL」。
 */
function trimBase(url) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

/**
 * 挑一家来转写。
 *
 * @param {object} api config.sttApi
 * @returns {{name: string, run: Function}|null} 都没配返回 null
 */
export function pickSttSource(api) {
  const a = api ?? {};
  const has = (v) => Boolean(String(v ?? "").trim());

  if (a.openai?.enabled && has(a.openai.key)) {
    return { name: "OpenAI 兼容", run: (...args) => sttOpenAi(a.openai, ...args) };
  }
  if (a.qwen?.enabled && has(a.qwen.key)) {
    return { name: "Qwen3-ASR", run: (...args) => sttQwen(a.qwen, ...args) };
  }
  if (a.xfyun?.enabled && has(a.xfyun.appId) && has(a.xfyun.apiKey) && has(a.xfyun.apiSecret)) {
    return { name: "讯飞", run: (...args) => sttXfyun(a.xfyun, ...args) };
  }
  return null;
}

/**
 * 转写一段音频。
 *
 * @param {object} api config.sttApi
 * @param {Buffer} audio 音频字节
 * @param {object} [opts]
 * @param {string} [opts.mimeType] 默认 audio/wav
 * @param {string} [opts.language] 语言提示，如 zh / en。空 = 自动
 * @param {string} [opts.scope] 日志里的名字
 * @returns {Promise<{text: string, source: string, ms: number, emotion: string}|null>}
 *   没配任何一家返回 null（调用方据此退回多模态那条路）。`emotion` 只有 Qwen 会给
 *   （happy / sad / angry… 英文小写），别家是空串
 */
export async function transcribe(api, audio, opts = {}) {
  const src = pickSttSource(api);
  if (!src) return null;

  const scope = opts.scope ?? SCOPE;
  const started = Date.now();
  const kb = Math.round(audio.length / 1024);
  logDebug(scope, `${src.name} 开始转写，${kb}KB`);

  /*
   * 语言：调用方指定的优先，否则用全局配置里那个（默认 zh）。
   *
   * 这一条很要紧 —— 不给语言的话 whisper 每段各猜各的，而通话切出来的片段
   * 又短又吵，实测一通中文电话被接连认成冰岛语、韩语、俄语，转写出来是一串
   * 读不通的外文，模型还得对着那串瞎编。
   */
  const withLang = { ...opts, language: opts.language || api?.language || "" };

  try {
    // 多数家只回一段文字；Qwen 还顺带回情绪，回的是 {text, emotion}
    const out = await src.run(audio, withLang);
    const ms = Date.now() - started;
    const clean = String((typeof out === "object" && out ? out.text : out) ?? "").trim();
    const emotion = typeof out === "object" && out ? String(out.emotion ?? "") : "";
    logInfo(
      scope,
      `${src.name} 转写出 ${clean.length} 字，耗时 ${ms}ms${emotion ? `，情绪 ${emotion}` : ""}`,
      clean.slice(0, 120)
    );
    return { text: clean, source: src.name, ms, emotion };
  } catch (e) {
    /*
     * 失败**抛出去**，不静默退回。
     *
     * 调用方（语音条那条路）要据此决定是「告诉对方没听清」还是「退回多模态」。
     * 在这儿吞掉的话，上层看到的是一句空转写，没法区分「真没人说话」和
     * 「转写服务挂了」—— 前者该跳过，后者该告警。
     */
    logWarn(scope, `${src.name} 转写失败`, e);
    throw e;
  }
}

/* ========= OpenAI 兼容（/audio/transcriptions） ========= */

/**
 * 最通用的一条：几乎所有中转站都支持，字段也是事实标准。
 *
 * 要自己拼 multipart —— Node 的 FormData 对 Buffer 支持不好（要包一层 Blob，
 * 而某些中转站对 Blob 生成的 filename 很挑）。手拼几十行，可控得多。
 */
async function sttOpenAi(cfg, audio, opts) {
  // 留空要用 `||` 兜，不能用 `??` —— normalizeSttApi 存的是**空串**而不是
  // undefined，`??` 不认空串，于是 base 成了 ""、fetch 收到一个 "/audio/…"
  // 的相对路径，报一句「Failed to parse URL」。见 sttQwen 那边同样的坑
  const base = trimBase(cfg.url) || "https://api.openai.com/v1";
  const url = `${base}/audio/transcriptions`;
  const model = String(cfg.model ?? "whisper-1").trim() || "whisper-1";

  const boundary = `----uranus${Date.now().toString(36)}`;
  const parts = [];
  const push = (name, value) => {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    );
  };

  push("model", model);
  // 给了语言能快一点、也准一点。空着让它自己判
  if (opts.language) push("language", opts.language);
  /*
   * 只要纯文本。
   *
   * 默认的 json 格式要多解一层，而 verbose_json 会带上一堆时间戳分段 ——
   * 通话里用不上，白白多传。
   */
  push("response_format", "text");
  /*
   * 提示词。用户填了用他的，没填而且说中文的话给一句默认的。
   *
   * 这一句不是摆设：whisper 对中文**默认偏向繁体**（实测「在家裡」），
   * 而它判断字形的依据主要就是 prompt 的字形。给一句简体的话过去，
   * 输出就跟着是简体。顺带也把「这是口语对话」这个先验交给它 ——
   * 比什么都不给要准。
   */
  const hint = String(cfg.prompt ?? "").trim() || defaultSttPrompt(opts.language);
  if (hint) push("prompt", hint.slice(0, 400));

  const mime = opts.mimeType ?? "audio/wav";
  /*
   * 扩展名要和真实格式对上 —— 上游是按 filename 判格式的，对不上会回 400。
   *
   * 注意 **mp3 的标准 MIME 是 `audio/mpeg`**，不含 "mp3" 三个字。iMessage
   * 的语音条过 `toMp3ForStt` 之后正好是这个，只认字面 "mp3" 的话会写成
   * `.wav`，那边解不开。
   */
  const ext = /mpeg|mp3/i.test(mime)
    ? "mp3"
    : /ogg|opus/i.test(mime)
      ? "ogg"
      : /mp4|m4a|aac/i.test(mime)
        ? "m4a"
        : /webm/i.test(mime)
          ? "webm"
          : "wav";
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\n` +
        `Content-Type: ${mime}\r\n\r\n`
    ),
    audio,
    Buffer.from("\r\n")
  );
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${String(cfg.key).trim()}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat(parts),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`转写接口返回 ${res.status}：${text.slice(0, 300)}`);
  }
  // response_format=text 回的就是纯文本，但有的中转站不认这个字段、照回 JSON
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return String(JSON.parse(trimmed).text ?? "");
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/* ========= 阿里云 Qwen3-ASR ========= */

/**
 * 走的是 OpenAI 兼容的 chat 接口，音频用 data URL 塞进 content 里。
 *
 * ── 这个接口**不是**普通的多模态 chat，别照那个写 ──
 *
 * `qwen3-asr-flash` 在阿里云那边是一个「专职任务」（dedicated task `asr`），
 * 请求体的形状被卡得很死，踩过两次：
 *
 *  1. **user 的 content 数组里只许有一条，而且 type 必须是 `input_audio`。**
 *     多塞一条 `{type:"text"}` 的文字指令（想让它"只输出原话"）就会收到
 *     `400 InternalError.Algo.InvalidParameter: The dedicated task 'asr'
 *     corresponding to the current service does not support this input.`
 *     —— 这句话读起来像是音频格式不对，其实骂的是那条文字。
 *     本来也不需要那条指令：专职 ASR 只会转写，不会"回答"音频里的问题。
 *  2. **语言要用顶层的 `asr_options`**，不能写进文字指令里（见上一条）。
 *
 * 另外 system 消息在这儿是**给专有名词用的**（背景文本 / 实体词表），
 * 不是传统的系统提示词，而且必须是第一条。所以「提示词」那一栏填的人名、
 * 地名正好塞这儿。
 *
 * 文档：https://www.alibabacloud.com/help/en/model-studio/qwen-asr-api-reference
 */
async function sttQwen(cfg, audio, opts) {
  /*
   * 地址留空 = 用阿里云官方那个。
   *
   * 这里以前写的是 `cfg.url ?? "https://…"` —— **错的**：normalizeSttApi
   * 存进配置的是空串而不是 undefined（`str(i.qwen?.url).trim()`），而 `??`
   * 只认 null / undefined。于是没填地址时 base 是 ""，fetch 收到的是
   * `"/chat/completions"` 这个相对路径，报一句不知所云的
   * `TypeError: Failed to parse URL from /chat/completions`。
   */
  const base = trimBase(cfg.url) || "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const model = String(cfg.model ?? "qwen3-asr-flash").trim() || "qwen3-asr-flash";
  const mime = opts.mimeType ?? "audio/wav";

  const messages = [];
  /*
   * 专有名词表。只在用户填了「提示词」时才发 —— 这一条必须是第一条，
   * 而且写的该是词表（「Ken、小明、上海」）而不是指令。
   */
  const glossary = String(cfg.prompt ?? "").trim();
  if (glossary) messages.push({ role: "system", content: glossary.slice(0, 400) });
  messages.push({
    role: "user",
    // 只许这一条，而且只许 input_audio —— 多一条就 400，见函数头
    content: [
      {
        type: "input_audio",
        input_audio: { data: `data:${mime};base64,${audio.toString("base64")}` },
      },
    ],
  });

  const body = { model, messages };
  /*
   * 语言走顶层 `asr_options`（curl / REST 就是放顶层的，OpenAI 的 Python SDK
   * 那边叫 extra_body）。留空 = 不发，让它自己判多语种。
   *
   * `enable_itn` 不开：它把「二零二六年」规整成「2026 年」这类，对转写出来
   * 直接进上下文的场合没必要，而且中英之外不支持。
   */
  if (opts.language) body.asr_options = { language: opts.language };

  const call = (payload) =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${String(cfg.key).trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  let res = await call(body);
  let text = await res.text();

  /*
   * 中转站不认 `asr_options` 的话脱掉重打一次。
   *
   * 这个字段不是 OpenAI 标准里的，自建反代和一部分中转站见到不认识的顶层
   * 字段会直接 400。丢掉它只是失去「指定语言」，而 Qwen 自己判语种本来也
   * 不差 —— 比整条转写失败好得多。
   */
  if (!res.ok && res.status === 400 && body.asr_options && /asr_options/i.test(text)) {
    logWarn(opts.scope ?? SCOPE, "这个地址不认 asr_options，去掉语言设置重打一次");
    const { asr_options: _drop, ...rest } = body;
    res = await call(rest);
    text = await res.text();
  }

  if (!res.ok) throw new Error(`Qwen 返回 ${res.status}：${text.slice(0, 300)}`);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Qwen 回的不是 JSON：${text.slice(0, 200)}`);
  }

  const message = data?.choices?.[0]?.message;
  const content = message?.content;
  let said;
  // 文档里写的是数组、示例里回的是字符串，两种都兜住
  if (typeof content === "string") said = content;
  else if (Array.isArray(content)) {
    said = content.map((c) => (typeof c === "string" ? c : (c?.text ?? ""))).join("");
  } else throw new Error("Qwen 回的格式看不懂");

  return { text: said, emotion: qwenEmotion(message) };
}

/**
 * Qwen3-ASR 顺带回的情绪标签。
 *
 * 这家**每次都会给**，不用开、不另收钱：`message.annotations` 里有一条带
 * `emotion` 的（surprised / neutral / happy / sad / disgusted / angry /
 * fearful 七种）。以前只取了 content，这个一直被扔掉。
 *
 * 中转站多半会把 annotations 剥掉，那就是空串 —— 当没听出来，不是错。
 */
function qwenEmotion(message) {
  const list = Array.isArray(message?.annotations) ? message.annotations : [];
  for (const a of list) {
    const e = String(a?.emotion ?? "").trim().toLowerCase();
    if (e) return e;
  }
  return "";
}

/* ========= 讯飞 ========= */

/**
 * 讯飞的「语音听写」。国内节点，中文识别最好，延迟最低。
 *
 * 代价是接起来最麻烦：WebSocket + HMAC-SHA256 签名，而且音频要分帧发。
 * 这里用的是一次性发完（音频已经由 VAD 切成一段了，不需要真流式）。
 *
 * ── 几个要紧的坑 ──
 *
 *  - 签名里的 date 必须是 RFC1123 格式的 GMT 时间，而且服务端只接受
 *    **前后 5 分钟**内的 —— 机器时间不准会一直报鉴权失败。
 *  - 音频必须是 **16kHz 单声道 16bit PCM**（裸流，不带 WAV 头）。
 *    我们这边本来就是这个规格，剥掉 44 字节的头就行。
 *  - 结果是**分片**回来的，要自己按 `pgs`（动态修正）拼。不处理的话
 *    一句话会出现重复的词。
 */
async function sttXfyun(cfg, audio, opts) {
  const host = "iat-api.xfyun.cn";
  const path = "/v2/iat";
  const date = new Date().toUTCString();

  const { createHmac } = await import("node:crypto");
  const origin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
  const sha = createHmac("sha256", String(cfg.apiSecret).trim()).update(origin).digest("base64");
  const auth = Buffer.from(
    `api_key="${String(cfg.apiKey).trim()}", algorithm="hmac-sha256", headers="host date request-line", signature="${sha}"`
  ).toString("base64");

  const url =
    `wss://${host}${path}?authorization=${encodeURIComponent(auth)}` +
    `&date=${encodeURIComponent(date)}&host=${host}`;

  // 剥掉 WAV 头：讯飞要的是裸 PCM
  const pcm = looksLikeWav(audio) ? audio.subarray(44) : audio;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* 已经关了 */ }
      reject(new Error("讯飞转写超时"));
    }, TIMEOUT_MS);

    /** 按 sn 存分片，最后按序号拼 —— pgs=rpl 时要替换掉一段范围内的旧片 */
    const pieces = new Map();

    const done = (fn, arg) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* 已经关了 */ }
      fn(arg);
    };

    ws.addEventListener("open", () => {
      /*
       * 一次性发完。
       *
       * 讯飞支持分帧流式，但我们的音频已经是 VAD 切好的一整段了 —— 分帧只会
       * 增加复杂度，不会更快（整段加起来通常也就几十 KB）。
       */
      const frame = {
        common: { app_id: String(cfg.appId).trim() },
        business: {
          // 讯飞只收它自己那套代码；没列到的（含留空"自动"）都按中文办 ——
          // 它没有「自动」这一档，总得给一个
          language:
            { en: "en_us", ja: "ja_jp", ko: "ko_kr", ru: "ru-ru", fr: "fr_fr", es: "es_es" }[
              String(opts.language ?? "").trim().toLowerCase()
            ] ?? "zh_cn",
          domain: "iat",
          accent: "mandarin",
          // 动态修正：边说边改，结果更准。代价是要处理 pgs 拼接
          dwa: "wpgs",
          // 标点。不要的话一长句读起来很累
          ptt: 1,
        },
        data: { status: 2, format: "audio/L16;rate=16000", encoding: "raw", audio: pcm.toString("base64") },
      };
      ws.send(JSON.stringify(frame));
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.code !== 0) {
        done(reject, new Error(`讯飞返回错误 ${msg.code}：${msg.message ?? ""}`));
        return;
      }

      const result = msg.data?.result;
      if (result) {
        const sn = result.sn;
        // pgs=rpl 表示「替换掉 rg 指定的那几片」
        if (result.pgs === "rpl" && Array.isArray(result.rg)) {
          for (let i = result.rg[0]; i <= result.rg[1]; i += 1) pieces.delete(i);
        }
        const words = (result.ws ?? [])
          .flatMap((w) => (w.cw ?? []).map((c) => c.w ?? ""))
          .join("");
        pieces.set(sn, words);
      }

      if (msg.data?.status === 2) {
        const text = [...pieces.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w).join("");
        done(resolve, text);
      }
    });

    ws.addEventListener("error", () => {
      done(reject, new Error("连不上讯飞（检查网络，以及机器时间是不是准的 —— 签名只接受前后 5 分钟）"));
    });

    ws.addEventListener("close", () => {
      clearTimeout(timer);
    });
  });
}

/**
 * 用户没填提示词时，按语言给一句默认的。
 *
 * **只有中文给**，而且只为了一件事：让它输出简体。whisper 认中文时默认偏
 * 繁体（实测把「在家里」转成「在家裡」），而它判断用哪种字形主要看 prompt
 * 里的字形 —— 给一句简体的过去，输出就跟着简体。
 *
 * 句子本身写成「平常说话的样子」也顺带把「这是口语对话、不是朗读」这个
 * 先验交给它。别写得太长太具体：prompt 会被当成上文，写进具体词汇反而会
 * 让它把那些词硬塞进转写结果。
 *
 * 别的语言不给：英文那些本来就没有字形问题，瞎给一句只会引入偏见。
 */
function defaultSttPrompt(code) {
  const c = String(code ?? "").trim().toLowerCase();
  if (c === "zh") return "以下是一段普通话对话，请用简体中文转写。";
  if (c === "yue") return "以下是一段粤语对话，请用简体中文转写。";
  return "";
}

/** 这段字节是不是 WAV（看 RIFF 头）。 */
function looksLikeWav(buf) {
  return buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE";
}
