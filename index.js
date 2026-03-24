const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============ 状態管理 ============
const conversationHistory = new Map();
const MAX_HISTORY = 40;
const lastStickerSender = new Map();
const turnCounter = new Map();
const lastMessageTime = new Map();

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
  socrates: { name: "ソクラテス", iconUrl: "https://api.dicebear.com/7.x/initials/png?seed=So&backgroundColor=c0392b&textColor=ffffff&size=200" },
  nietzsche: { name: "ニーチェ", iconUrl: "https://api.dicebear.com/7.x/initials/png?seed=Ni&backgroundColor=e67e22&textColor=ffffff&size=200" },
  buddha: { name: "仏陀", iconUrl: "https://api.dicebear.com/7.x/initials/png?seed=Bu&backgroundColor=27ae60&textColor=ffffff&size=200" },
  confucius: { name: "孔子", iconUrl: "https://api.dicebear.com/7.x/initials/png?seed=Ko&backgroundColor=2c3e50&textColor=ffffff&size=200" },
  jung: { name: "ユング", iconUrl: "https://api.dicebear.com/7.x/initials/png?seed=Ju&backgroundColor=8e44ad&textColor=ffffff&size=200" },
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
  for (const [alias, id] of Object.entries(SPEAKER_ALIASES)) {
    if (lower === alias.toLowerCase()) return id;
  }
  console.log("Unknown speaker:", raw, "-> buddha");
  return "buddha";
}

// ============ スタンプ ============
const STK = {
  empathy: [{ p:"446",s:"2004" },{ p:"446",s:"2007" },{ p:"446",s:"2010" },{ p:"1070",s:"17839" },{ p:"1070",s:"17848" }],
  thinking: [{ p:"446",s:"1993" },{ p:"446",s:"1999" },{ p:"1070",s:"17842" }],
  encourage: [{ p:"446",s:"1990" },{ p:"446",s:"2005" },{ p:"789",s:"10855" }],
  gratitude: [{ p:"446",s:"2001" },{ p:"789",s:"10863" }],
  surprise: [{ p:"446",s:"1994" },{ p:"446",s:"2006" },{ p:"1070",s:"17843" }],
  fun: [{ p:"446",s:"1989" },{ p:"446",s:"1996" },{ p:"446",s:"2000" }],
};

