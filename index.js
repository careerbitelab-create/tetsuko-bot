const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============ 状態管理 ============
const conversationHistory = new Map();
const MAX_HISTORY = 40;
const lastStickerSender = new Map();
const lastStickerTurn = new Map();
const turnCounter = new Map();
const lastMessageTime = new Map();
const consecutiveSpeaker = new Map();

function getHistory(uid) {
  if (!conversationHistory.has(uid)) conversationHistory.set(uid, []);
  return conversationHistory.get(uid);
}
function addHist(uid, role, content) {
  const h = getHistory(uid);
  h.push({ role, content });
  if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
}

// ============ 賢者 ============
const SAGES = {
  socrates:  { name: "ソクラテス", iconUrl: "https://raw.githubusercontent.com/careerbitelab-create/tetsuko-bot/main/socrates.png" },
  nietzsche: { name: "ニーチェ",   iconUrl: "https://raw.githubusercontent.com/careerbitelab-create/tetsuko-bot/main/nietzsche.png" },
  buddha:    { name: "仏陀",       iconUrl: "https://raw.githubusercontent.com/careerbitelab-create/tetsuko-bot/main/buddha.png" },
  confucius: { name: "孔子",       iconUrl: "https://raw.githubusercontent.com/careerbitelab-create/tetsuko-bot/main/confucius.png" },
  jung:      { name: "ユング",     iconUrl: "https://raw.githubusercontent.com/careerbitelab-create/tetsuko-bot/main/jung.png" },
};
const SAGE_IDS = Object.keys(SAGES);
const NAME2ID = {};
for (const [id, s] of Object.entries(SAGES)) NAME2ID[s.name] = id;

const SPEAKER_ALIASES = {
  socrates: "socrates", nietzsche: "nietzsche", buddha: "buddha", confucius: "confucius", jung: "jung",
  "ソクラテス": "socrates", "ニーチェ": "nietzsche", "仏陀": "buddha", "孔子": "confucius", "ユング": "jung",
  "Socrates": "socrates", "Nietzsche": "nietzsche", "Buddha": "buddha", "Confucius": "confucius", "Jung": "jung",
  "SOCRATES": "socrates", "NIETZSCHE": "nietzsche", "BUDDHA": "buddha", "CONFUCIUS": "confucius", "JUNG": "jung",
  "sokrates": "socrates", "niche": "nietzsche", "ブッダ": "buddha", "釈迦": "buddha", "こうし": "confucius",
};

function normalizeSpeaker(raw) {
  if (!raw) return "buddha";
  const id = SPEAKER_ALIASES[raw] || SPEAKER_ALIASES[raw.trim()];
  if (id) return id;
  const lower = raw.toLowerCase().trim();
  for (const [alias, nid] of Object.entries(SPEAKER_ALIASES)) {
    if (lower === alias.toLowerCase()) return nid;
  }
  return "buddha";
}

// ============ スタンプ ============
const STK = {
  empathy:   [{ p:"446",s:"2004" },{ p:"446",s:"2007" },{ p:"446",s:"2010" },{ p:"1070",s:"17839" },{ p:"1070",s:"17848" }],
  thinking:  [{ p:"446",s:"1993" },{ p:"446",s:"1999" },{ p:"1070",s:"17842" }],
  encourage: [{ p:"446",s:"1990" },{ p:"446",s:"2005" },{ p:"789",s:"10855" }],
  surprise:  [{ p:"446",s:"1994" },{ p:"446",s:"2006" },{ p:"1070",s:"17843" }],
  fun:       [{ p:"446",s:"1989" },{ p:"446",s:"1996" },{ p:"446",s:"2000" }],
};

// ============ ユーティリティ ============
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const jstH = () => (new Date().getUTCHours() + 9) % 24;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shouldSendSticker(uid, tc, stickerMood) {
  if (!stickerMood || !STK[stickerMood]) return false;
  if (tc <= 2) return false;
  const lastTurn = lastStickerTurn.get(uid) || 0;
  if (tc - lastTurn < 5) return false; // 5ターン以内はスキップ
  return Math.random() < 0.15; // 約15%
}

