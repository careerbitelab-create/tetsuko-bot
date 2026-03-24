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

// ============ スタンプ ============
const STK = {
  empathy: [
    { p: "446", s: "2004" }, { p: "446", s: "2007" }, { p: "446", s: "2010" },
    { p: "1070", s: "17839" }, { p: "1070", s: "17848" },
  ],
  thinking: [
    { p: "446", s: "1993" }, { p: "446", s: "1999" }, { p: "1070", s: "17842" },
  ],
  encourage: [
    { p: "446", s: "1990" }, { p: "446", s: "2005" }, { p: "789", s: "10855" },
  ],
  gratitude: [
    { p: "446", s: "2001" }, { p: "789", s: "10863" },
  ],
  surprise: [
    { p: "446", s: "1994" }, { p: "446", s: "2006" }, { p: "1070", s: "17843" },
  ],
  fun: [
    { p: "446", s: "1989" }, { p: "446", s: "1996" }, { p: "446", s: "2000" },
  ],
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

function countExchanges(uid) {
  return getHistory(uid).filter((m) => m.role === "user").length;
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
    return `\n[間: ${Math.round(gap)}分ぶり。${tod}。1人だけ一言で「おかえり」的に。「部屋」表現を使う。前回:「${prev}」]`;
  if (gap >= 180 && gap < 1440)
    return `\n[間: ${Math.round(gap / 60)}時間ぶり。${tod}。1人が自然に。前回「${prev}」に触れてもいい。]`;
  if (gap >= 1440)
    return `\n[間: ${Math.round(gap / 1440)}日ぶり。${tod}。1人がさりげなく。前回:「${prev}」]`;
  return "";
}

// ============ JSONパース（フォールバック付き） ============
function parseResponse(raw) {
  // まずJSON直接パース
  try {
    const cleaned = raw.replace(/```json\s?|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.messages && Array.isArray(parsed.messages)) return parsed;
  } catch (e) { /* fallthrough */ }

  // JSON部分を抽出して再トライ
  const jsonMatch = raw.match(/\{[\s\S]*"messages"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.messages && Array.isArray(parsed.messages)) return parsed;
    } catch (e) { /* fallthrough */ }
  }

  // フォールバック：「名前: テキスト」形式をパース
  const lines = raw.split("\n").filter((l) => l.trim());
  const msgs = [];
  for (const line of lines) {
    for (const [name, id] of Object.entries(NAME2ID)) {
      // 「ソクラテス: テキスト」「ソクラテス：テキスト」の形式
      const prefixes = [`${name}: `, `${name}： `, `${name}:`, `${name}：`];
      for (const prefix of prefixes) {
        if (line.startsWith(prefix)) {
          const text = line.slice(prefix.length).trim();
          if (text) msgs.push({ speaker: id, text });
          break;
        }
      }
    }
  }
  if (msgs.length > 0) {
    console.log("Fallback parsed:", msgs.length, "messages");
    return { messages: msgs, sticker_mood: null };
  }

  // 最終フォールバック：全文を仏陀の発言として返す
  console.log("Final fallback: raw text as buddha");
  return { messages: [{ speaker: "buddha", text: raw.slice(0, 200) }], sticker_mood: null };
}

// ============ システムプロンプト ============
const SYS = `あなたはLINEの「哲子の部屋」というトークルームのシミュレーター。ユーザーと5人の賢者がいる。
※ここは「部屋」。「グループ」「グループチャット」は絶対使わない。「部屋」「ここ」を使う。

━━━━━━━━━━━━
■ 最上位の目的
━━━━━━━━━━━━

一番の目的は、ユーザーが心の中の悩み・気持ち・モヤモヤを全部吐き出してスッキリすること。
アドバイスは二の次。まず聞く。引き出す。受け止める。吐き出し切った後に良いアドバイスが生きる。

- 序盤（1〜4往復）→ 聞く・質問・受け止め。アドバイスしない。
- 中盤（5〜7往復）→ 気持ちの整理。「つまりこういうこと？」
- 終盤（8往復〜）→ アドバイスや新しい視点。
- 「どうすればいい？」と聞かれたらいつでもOK。

━━━━━━━━━━━━
■ 5人のキャラクター
━━━━━━━━━━━━

【ソクラテス（socrates）】
丁寧語。70代のおじいちゃん。穏やかで品がある。
問いで気づかせる。たまに哲学的。ユーモアあり。
例：「ふむ…それは恥ずかしかったでしょうね」
例：「私も2400年ほど考えていますが…笑」

【ニーチェ（nietzsche）】
タメ口。情熱的で率直。ストレート。
弱さの奥の強さを見抜く。他の賢者にも遠慮なく反論。
例：「正直に言うぞ。お前、答え分かってるだろ」
例：「孔子、それは綺麗事だ」

【仏陀（buddha）】
独特の静かな語り口。「…」を使う。
短い。1〜2文。寡黙。まず受け止める。時々詩的。
例：「…そうか。重かったね」
例：「川は止まらない。でも岸で休める」

【孔子（confucius）】
丁寧語。世話焼きおじさん。具体的・実践的。
例：「こういう時はね、まず上司にこう伝えてみるといいですよ」

【ユング（jung）】
敬語とタメ口混在。知的で親しみやすい。カウンセラー的。
例：「怒りの裏にあるの、悲しみじゃない？」
例：「さっきと今で言ってること変わってきてる。何かに気づいた？」

━━━━━━━━━━━━
■ 会話ルール
━━━━━━━━━━━━

1. 前ターンで質問した賢者がまず反応。他は割り込まない。
2. 指名されたらその人だけ。
3. 質問で返したら他は黙る。
4. 賢者同士で反応OK。反論・同意・被せ。

━━━━━━━━━━━━
■ テキストの長さ
━━━━━━━━━━━━

- 1人1〜2文（15〜40文字が理想）。
- 「うん」「たしかに」だけもあり。
- 重い時でも最大3文。
- テンポ良い時はポンポン短く。

━━━━━━━━━━━━
■ 人数
━━━━━━━━━━━━
1ターン1〜3人。5人全員は絶対ない。質問なら1人。

━━━━━━━━━━━━
■ 出力形式 — 絶対にJSONのみ
━━━━━━━━━━━━

以下のJSON形式のみを出力せよ。他のテキスト、説明、マークダウン、改行は一切含めるな。

{"messages":[{"speaker":"buddha","text":"…そうか。"}],"sticker_mood":null}

これ以外の形式は許可しない。「名前: テキスト」形式で出力してはいけない。必ずJSONで出力する。

speaker: socrates / nietzsche / buddha / confucius / jung
messages: 1〜4個。
sticker_mood: "empathy"/"thinking"/"encourage"/"gratitude"/"surprise"/"fun" または null。

【スタンプ判断基準】
- ユーザーの発言内容に完全に合ったムードでなければnull。
- つらい話に「gratitude」「fun」は絶対NG。
- ミス・失敗の話 → "empathy"のみ。
- 迷ったらnull。送らない方が安全。
- 5回に1回程度の頻度で十分。

━━━━━━━━━━━━
■ 安全
━━━━━━━━━━━━
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
  } catch (e) { /* ignore */ }
}

// ============ メイン処理 ============
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const uid = event.source.userId;
  const msg = event.message.text;
  console.log("Msg:", uid.slice(-6), msg);

  if (/^(使い方|ヘルプ|help)$/i.test(msg)) {
    return replyLine(event.replyToken, [
      { type: "text", text: "ここは「哲子の部屋」だよ。", sender: { name: SAGES.buddha.name, iconUrl: SAGES.buddha.iconUrl } },
      { type: "text", text: "悩みでも愚痴でも何でもいい。遠慮なく投げ込め。", sender: { name: SAGES.nietzsche.name, iconUrl: SAGES.nietzsche.iconUrl } },
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

  // 文脈
  const gapInfo = gapCtx(uid);
  const hist = getHistory(uid);
  const questioner = lastQ(hist);
  let qCtx = "";
  if (questioner) {
    qCtx = `\n[文脈: 前ターンで${SAGES[questioner]?.name}が質問。その人が最初に反応。]`;
  }
  const ex = countExchanges(uid);
  let phase = "\n[序盤。聞く・引き出す。アドバイスしない。]";
  if (ex > 3 && ex <= 6) phase = "\n[中盤。気持ちの整理。]";
  else if (ex > 6) phase = "\n[終盤。アドバイスOK。]";

  const tc = (turnCounter.get(uid) || 0) + 1;
  turnCounter.set(uid, tc);

  addHist(uid, "user", msg);

  const cMsgs = hist.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
  cMsgs.push({ role: "user", content: msg + gapInfo + qCtx + phase });

  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system: SYS,
      messages: cMsgs,
    });

    const raw = res.content[0]?.text || "";
    console.log("Raw:", raw.substring(0, 300));

    // パース（フォールバック付き）
    const parsed = parseResponse(raw);
    const messages = parsed.messages || [];

    if (!messages.length) {
      return replyLine(event.replyToken, [
        { type: "text", text: "…もう少し聞かせて。", sender: { name: SAGES.buddha.name, iconUrl: SAGES.buddha.iconUrl } },
      ]);
    }

    // 履歴保存
    addHist(uid, "assistant", messages.map((m) => `${SAGES[m.speaker]?.name || m.speaker}: ${m.text}`).join("\n"));

    // LINEメッセージ構築
    const allMsgs = messages.slice(0, 4).map((m) => {
      const sg = SAGES[m.speaker];
      return { type: "text", text: m.text, sender: { name: sg?.name || "哲子の部屋", iconUrl: sg?.iconUrl } };
    });

    // スタンプ
    const stickerMood = parsed.sticker_mood;
    if (stickerMood && STK[stickerMood] && allMsgs.length <= 3 && tc > 2) {
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

    // --- 送信 ---
    if (allMsgs.length === 1) {
      return replyLine(event.replyToken, allMsgs);
    }

    // 1通目: Reply（無料）
    await replyLine(event.replyToken, [allMsgs[0]]);

    // 2通目以降: Push（遅延）
    for (let i = 1; i < allMsgs.length; i++) {
      await sleep(800 + Math.random() * 1200);
      await pushLine(uid, [allMsgs[i]]);
    }

  } catch (err) {
    console.error("API err:", err.message);
    return replyLine(event.replyToken, [
      { type: "text", text: "…ちょっと待ってね。また話しかけて。", sender: { name: SAGES.buddha.name, iconUrl: SAGES.buddha.iconUrl } },
    ]);
  }
}

// ============ followイベント ============
async function handleFollow(event) {
  const uid = event.source.userId;
  if (getHistory(uid).length > 0) {
    await replyLine(event.replyToken, [
      { type: "text", text: "…おかえり。待ってたよ。", sender: { name: SAGES.buddha.name, iconUrl: SAGES.buddha.iconUrl } },
    ]);
  }
}

// ============ サーバー ============
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
