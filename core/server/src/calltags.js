/**
 * 通话里那几个方括号标记的解析，以及「哪些字该念出来、哪些不该」。
 *
 * 整个文件是**纯函数**：不读配置、不打网络、不看时钟。所以能离线跑断言 ——
 * 这是最该被测到的一块，因为一旦漏剥一个标记，用户听到的就是角色一本正经地
 * 念出「transfer 冒号 4000 冒号 零花钱」。
 *
 * ── 四个接听相关的标记 ──
 *
 * `[接受通话]` / `[拒绝通话]`：收到 FaceTime 邀请时，由角色自己决定接不接。
 * `[结束通话]`：通话中角色主动挂断。
 *
 * 这几个和媒体标记不一样 —— 它们是**指令**，不但不能念出来，连正文都不该留下
 * 痕迹。所以剥的时候连同周围多余的空行一起收拾干净。
 */

/** 角色对一通来电的答复。 */
export const ANSWER = { accept: "accept", reject: "reject", none: "none" };

/**
 * 从一条消息里找出 FaceTime 链接。
 *
 * ── 井号后面那段必须带着 ──
 *
 * 入会的密钥在 `#` 后面（`#v=1&p=…&k=…`）。那一段**从来不发给服务器**，是纯粹
 * 的客户端片段 —— 所以少了它就是一条进不去的链接，而且不会报错，只会在入会时
 * 卡住。实测 Photon 收到的是完整网址（含片段），这里再挡一道：没有 `#` 的
 * 一律当没找到，免得白开一次浏览器。
 *
 * @param {string} text 对方发来的消息原文
 * @returns {string} 链接，没找到返回空串
 */