function pickStkSender(uid, speaking) {
  const silent = SAGE_IDS.filter((id) => !speaking.includes(id));
  if (!silent.length) return null;
  const last = lastStickerSender.get(uid);
  const pool = silent.filter((id) => id !== last);
  const ch = pick(pool.length ? pool : silent);
  lastStickerSender.set(uid, ch);
  return ch;
}

function lastQ(hist) {
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].role === "assistant") {
      const ls = hist[i].content.split("\n");
      const ll = ls[ls.length - 1];
      if (ll && ll.includes("？")) {
        for (const [n, id] of Object.entries(NAME2ID)) {
          if (ll.startsWith(n + ":")) return id;
        }
      }
      return null;
    }
  }
  return null;
}

function getLastSpeakers(hist) {
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].role === "assistant") {
      const ids = [];
      for (const [name, id] of Object.entries(NAME2ID)) {
        if (hist[i].content.includes(name + ":")) ids.push(id);
      }
      return ids;
    }
  }
  return [];
}

function countExchanges(uid) {
  return getHistory(uid).filter((m) => m.role === "user").length;
}

function wasLastResponseQuestion(hist) {
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].role === "assistant") return hist[i].content.includes("？");
  }
  return false;
}

function updateConsecutiveSpeaker(uid, speakers) {
  const current = consecutiveSpeaker.get(uid) || { id: null, count: 0 };
  if (speakers.length === 1 && speakers[0] === current.id) {
    consecutiveSpeaker.set(uid, { id: speakers[0], count: current.count + 1 });
  } else {
    consecutiveSpeaker.set(uid, { id: speakers.length ? speakers[0] : null, count: 1 });
  }
}

function getConsecutiveInfo(uid) {
  return consecutiveSpeaker.get(uid) || { id: null, count: 0 };
}

// ============ 間を読む ============
function gapCtx(uid) {
  const now = Date.now();
  const last = lastMessageTime.get(uid);
  lastMessageTime.set(uid, now);
  if (!last) return "";

  const gap = (now - last) / 60000;
  const h = jstH();
  let tod = "昼";
  if (h >= 5 && h < 10) tod = "朝";
  else if (h >= 17 && h < 22) tod = "夜";
  else if (h >= 22 || h < 5) tod = "深夜";

  const hist = getHistory(uid);
  let prev = "";
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].role === "user") { prev = hist[i].content.substring(0, 50); break; }
  }

  if (gap >= 30 && gap < 180)
    return `\n[間: ${Math.round(gap)}分ぶり。${tod}。1人だけ一言。前回:「${prev}」]`;
  if (gap >= 180 && gap < 1440)
    return `\n[間: ${Math.round(gap / 60)}時間ぶり。${tod}。1人だけ。前回「${prev}」に触れてもいい。]`;
  if (gap >= 1440)
    return `\n[間: ${Math.round(gap / 1440)}日ぶり。${tod}。1人だけ。前回:「${prev}」]`;
  return "";
}

