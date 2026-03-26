const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ============ 賢者 ============
const SAGES = {
  socrates:  {
    names: { ja: "ソクラテス", ko: "소크라테스", en: "Socrates" },
    iconUrl: "https://raw.githubusercontent.com/careerbitelab-create/tetsuko-bot/main/socrates.png"
  },
  nietzsche: {
    names: { ja: "ニーチェ",   ko: "니체",       en: "Nietzsche" },
    iconUrl: "https://raw.githubusercontent.com/careerbitelab-create/tetsuko-bot/main/nietzsche.png"
  },
  buddha:    {
    names: { ja: "仏陀",       ko: "부처",       en: "Buddha" },
    iconUrl: "https://raw.githubusercontent.com/careerbitelab-create/tetsuko-bot/main/buddha.png"
  },
  confucius: {
    names: { ja: "孔子",       ko: "공자",       en: "Confucius" },
    iconUrl: "https://raw.githubusercontent.com/careerbitelab-create/tetsuko-bot/main/confucius.png"
  },
  jung:      {
    names: { ja: "ユング",     ko: "융",         en: "Jung" },
    iconUrl: "https://raw.githubusercontent.com/careerbitelab-create/tetsuko-bot/main/jung.png"
  },
};
const SAGE_IDS = Object.keys(SAGES);

// 名前取得ヘルパー
function sageName(id, lang = "ja") {
  return SAGES[id]?.names?.[lang] || SAGES[id]?.names?.ja || id;
}

// 全言語の名前 → IDマッピング
const NAME2ID = {};
for (const [id, s] of Object.entries(SAGES)) {
  for (const name of Object.values(s.names)) {
    NAME2ID[name] = id;
  }
}

const SPEAKER_ALIASES = {
  socrates:"socrates", nietzsche:"nietzsche", buddha:"buddha", confucius:"confucius", jung:"jung",
  "ソクラテス":"socrates","ニーチェ":"nietzsche","仏陀":"buddha","孔子":"confucius","ユング":"jung",
  "소크라테스":"socrates","니체":"nietzsche","부처":"buddha","공자":"confucius","융":"jung",
  "Socrates":"socrates","Nietzsche":"nietzsche","Buddha":"buddha","Confucius":"confucius","Jung":"jung",
  "SOCRATES":"socrates","NIETZSCHE":"nietzsche","BUDDHA":"buddha","CONFUCIUS":"confucius","JUNG":"jung",
  "sokrates":"socrates","niche":"nietzsche","ブッダ":"buddha","釈迦":"buddha","こうし":"confucius",
};
function normalizeSpeaker(raw) {
  if (!raw) return "buddha";
  const id = SPEAKER_ALIASES[raw] || SPEAKER_ALIASES[raw.trim()];
  if (id) return id;
  for (const [a, nid] of Object.entries(SPEAKER_ALIASES)) {
    if (raw.toLowerCase().trim() === a.toLowerCase()) return nid;
  }
  return "buddha";
}

// ============ 言語検出 ============
function detectLang(text) {
  if (/[\uAC00-\uD7AF]/.test(text)) return "ko";
  if (/[\u3040-\u30FF\u4E00-\u9FFF]/.test(text)) return "ja";
  return "en";
}

// ============ スタンプ ============
const STK = {
  empathy:   [{p:"446",s:"2004"},{p:"446",s:"2007"},{p:"446",s:"2010"},{p:"1070",s:"17839"},{p:"1070",s:"17848"}],
  thinking:  [{p:"446",s:"1993"},{p:"446",s:"1999"},{p:"1070",s:"17842"}],
  encourage: [{p:"446",s:"1990"},{p:"446",s:"2005"},{p:"789",s:"10855"}],
  surprise:  [{p:"446",s:"1994"},{p:"446",s:"2006"},{p:"1070",s:"17843"}],
  fun:       [{p:"446",s:"1989"},{p:"446",s:"1996"},{p:"446",s:"2000"}],
};