export function findFaceTimeLink(text) {
  const raw = String(text ?? "");
  if (!/facetime\.apple\.com/i.test(raw)) return "";

  // 片段里有 + / = 这些字符，所以不能用 \w；按「空白和中文括号为止」截
  const m = raw.match(/https?:\/\/facetime\.apple\.com\/join#[^\s<>「」【】()（）]+/i);
  if (!m) return "";

  const link = m[0].replace(/[.,;:!?。，；：！？]+$/, "");
  // 片段里至少要有那个 k=（密钥），否则进不去
  if (!/[#&]k=/i.test(link)) return "";
  return link;
}

/** 这条消息是不是一通 FaceTime 邀请。 */
export function isFaceTimeInvite(text) {
  return Boolean(findFaceTimeLink(text));
}

/**
 * 推给模型的那条邀请。
 *
 * 第一句是用户钉死的措辞 —— 别改写。关键是**让角色自己决定接不接**：它正在忙、
 * 在生气、在开车，完全可以不接，这一句比什么都有「活人感」。
 *
 * ── 第二句：顺便把开场白写了 ──
 *
 * 接通要十几秒，而这一轮模型早就跑完了。让它在**同一轮**里把接通后要说的
 * 第一句话一起写出来，接通的瞬间就能直接播 —— 省掉一整轮模型（实测那一轮
 * 要 8 到 25 秒，对方接起来先听一片沉默，很假）。
 *
 * 写「电话里要说的」而不是「要发的短信」是因为这段话**不发短信、只念出来**
 * （见 imessage.js 里接电话那个分支）。措辞上刻意不提「语音」二字 ——
 * 角色不需要知道实现，它只需要知道这是打电话时要说的话。
 */
export function inviteNotice(userName = "{{user}}") {
  return (
    `[${userName}向你发起Facetime通话邀请，回复[接受通话]即可进入通话，` +
    `[拒绝通话]则会拒绝，请按照人设来进行回应，不要ooc]\n` +
    `[如果接，就在[接受通话]后面紧接着写下电话接通时你要说的第一句话` +
    `（这句话会在电话里说出来，不会以短信发出，所以别写括号动作、别写旁白）；` +
    `不想一开口就说话也可以只写[接受通话]]`
  );
}

/**
 * 通话中每条用户消息前面那个前缀。
 *
 * 带上**已接通多久**而不是干巴巴一句「通话中」—— 模型据此知道聊了多久了、
 * 该不该收尾，也知道这段是打电话说的，不会和发短信的上下文串掉。
 *
 * @param {string} duration 已经排好版的时长，见 callsession.js:sayDuration
 */
export function callPrefix(duration) {
  return `[Facetime已接通 ${duration}]`;
}

/**
 * 通话中对方在 iMessage 里发来消息时的前缀。
 *
 * 不方便说话时打字 —— 你打字、角色用语音回你。
 */
export function typedPrefix(userName = "{{user}}") {
  return `[${userName}在imessage发来的信息]`;
}

/**
 * 对方好一阵没说话时推给模型的那条。
 *
 * **不替模型下结论**说「他关麦了」—— 静音检测会误判（对方可能只是在想事情、
 * 在找东西），所以把现象原样交出去，让角色按人设自己判断。措辞是用户定的。
 */
export function silenceNotice(seconds, userName = "{{user}}") {
  return (
    `[${userName}已经${seconds}秒没有说话了，可能是关闭了麦克风，` +
    `请根据人设以及上下文作出回应]`
  );
}

/** 被打断时告诉模型它实际说出口了什么。 */
export function interruptedNotice(said, dropped, userName = "{{user}}") {
  const heard = said.length ? `对方只听到了你说的「${said.join("")}」` : "对方还没听到你说的话";
  return `[${userName}插话打断了你，${heard}，后面${dropped}句没说出口]`;
}

const ACCEPT_RE = /\[\s*接受通话\s*\]/g;
const REJECT_RE = /\[\s*拒绝通话\s*\]/g;
const HANGUP_RE = /\[\s*结束通话\s*\]/g;

/**
 * 角色接不接这通电话。
 *
 * 两个都写了算**接** —— 模型偶尔会把两个选项都复述一遍（「要么[接受通话]要么
 * [拒绝通话]」），这种情况下按「接」处理：接错了用户挂掉就是，拒错了他得重新
 * 发一次链接。
 *
 * @param {string} text 模型这一轮的回复
 * @returns {{answer: string, text: string}} 答复 + 剥掉标记之后的正文
 */
export function readAnswer(text) {
  const raw = String(text ?? "");
  const accept = ACCEPT_RE.test(raw);
  ACCEPT_RE.lastIndex = 0;
  const reject = REJECT_RE.test(raw);
  REJECT_RE.lastIndex = 0;

  let answer = ANSWER.none;
  if (accept) answer = ANSWER.accept;
  else if (reject) answer = ANSWER.reject;

  return { answer, text: stripCallTags(raw) };
}

/**
 * 角色要挂断吗。
 *
 * @returns {{hangUp: boolean, text: string}}
 */
export function readHangUp(text) {
  const raw = String(text ?? "");
  const hangUp = HANGUP_RE.test(raw);
  HANGUP_RE.lastIndex = 0;
  return { hangUp, text: stripCallTags(raw) };
}

/**
 * 把三个通话指令标记剥掉。
 *
 * 顺手收拾空行：`[接受通话]\n\n喂？` 剥完要是 `喂？` 而不是 `\n\n喂？` ——
 * 后者送进 TTS 会多出一段莫名的停顿。
 */
export function stripCallTags(text) {
  return String(text ?? "")
    .replace(ACCEPT_RE, "")
    .replace(REJECT_RE, "")
    .replace(HANGUP_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 气泡分隔符。
 *
 * 通话里不拆气泡，但模型写惯了 `$`（`config.js:424` 的默认值）。真念出来
 * 就是一声「美元」，很出戏。
 *
 * **只剥当分隔符用的那些**：前后是空白或者行首行尾的孤立 `$`。真要说钱的时候
 * （「$5」「花了 $20」）那个 `$` 紧贴着数字，不该动。
 */
export function stripSeparator(text, sep = "$") {
  if (!sep) return String(text ?? "");
  const esc = sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /*
   * 唯一**不能**动的情况：紧跟着数字，那是在说钱（`$20`、`花了 $5`）。
   * 除此之外的 `$` 在通话里都是模型写惯了的气泡分隔符，一律换成空格 ——
   * 句子之间要有间隔，直接删掉会让两句话黏成一个词。
   */
  return String(text ?? "")
    .replace(new RegExp(`${esc}(?![0-9])`, "g"), " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * 这段话里要念出来的部分。
 *
 * 通话里消息格式与功能是**保留**的（打电话时角色突然想转个钱很真实），但那些
 * 方括号标记不能念 —— 所以这里只挑出纯文本，其余交给各自的执行器照常发出去。
 *
 * 切分复用 `media.js:splitMedia`，由调用方传进来 —— 这个文件要保持纯粹，
 * 不 import 任何会读配置的东西。
 *
 * @param {Array<{kind: string, text: string}>} parts splitMedia 的产物
 * @param {string} [sep] 气泡分隔符
 * @param {object} [opts]
 * @param {boolean} [opts.keepTone] 语气标签留给 TTS（这一家认的时候，见 stripSpoken）
 * @returns {string} 拼好的、可以直接送 TTS 的文本
 */
export function speakableFrom(parts, sep = "$", { keepTone = false } = {}) {
  const text = (parts ?? [])
    .filter((p) => p?.kind === "text")
    .map((p) => String(p.text ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return stripSeparator(stripSpoken(stripCallTags(text), { keepTone }), sep);
}

/**
 * 这个方括号标记是**语气标签**吗（`[sighs]`、`[warmly]`、`[chuckles]`）。
 *
 * 判据：一个纯 ASCII 字母的词，不长。指令标记一律落在外面 —— 它们要么带冒号
 * （`[search:天气]`）、要么是中文（`[查岗实时电脑屏幕]`）、要么带下划线
 * （`[leave_on_read]`）。媒体类的压根到不了这儿：`splitMedia` 已经把它们切成
 * 非 text 的 part 了。
 *
 * **刻意只认单个词**：`[strong British accent]` 这种带空格的不在这儿管 ——
 * 口音是配置里那一项，由 `media.js:synthesizeVoice` 自己拼在整条前面，不是
 * 模型写出来的。而放开空格会连带改掉「方括号里有空格的当正文」那条老规矩
 * （`[he said]` 本来是要念出来的）。
 */
function isToneTag(body) {
  const s = String(body ?? "").trim();
  return s.length > 0 && s.length <= 24 && /^[A-Za-z]+$/.test(s);
}

/**
 * 把所有**不该念出来**的方括号标记剥掉。
 *
 * `splitMedia` 只认媒体类的（语音条、图片、转账、卡片……），因为那些要切成
 * 单独的气泡发出去。但还有一类标记它不管 —— 查岗、搜索、看菜单、查手机
 * 那种「再问一次」的标记：它们在发短信那条路上由各自的 `*Round` 函数消费，
 * 剥除发生在更后面。
 *
 * 通话这条路不走那些 Round，所以这些标记会原样留在文本里被送去合成 ——
 * 实测 ElevenLabs 直接回 400（「Input at position 0 has empty text」，因为
 * 它把方括号当成 speaker tag 剥掉之后什么都不剩了）。就算不报错，念出一句
 * 「查岗实时电脑屏幕」也很出戏。
 *
 * 这里用一条**通用**规则而不是去 import 那五六个模块各自的剥除函数：
 * 那样每加一个新标记就要记得在这儿也加一次，而漏掉的表现是角色突然念出
 * 一串方括号。通用规则对「以后新增的标记」天生免疫。
 *
 * ── keepTone：语气标签要留给 TTS ──
 *
 * `[warmly]`、`[sighs]` 这类是**写给 TTS 的**，ElevenLabs v3 及以后认（见
 * `media.js:elevenTagsOk`）。那种情况下剥掉就白丢一分情绪 —— 发语音条那条路
 * 本来就是留着的（`media.js:synthesizeVoice` 按 `keepTags` 决定），通话这条路
 * 以前一律剥，于是通话里角色永远没有语气。认不认标签由调用方判，这里只管
 * 「留还是不留」。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.keepTone] 留下语气标签（见 isToneTag）
 */
export function stripSpoken(text, { keepTone = false } = {}) {
  return (
    String(text ?? "")
      /*
       * 形如 [看菜单:瑞幸]、[search:天气]、[查岗实时电脑屏幕] 的标记。
       *
       * 只剥**整个方括号里不含空格**的那些 —— 真要说的话里也可能有方括号
       * （「他发来一条[图片]」），但那种里面通常带空格或标点。这个判据不完美，
       * 不过念错一个方括号比漏剥一个指令标记轻得多。
       *
       * keepTone 时多一道：纯英文单词的那些是语气标签，原样留着（见 isToneTag）。
       */
      .replace(/[[［]\s*[^\s\]］]{1,40}\s*[\]］]/g, (whole) => {
        const body = whole.replace(/^[[［]\s*|\s*[\]］]$/g, "");
        return keepTone && isToneTag(body) ? `[${body}]` : " ";
      })
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

/**
 * 按句子切开，一句一句去合成。
 *
 * 为什么要切：`media.js` 那四家 TTS 全是整段合成、没有流式（`media.js:1496`
 * 写死了 `stream: false`）。整段等下来就是好几秒，而**第一句一出来就能开始播**。
 *
 * 第一句**刻意切短**（到第一个句末标点就停），后面的句子攒够 `minChars` 再切 ——
 * 第一句决定对方听到声音的快慢，后面几句反正在排队，切太碎只是白多几次请求。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.minChars] 除第一句外，一段至少这么多字才切
 * @param {number} [opts.maxChars] 一段最多这么多字（超了硬切，TTS 有上限）
 * @returns {string[]}
 */
export function splitSentences(text, { minChars = 24, maxChars = 180 } = {}) {
  const src = String(text ?? "").trim();
  if (!src) return [];

  // 句末标点后面切。中英文的都算，引号和括号跟着前一句走
  const pieces = src.match(/[^。！？!?…\n]+[。！？!?…]*[」』"')）】]*\s*|\n+/g) ?? [src];

  const out = [];
  let buf = "";
  for (const piece of pieces) {
    const p = piece.replace(/\n+/g, " ");
    if (!p.trim()) continue;

    // 第一句不攒，一有完整的就立刻吐出去 —— 它决定对方多久能听到声音
    if (!out.length && !buf && p.trim().length >= 2) {
      out.push(p.trim());
      continue;
    }

    buf += p;
    if (buf.trim().length >= minChars) {
      out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());

  // 太长的硬切，不然 TTS 那边会被截断（media.js:88 MAX_TTS_CHARS = 1000）
  const final = [];
  for (const s of out) {
    if (s.length <= maxChars) {
      final.push(s);
      continue;
    }
    for (let at = 0; at < s.length; at += maxChars) {
      final.push(s.slice(at, at + maxChars));
    }
  }
  return final;
}