// ============ ユーティリティ ============
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const jstH = () => (new Date().getUTCHours() + 9) % 24;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// 直近の賢者の発言が質問だったか
function wasLastResponseQuestion(hist) {
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].role === "assistant") {
      return hist[i].content.includes("？");
    }
  }
  return false;
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
const SYS = `あなたはLINEの「哲子の部屋」というトークルームのシミュレーター。ユーザーと5人の賢者がいる。
※「グループ」は使わない。「部屋」「ここ」を使う。

━━━━━━━━━━━━
■ 目的と会話のバランス
━━━━━━━━━━━━

ユーザーが気持ちを吐き出してスッキリすること + 良いアドバイスをもらえること。
この2つのバランスが大事。

【質問とアドバイスのバランス — 超重要】
- 質問ばかり繰り返さない。質問攻めはユーザーを疲れさせる。
- 前のターンで質問したなら、今回は質問しない。感想・共感・意見を言う。
- 1回質問 → 1回は自分の考えや感想を言う → また必要なら質問、のリズム。
- 質問と意見は半々くらいのバランスで。

【アドバイスを求められたら → すぐ応える】
ユーザーが「アドバイスください」「どうすればいい？」「意見が聞きたい」と言ったら、
質問で返さずにアドバイスや意見を素直に伝える。
ユーザーの要望を無視して質問を続けるのは絶対NG。

【応答の種類を混ぜる】
毎回同じパターンにならないように、色んな返し方を使う：
- 共感（「わかるよ」「それはキツいね」）
- 感想（「面白い話だな」「それ、結構すごいことだよ」）
- 自分の考え（「俺はこう思う」「私の考えではね」）
- 軽い質問（「ちなみにそれっていつの話？」）
- アドバイス（「こうしてみたら？」）
- リアクション（「え、マジで」「へぇー」）

━━━━━━━━━━━━
■ 5人のキャラクター
━━━━━━━━━━━━

【ソクラテス（socrates）】丁寧語。穏やか。問いで気づかせる。たまに哲学的・ユーモア。
【ニーチェ（nietzsche）】タメ口。率直。ストレート。反論担当。根は熱い。
【仏陀（buddha）】静か。「…」を使う。短い。1〜2文。受け止め役。詩的。
【孔子（confucius）】丁寧語。世話焼き。具体的・実践的。
【ユング（jung）】敬語タメ口混在。心の深層を言語化。カウンセラー的。

━━━━━━━━━━━━
■ 人数と空気
━━━━━━━━━━━━

【デフォルトは1人】
ほとんど1人で十分。無理に2人目を出さない。

【2人が出ていい場面】
- 意見が分かれる時
- 「みんなどう思う？」と聞かれた時

【3人以上は極めて稀】

【残りは聞いている。後で自然に出ればいい。】

━━━━━━━━━━━━
■ 会話ルール
━━━━━━━━━━━━

1. 前ターンで質問した賢者がまず反応。他は黙る。
2. 指名されたらその人だけ。
3. 誰かと会話が続いている → その人が主役。他は見守る。
4. 質問で返したら他は黙る。

━━━━━━━━━━━━
■ テキストの長さ
━━━━━━━━━━━━

- 1人1〜2文（15〜40文字）。
- 「うん」「たしかに」だけもあり。
- 最大3文。

━━━━━━━━━━━━
■ 出力形式 — JSONのみ
━━━━━━━━━━━━

{"messages":[{"speaker":"socrates","text":"ふむ…なるほどね。"}],"sticker_mood":null}

speakerは必ず英語ID: socrates / nietzsche / buddha / confucius / jung
日本語名をspeakerに入れない。
messages: 1〜3個。ほとんど1個。

sticker_mood: "empathy"/"thinking"/"encourage"/"gratitude"/"surprise"/"fun" / null
迷ったらnull。5回に1回程度。内容に合わないスタンプは絶対NG。

■ 安全
深刻な悩み → 寄り添い、1人が自然に専門機関への相談を促す。`;

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
  console.log("Msg:", uid.slice(-6), msg);

  if (/^(使い方|ヘルプ|help)$/i.test(msg)) {
    return replyLine(event.replyToken, [
      { type: "text", text: "ここは「哲子の部屋」だよ。悩みでも愚痴でも何でもいい。", sender: { name: SAGES.buddha.name, iconUrl: SAGES.buddha.iconUrl } },
      { type: "text", text: "誰かを指名してもいいですよ。「ユングはどう思う？」みたいにね。", sender: { name: SAGES.confucius.name, iconUrl: SAGES.confucius.iconUrl } },
    ]);
  }

  if (/^(リセット|reset)$/i.test(msg)) {
    conversationHistory.delete(uid); turnCounter.delete(uid);
    lastStickerSender.delete(uid); lastMessageTime.delete(uid);
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

  let qCtx = "";
  if (questioner) {
    qCtx = `\n[前ターンで${SAGES[questioner]?.name}が質問した。${SAGES[questioner]?.name}だけが反応。他は黙る。]`;
  } else if (prevSpeakers.length === 1) {
    const prevName = SAGES[prevSpeakers[0]]?.name;
    qCtx = `\n[前ターンで${prevName}が話した。${prevName}が主に反応。他は黙る。]`;
  }

  // 質問バランス制御
  let balanceCtx = "";
  if (lastWasQ) {
    balanceCtx = "\n[前ターンは質問で終わった。今回は質問せず、感想・共感・意見で返すこと。]";
  }

  // アドバイス要求検知
  let adviceCtx = "";
  if (/アドバイス|どうすれば|意見|教えて|どう思う|お願い/.test(msg)) {
    adviceCtx = "\n[ユーザーがアドバイス・意見を求めている。質問で返さず、素直にアドバイスや考えを伝えること。]";
  }

  const ex = countExchanges(uid);
  let phase = "\n[序盤。聞きつつ、自分の感想や考えも混ぜる。]";
  if (ex > 3 && ex <= 6) phase = "\n[中盤。気持ちの整理＋意見も。]";
  else if (ex > 6) phase = "\n[終盤。アドバイスOK。]";

  const tc = (turnCounter.get(uid) || 0) + 1;
  turnCounter.set(uid, tc);

  addHist(uid, "user", msg);

  const cMsgs = hist.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
  cMsgs.push({ role: "user", content: msg + gapInfo + qCtx + balanceCtx + adviceCtx + phase });

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

    messages = messages.map((m) => ({ speaker: normalizeSpeaker(m.speaker), text: m.text }));

    addHist(uid, "assistant", messages.map((m) => `${SAGES[m.speaker]?.name || m.speaker}: ${m.text}`).join("\n"));

    const allMsgs = messages.slice(0, 3).map((m) => {
      const sg = SAGES[m.speaker];
      return { type: "text", text: m.text, sender: { name: sg.name, iconUrl: sg.iconUrl } };
    });

    // スタンプ
    const stickerMood = parsed.sticker_mood;
    if (stickerMood && STK[stickerMood] && allMsgs.length <= 2 && tc > 2) {
      const spkIds = messages.map((m) => m.speaker);
      const sender = pickStkSender(uid, spkIds);
      if (sender) {
        const stk = pick(STK[stickerMood]);
        const sg = SAGES[sender];
        allMsgs.push({
          type: "sticker", packageId: stk.p, stickerId: stk.s,
          sender: { name: sg.name, iconUrl: sg.iconUrl },
        });
      }
    }

    // 送信
    await replyLine(event.replyToken, [allMsgs[0]]);
    for (let i = 1; i < allMsgs.length; i++) {
      await sleep(2000 + Math.random() * 2000);
      showLoading(uid);
      await sleep(500);
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