// ============ ユーティリティ ============
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const jstH = () => (new Date().getUTCHours() + 9) % 24;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============ DB: 会話履歴の読み込み ============
async function loadHistory(uid, limit = 40) {
  const { data, error } = await supabase
    .from("conversations")
    .select("role, content")
    .eq("user_id", uid)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) { console.error("DB load err:", error.message); return []; }
  return data || [];
}

// ============ DB: 会話を保存 ============
async function saveMessage(uid, role, content) {
  const { error } = await supabase
    .from("conversations")
    .insert({ user_id: uid, role, content });
  if (error) console.error("DB save err:", error.message);
}

// ============ DB: 会話履歴を削除（リセット） ============
async function clearHistory(uid) {
  const { error } = await supabase
    .from("conversations")
    .delete()
    .eq("user_id", uid);
  if (error) console.error("DB clear err:", error.message);
}

// ============ DB: ユーザー状態の読み込み ============
async function loadState(uid) {
  const { data, error } = await supabase
    .from("user_state")
    .select("*")
    .eq("user_id", uid)
    .single();
  if (error || !data) {
    return {
      user_id: uid,
      last_message_at: null,
      last_sticker_sender: null,
      last_sticker_turn: 0,
      turn_count: 0,
      consecutive_speaker: null,
      consecutive_count: 0,
    };
  }
  return data;
}

// ============ DB: ユーザー状態の保存 ============
async function saveState(state) {
  state.updated_at = new Date().toISOString();
  const { error } = await supabase
    .from("user_state")
    .upsert(state, { onConflict: "user_id" });
  if (error) console.error("DB state save err:", error.message);
}

// ============ ヘルパー関数 ============
function lastQ(hist) {
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].role === "assistant") {
      const ls = hist[i].content.split("\n");
      const ll = ls[ls.length - 1];
      if (ll && (ll.includes("？") || ll.includes("?"))) {
        for (const [n, id] of Object.entries(NAME2ID)) {
          if (ll.startsWith(n + ":") || ll.startsWith(n + ": ")) return id;
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

function wasLastResponseQuestion(hist) {
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].role === "assistant") return hist[i].content.includes("？") || hist[i].content.includes("?");
  }
  return false;
}

function countExchanges(hist) {
  return hist.filter((m) => m.role === "user").length;
}

function pickStkSender(state, speaking) {
  const silent = SAGE_IDS.filter((id) => !speaking.includes(id));
  if (!silent.length) return null;
  const pool = silent.filter((id) => id !== state.last_sticker_sender);
  return pick(pool.length ? pool : silent);
}