// ============ JSONパース ============
function parseResponse(raw) {
  try {
    const cleaned = raw.replace(/```json\s?|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.messages && Array.isArray(parsed.messages)) return parsed;
  } catch (e) {}

  const jsonMatch = raw.match(/\{[\s\S]*"messages"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.messages && Array.isArray(parsed.messages)) return parsed;
    } catch (e) {}
  }

  const lines = raw.split("\n").filter((l) => l.trim());
  const msgs = [];
  for (const line of lines) {
    for (const [name, id] of Object.entries(NAME2ID)) {
      for (const sep of [": ", "： ", ":", "："]) {
        if (line.startsWith(name + sep)) {
          const text = line.slice((name + sep).length).trim();
          if (text) msgs.push({ speaker: id, text });
          break;
        }
      }
    }
  }
  if (msgs.length > 0) return { messages: msgs, sticker_mood: null };
  return { messages: [{ speaker: "buddha", text: raw.slice(0, 200) }], sticker_mood: null };
}

// ============ システムプロンプト ============
const SYS = `あなたはLINEの「哲子の部屋」というトークルームのシミュレーター。
ユーザーと5人の賢者（ソクラテス、ニーチェ、仏陀、孔子、ユング）がいる。
※「グループ」は絶対使わない。「部屋」「ここ」を使う。

━━━━━━━━━━━━━━━━━━━━
■ 最重要：賢者らしさを徹底する
━━━━━━━━━━━━━━━━━━━━

「普通のAIが言えること」を言わない。
賢者の言葉には以下を自然に混ぜる：

・哲学的な比喩や問い（「洞窟の外に出たことはある？」）
・自分の名言・思想の引用（さりげなく）
・抽象的な表現（「苦しみは影であり、光があればこそ生まれる」）
・歴史的・文化的なたとえ
・現実的な話もするが、そこに哲学的視点を乗せる

【各キャラの話し方・個性】

ソクラテス（socrates）
- 「〜ではないでしょうか」「あなたはどう感じますか？」
- 問いによって相手に気づかせる。直接答えるより問い返す。
- ユーモアあり。「私は何も知らない、とかつて言いましたが、あなたの話を聞いてますます確信しました笑」
- たまに「問われていないことが、実は核心ということもあります」

ニーチェ（nietzsche）
- タメ口。率直。「は？それで満足できるの？」「俺ならそこで踏み込む」
- 「神は死んだ、って言ったの、こういう状況のことだよ」「深淵を覗きすぎると、深淵もこちらを見てくるぞ」
- 挑発気味だが、根は相手を奮い立たせたい

仏陀（buddha）
- 静か。「…」をよく使う。1〜2文で核心をつく。
- 「川は止まらない。でも岸で休める」「手放すことで、見えてくるものがある」
- 詩的・抽象的。余白を大切にする。

孔子（confucius）
- 丁寧語。世話焼き。具体的・実践的。
- 「学びて思わざれば則ち罔し、という言葉があります」
- 「まず一歩。道は歩いて初めて道になる、とも言いますし」

ユング（jung）
- 敬語とタメ口が混在。
- 「怒りの裏にあるの、悲しみじゃない？」
- 「あなたの影（シャドウ）を認めることが、自己実現への第一歩です」
- 感情の「なぜ」を深層心理から掘り下げる。

━━━━━━━━━━━━━━━━━━━━
■ 会話の目的とバランス
━━━━━━━━━━━━━━━━━━━━

① ユーザーが気持ちを吐き出してスッキリすること
② 賢者らしい言葉でアドバイスや新しい視点をもらえること

【質問とアドバイスのバランス】
- 質問ばかりにしない。1回質問 → 1回は感想や意見のリズム。
- 「アドバイスください」「どうすれば」「意見が聞きたい」→ 素直に答える。

【応答の種類を混ぜる】
共感・感想・意見・軽い質問・アドバイス・名言引用・比喩 をバランスよく。

━━━━━━━━━━━━━━━━━━━━
■ 会話の広がりと人数
━━━━━━━━━━━━━━━━━━━━

【デフォルトは1人】

【他の賢者への橋渡し】
同じ人が3ターン以上続いたら、自然に別の賢者に話を振る。
例：「ニーチェはどう思う？」「仏陀ならこう言うかもしれない」

【他の賢者が自発的に登場してOKな場面】
- 話している賢者が別の視点に言及した時
- ユーザーが「みんなはどう思う？」と聞いた時
- 意見が明確に割れる話題

【人数の上限】通常1人。2人は対話が盛り上がった時。3人は極めて稀。

━━━━━━━━━━━━━━━━━━━━
■ 会話ルール
━━━━━━━━━━━━━━━━━━━━

1. 前ターンで質問した賢者がまず反応。他は黙る。
2. 指名されたらその人だけ答える。
3. 誰かと1対1の会話が続いている → その人が主役。他は見守る。
4. 話さない賢者は消えたわけじゃない。聞いている。

━━━━━━━━━━━━━━━━━━━━
■ テキストの長さ
━━━━━━━━━━━━━━━━━━━━

- 1人1〜2文（15〜50文字）。最大3文。
- 「…」「うん」だけでもいい。

━━━━━━━━━━━━━━━━━━━━
■ 出力形式 — JSONのみ
━━━━━━━━━━━━━━━━━━━━

{"messages":[{"speaker":"socrates","text":"..."}],"sticker_mood":null}

speakerは必ず英語ID: socrates / nietzsche / buddha / confucius / jung
日本語名をspeakerに入れない。絶対に。
messages: 1〜2個。ほとんど1個。
sticker_mood: "empathy"/"thinking"/"encourage"/"surprise"/"fun" / null
→ 迷ったらnull。内容に合わないスタンプは絶対NG。

■ 安全
深刻な悩み（死・自傷など）→ 寄り添い、専門機関への相談を自然に促す。`;

// ============ LINE API ============
async function replyLine(replyToken, msgs) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: msgs.slice(0, 5) }),
  });
  if (!res.ok) console.error("Reply err:", res.status, await res.text());
}

async function pushLine(userId, msgs) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to: userId, messages: msgs.slice(0, 5) }),
  });
  if (!res.ok) console.error("Push err:", res.status, await res.text());
}

async function showLoading(userId) {
  try {
    await fetch("https://api.line.me/v2/bot/chat/loading/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` },
      body: JSON.stringify({ chatId: userId }),
    });
  } catch (e) {}
}

// ============ メイン ============
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const uid = event.source.userId;
  const msg = event.message.text;
  console.log("Msg:", uid.slice(-6), msg.substring(0, 50));

  if (/^(使い方|ヘルプ|help)$/i.test(msg)) {
    return replyLine(event.replyToken, [
      { type: "text", text: "ここは「哲子の部屋」。悩みでも愚痴でも何でもいいよ。", sender: { name: SAGES.buddha.name, iconUrl: SAGES.buddha.iconUrl } },
      { type: "text", text: "誰かを指名してもOKですよ。「ユングはどう思う？」みたいに。", sender: { name: SAGES.confucius.name, iconUrl: SAGES.confucius.iconUrl } },
    ]);
  }

  if (/^(リセット|reset)$/i.test(msg)) {
    conversationHistory.delete(uid);
    turnCounter.delete(uid);
    lastStickerSender.delete(uid);
    lastStickerTurn.delete(uid);
    lastMessageTime.delete(uid);
    consecutiveSpeaker.delete(uid);
    return replyLine(event.replyToken, [
      { type: "text", text: "…リセットしたよ。また話そう。", sender: { name: SAGES.buddha.name, iconUrl: SAGES.buddha.iconUrl } },
    ]);
  }

  showLoading(uid);

  const gapInfo = gapCtx(uid);
  const hist = getHistory(uid);
  const questioner = lastQ(hist);
  const prevSpeakers = getLastSpeakers(hist);
  const lastWasQ = wasLastResponseQuestion(hist);
  const consecutive = getConsecutiveInfo(uid);

  let qCtx = "";
  if (questioner) {
    qCtx = `\n[前ターンで${SAGES[questioner]?.name}が質問した。${SAGES[questioner]?.name}だけが反応。他は黙る。]`;
  } else if (prevSpeakers.length === 1) {
    const prevName = SAGES[prevSpeakers[0]]?.name;
    qCtx = `\n[前ターンで${prevName}が話した。${prevName}が主に反応。他は黙る。]`;
  }

  let diversifyCtx = "";
  if (consecutive.count >= 3 && consecutive.id) {
    const currentName = SAGES[consecutive.id]?.name;
    diversifyCtx = `\n[${currentName}が${consecutive.count}ターン連続で話している。このターンで別の賢者に自然に話を振るか、別の賢者が口を挟んでもいい。]`;
  }

  let balanceCtx = "";
  if (lastWasQ) {
    balanceCtx = "\n[前ターンは質問で終わった。今回は質問せず、感想・共感・意見・比喩・名言で返すこと。]";
  }

  let adviceCtx = "";
  if (/アドバイス|どうすれば|意見|教えて|どう思う|お願い/.test(msg)) {
    adviceCtx = "\n[ユーザーがアドバイス・意見を求めている。質問で返さず、賢者らしい言葉でアドバイスや考えを伝えること。]";
  }

  const ex = countExchanges(uid);
  let phase = "\n[序盤。まず聞く。感想や比喩も交えながら。]";
  if (ex > 3 && ex <= 6) phase = "\n[中盤。気持ちの整理＋賢者らしい視点・名言も。]";
  else if (ex > 6) phase = "\n[終盤。アドバイスOK。哲学的な言葉で締めてもいい。]";

  const tc = (turnCounter.get(uid) || 0) + 1;
  turnCounter.set(uid, tc);

  addHist(uid, "user", msg);

  const cMsgs = hist.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
  cMsgs.push({ role: "user", content: msg + gapInfo + qCtx + diversifyCtx + balanceCtx + adviceCtx + phase });

  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      system: SYS,
      messages: cMsgs,
    });

    const raw = res.content[0]?.text || "";
    console.log("Raw:", raw.substring(0, 300));

    const parsed = parseResponse(raw);
    let messages = parsed.messages || [];

    if (!messages.length) {
      return replyLine(event.replyToken, [
        { type: "text", text: "…もう少し聞かせて。", sender: { name: SAGES.buddha.name, iconUrl: SAGES.buddha.iconUrl } },
      ]);
    }

    messages = messages.slice(0, 3).map((m) => ({ speaker: normalizeSpeaker(m.speaker), text: m.text }));

    updateConsecutiveSpeaker(uid, messages.map((m) => m.speaker));

    addHist(uid, "assistant", messages.map((m) => `${SAGES[m.speaker]?.name || m.speaker}: ${m.text}`).join("\n"));

    const allMsgs = messages.map((m) => {
      const sg = SAGES[m.speaker];
      return { type: "text", text: m.text, sender: { name: sg.name, iconUrl: sg.iconUrl } };
    });

    // スタンプ判定（厳格）
    const stickerMood = parsed.sticker_mood;
    if (shouldSendSticker(uid, tc, stickerMood)) {
      const spkIds = messages.map((m) => m.speaker);
      const sender = pickStkSender(uid, spkIds);
      if (sender && allMsgs.length <= 2) {
        const stk = pick(STK[stickerMood]);
        const sg = SAGES[sender];
        allMsgs.push({
          type: "sticker", packageId: stk.p, stickerId: stk.s,
          sender: { name: sg.name, iconUrl: sg.iconUrl },
        });
        lastStickerTurn.set(uid, tc);
      }
    }

    // 送信（時間差）
    await replyLine(event.replyToken, [allMsgs[0]]);
    for (let i = 1; i < allMsgs.length; i++) {
      await sleep(2000 + Math.random() * 2000);
      showLoading(uid);
      await sleep(600);
      await pushLine(uid, [allMsgs[i]]);
    }

  } catch (err) {
    console.error("API err:", err.message);
    return replyLine(event.replyToken, [
      { type: "text", text: "…ちょっと待ってね。", sender: { name: SAGES.buddha.name, iconUrl: SAGES.buddha.iconUrl } },
    ]);
  }
}

async function handleFollow(event) {
  const uid = event.source.userId;
  if (getHistory(uid).length > 0) {
    await replyLine(event.replyToken, [
      { type: "text", text: "…おかえり。待ってたよ。", sender: { name: SAGES.buddha.name, iconUrl: SAGES.buddha.iconUrl } },
    ]);
  }
}

const app = express();
app.post("/webhook", express.json(), async (req, res) => {
  res.status(200).send("OK");
  try {
    for (const ev of req.body.events || []) {
      if (ev.type === "message") await handleEvent(ev);
      else if (ev.type === "follow") await handleFollow(ev);
    }
  } catch (e) { console.error("Webhook err:", e.message); }
});
app.get("/", (_, res) => res.send("哲子の部屋 Bot running"));
app.listen(process.env.PORT || 3000, () => console.log("哲子の部屋 Bot started"));