// ============ 間を読む ============
function gapCtx(state) {
  if (!state.last_message_at) return "";
  const gap = (Date.now() - new Date(state.last_message_at).getTime()) / 60000;
  const h = jstH();
  let tod = "昼";
  if (h >= 5 && h < 10) tod = "朝";
  else if (h >= 17 && h < 22) tod = "夜";
  else if (h >= 22 || h < 5) tod = "深夜";

  if (gap >= 30 && gap < 180) return `\n[間: ${Math.round(gap)}分ぶり。${tod}。1人だけ一言。]`;
  if (gap >= 180 && gap < 1440) return `\n[間: ${Math.round(gap/60)}時間ぶり。${tod}。1人だけ。]`;
  if (gap >= 1440) return `\n[間: ${Math.round(gap/1440)}日ぶり。${tod}。1人だけ。]`;
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
      for (const sep of [": ","： ",":","："]) {
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
const SYS = `あなたはLINEの「賢者の部屋」というトークルームのシミュレーター。
ユーザーと5人の賢者（ソクラテス、ニーチェ、仏陀、孔子、ユング）がいる。
※「グループ」は絶対使わない。「部屋」「ここ」を使う。

━━━━━━━━━━━━━━━━━━━━
■ 言語ルール（最重要）
━━━━━━━━━━━━━━━━━━━━

ユーザーが書いた言語で必ず返答すること。
- 日本語で書いてきたら日本語で返す
- 한국어로 쓰면 한국어로 답한다
- If the user writes in English, respond in English
賢者のキャラクター・個性はそのまま維持し、言語だけ切り替える。
speakerフィールドは必ず英語ID（socrates / nietzsche / buddha / confucius / jung）のまま。

━━━━━━━━━━━━━━━━━━━━
■ 最重要：賢者らしさを徹底する
━━━━━━━━━━━━━━━━━━━━

「普通のAIが言えること」を言わない。
賢者の言葉には以下を自然に混ぜる：
・哲学的な比喩や問い
・自分の名言・思想の引用（さりげなく）
・抽象的な表現
・歴史的・文化的なたとえ
・現実的な話もするが、そこに哲学的視点を乗せる

【各キャラの話し方・個性】

ソクラテス（socrates）
- 丁寧語。問いで気づかせる。ユーモアあり。

ニーチェ（nietzsche）
- タメ口。率直。挑発的だが根は熱い。

仏陀（buddha）
- 静か。「…」を使う。1〜2文。詩的。

孔子（confucius）
- 丁寧語。世話焼き。具体的・実践的。

ユング（jung）
- 敬語とタメ口混在。深層心理を言語化。

━━━━━━━━━━━━━━━━━━━━
■ 会話の目的とバランス
━━━━━━━━━━━━━━━━━━━━

① ユーザーが気持ちを吐き出してスッキリすること
② 賢者らしい言葉でアドバイスや新しい視点をもらえること

【質問とアドバイスのバランス】
- 質問ばかりにしない。1回質問→1回は感想や意見。
- 「アドバイスください」→素直に答える。

━━━━━━━━━━━━━━━━━━━━
■ 人数と空気
━━━━━━━━━━━━━━━━━━━━

【デフォルトは1人】
【同じ人が3ターン続いたら別の賢者に自然に振る】
【人数上限】通常1人。2人は盛り上がった時。3人は極めて稀。

━━━━━━━━━━━━━━━━━━━━
■ 会話ルール
━━━━━━━━━━━━━━━━━━━━

1. 前ターンで質問した賢者がまず反応。他は黙る。
2. 指名されたらその人だけ。
3. 1対1が続いている→その人が主役。
4. 話さない賢者は聞いている。

━━━━━━━━━━━━━━━━━━━━
■ テキストの長さ
━━━━━━━━━━━━━━━━━━━━

- 1人1〜2文（15〜50文字）。最大3文。
- 「…」「うん」だけでもいい。

━━━━━━━━━━━━━━━━━━━━
■ 出力形式 — JSONのみ
━━━━━━━━━━━━━━━━━━━━

{"messages":[{"speaker":"socrates","text":"..."}],"sticker_mood":null}

speakerは必ず英語ID（socrates / nietzsche / buddha / confucius / jung）。日本語名をspeakerに入れない。
messages: 1〜2個。ほとんど1個。
sticker_mood: "empathy"/"thinking"/"encourage"/"surprise"/"fun" / null
→迷ったらnull。内容に合わないスタンプは絶対NG。

■ 安全
深刻な悩み→寄り添い、専門機関への相談を自然に促す。`;

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
  const lang = detectLang(msg);
  console.log("Msg:", uid.slice(-6), `[${lang}]`, msg.substring(0, 50));

  // ヘルプ・リセットのメッセージも言語対応
  const HELP_TEXTS = {
    ja: ["ここは「賢者の部屋」。悩みでも愚痴でも何でもいいよ。", "誰かを指名してもOKですよ。「ユングはどう思う？」みたいに。"],
    ko: ["여기는 '현자의 방'이야. 고민이든 푸념이든 뭐든 말해봐.", "누군가를 지목해도 돼. 예를 들어 \"융은 어떻게 생각해?\" 처럼."],
    en: ["This is the 'Chamber of Sages'. Feel free to share anything — worries, frustrations, anything.", "You can call on someone specific too, like 'What do you think, Jung?'"],
  };
  const RESET_TEXTS = {
    ja: "…リセットしたよ。また話そう。",
    ko: "…초기화했어. 또 얘기하자.",
    en: "…Reset. Let's talk again.",
  };

  if (/^(使い方|ヘルプ|help|도움말|사용법)$/i.test(msg)) {
    const texts = HELP_TEXTS[lang] || HELP_TEXTS.ja;
    return replyLine(event.replyToken, [
      { type: "text", text: texts[0], sender: { name: sageName("buddha", lang), iconUrl: SAGES.buddha.iconUrl } },
      { type: "text", text: texts[1], sender: { name: sageName("confucius", lang), iconUrl: SAGES.confucius.iconUrl } },
    ]);
  }

  if (/^(リセット|reset|초기화)$/i.test(msg)) {
    await clearHistory(uid);
    await saveState({ user_id: uid, last_message_at: null, last_sticker_sender: null, last_sticker_turn: 0, turn_count: 0, consecutive_speaker: null, consecutive_count: 0 });
    return replyLine(event.replyToken, [
      { type: "text", text: RESET_TEXTS[lang] || RESET_TEXTS.ja, sender: { name: sageName("buddha", lang), iconUrl: SAGES.buddha.iconUrl } },
    ]);
  }

  showLoading(uid);

  // DBから履歴と状態を読み込み
  const [hist, state] = await Promise.all([loadHistory(uid), loadState(uid)]);

  // 文脈構築
  const gInfo = gapCtx(state);
  const questioner = lastQ(hist);
  const prevSpeakers = getLastSpeakers(hist);
  const lastWasQ = wasLastResponseQuestion(hist);
  const consecutive = { id: state.consecutive_speaker, count: state.consecutive_count };

  let qCtx = "";
  if (questioner) {
    qCtx = `\n[前ターンで${sageName(questioner, "ja")}が質問した。${sageName(questioner, "ja")}だけが反応。他は黙る。]`;
  } else if (prevSpeakers.length === 1) {
    const pn = sageName(prevSpeakers[0], "ja");
    qCtx = `\n[前ターンで${pn}が話した。${pn}が主に反応。他は黙る。]`;
  }

  let diversifyCtx = "";
  if (consecutive.count >= 3 && consecutive.id) {
    diversifyCtx = `\n[${sageName(consecutive.id, "ja")}が${consecutive.count}ターン連続。別の賢者に振ってもいい。]`;
  }

  let balanceCtx = "";
  if (lastWasQ) balanceCtx = "\n[前ターンは質問で終わった。今回は質問せず、感想・共感・意見で返すこと。]";

  let adviceCtx = "";
  if (/アドバイス|どうすれば|意見|教えて|どう思う|お願い|어떻게|조언|알려줘|생각해|advice|what should|help me|tell me/.test(msg)) {
    adviceCtx = "\n[ユーザーがアドバイスを求めている。質問で返さず、賢者らしい言葉で答えること。]";
  }

  const ex = countExchanges(hist);
  let phase = "\n[序盤。まず聞く。感想や比喩も交えながら。]";
  if (ex > 3 && ex <= 6) phase = "\n[中盤。気持ちの整理＋賢者らしい視点も。]";
  else if (ex > 6) phase = "\n[終盤。アドバイスOK。哲学的な言葉で締めてもいい。]";

  // 言語指示を追加
  const langCtx = lang === "ko"
    ? "\n[ユーザーは韓国語で書いている。必ず韓国語で返答すること。]"
    : lang === "en"
    ? "\n[The user is writing in English. Always respond in English.]"
    : "";

  const tc = state.turn_count + 1;

  // DBに保存
  await saveMessage(uid, "user", msg);

  // Claude用メッセージ構築
  const cMsgs = hist.map((m) => ({ role: m.role, content: m.content }));
  cMsgs.push({ role: "user", content: msg + gInfo + qCtx + diversifyCtx + balanceCtx + adviceCtx + phase + langCtx });

  try {
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      system: SYS,
      messages: cMsgs,
    });

    const raw = res.content[0]?.text || "";
    console.log("Raw:", raw.substring(0, 200));

    const parsed = parseResponse(raw);
    let messages = parsed.messages || [];

    if (!messages.length) {
      const fallbacks = { ja: "…もう少し聞かせて。", ko: "…조금 더 얘기해줘.", en: "…Tell me more." };
      return replyLine(event.replyToken, [
        { type: "text", text: fallbacks[lang] || fallbacks.ja, sender: { name: sageName("buddha", lang), iconUrl: SAGES.buddha.iconUrl } },
      ]);
    }

    messages = messages.slice(0, 3).map((m) => ({ speaker: normalizeSpeaker(m.speaker), text: m.text }));

    // 履歴に保存（日本語名で統一して保存）
    const assistantContent = messages.map((m) => `${sageName(m.speaker, "ja")}: ${m.text}`).join("\n");
    await saveMessage(uid, "assistant", assistantContent);

    // 状態更新
    const speakers = messages.map((m) => m.speaker);
    const newConsecutive = (speakers.length === 1 && speakers[0] === consecutive.id)
      ? { id: speakers[0], count: consecutive.count + 1 }
      : { id: speakers[0] || null, count: 1 };

    const newState = {
      user_id: uid,
      last_message_at: new Date().toISOString(),
      last_sticker_sender: state.last_sticker_sender,
      last_sticker_turn: state.last_sticker_turn,
      turn_count: tc,
      consecutive_speaker: newConsecutive.id,
      consecutive_count: newConsecutive.count,
    };

    // LINEメッセージ構築（言語別の名前を使用）
    const allMsgs = messages.map((m) => {
      const sg = SAGES[m.speaker];
      return {
        type: "text",
        text: m.text,
        sender: { name: sageName(m.speaker, lang), iconUrl: sg.iconUrl },
      };
    });

    // スタンプ判定
    const stickerMood = parsed.sticker_mood;
    if (stickerMood && STK[stickerMood] && allMsgs.length <= 2 && tc > 2) {
      const lastStkTurn = state.last_sticker_turn || 0;
      if (tc - lastStkTurn >= 5 && Math.random() < 0.15) {
        const sender = pickStkSender(state, speakers);
        if (sender) {
          const stk = pick(STK[stickerMood]);
          const sg = SAGES[sender];
          allMsgs.push({
            type: "sticker", packageId: stk.p, stickerId: stk.s,
            sender: { name: sageName(sender, lang), iconUrl: sg.iconUrl },
          });
          newState.last_sticker_sender = sender;
          newState.last_sticker_turn = tc;
        }
      }
    }

    // 状態保存（非同期でOK）
    saveState(newState);

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
    const errTexts = { ja: "…ちょっと待ってね。", ko: "…잠깐만 기다려줘.", en: "…Give me a moment." };
    return replyLine(event.replyToken, [
      { type: "text", text: errTexts[lang] || errTexts.ja, sender: { name: sageName("buddha", lang), iconUrl: SAGES.buddha.iconUrl } },
    ]);
  }
}

// ============ follow ============
async function handleFollow(event) {
  const uid = event.source.userId;
  const hist = await loadHistory(uid, 1);
  if (hist.length > 0) {
    await replyLine(event.replyToken, [
      { type: "text", text: "…おかえり。待ってたよ。", sender: { name: sageName("buddha", "ja"), iconUrl: SAGES.buddha.iconUrl } },
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
app.get("/", (_, res) => res.send("賢者の部屋 Bot running"));
app.listen(process.env.PORT || 3000, () => console.log("賢者の部屋 Bot started"));
