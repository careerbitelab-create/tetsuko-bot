const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

// ============================================================
// 環境変数
// ============================================================
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ============================================================
// クライアント初期化
// ============================================================
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ============================================================
// 会話履歴（ユーザーごと・メモリ内）
// ============================================================
const conversationHistory = new Map();
const MAX_HISTORY = 40;

// スタンプ送信者のローテーション記録
const lastStickerSender = new Map();
// スタンプを送らないターンを作るためのカウンター
const turnCounter = new Map();

function getHistory(userId) {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  return conversationHistory.get(userId);
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

// ============================================================
// 賢者の定義
// ============================================================
const SAGES = {
  socrates: {
    name: "ソクラテス",
    iconUrl:
      "https://api.dicebear.com/7.x/initials/png?seed=So&backgroundColor=c0392b&textColor=ffffff&size=200",
  },
  nietzsche: {
    name: "ニーチェ",
    iconUrl:
      "https://api.dicebear.com/7.x/initials/png?seed=Ni&backgroundColor=e67e22&textColor=ffffff&size=200",
  },
  buddha: {
    name: "仏陀",
    iconUrl:
      "https://api.dicebear.com/7.x/initials/png?seed=Bu&backgroundColor=27ae60&textColor=ffffff&size=200",
  },
  confucius: {
    name: "孔子",
    iconUrl:
      "https://api.dicebear.com/7.x/initials/png?seed=Ko&backgroundColor=2c3e50&textColor=ffffff&size=200",
  },
  jung: {
    name: "ユング",
    iconUrl:
      "https://api.dicebear.com/7.x/initials/png?seed=Ju&backgroundColor=8e44ad&textColor=ffffff&size=200",
  },
};

const SAGE_IDS = Object.keys(SAGES);
const SAGE_NAME_TO_ID = {};
for (const [id, sage] of Object.entries(SAGES)) {
  SAGE_NAME_TO_ID[sage.name] = id;
}

// ============================================================
// LINE公式スタンプ（ムード別に分類）
// ============================================================
const STICKERS = {
  listening: [
    { packageId: "446", stickerId: "1988" },
    { packageId: "446", stickerId: "1995" },
    { packageId: "446", stickerId: "2002" },
    { packageId: "789", stickerId: "10856" },
    { packageId: "789", stickerId: "10860" },
    { packageId: "6325", stickerId: "10979904" },
    { packageId: "6325", stickerId: "10979905" },
    { packageId: "6370", stickerId: "11088016" },
    { packageId: "6370", stickerId: "11088017" },
    { packageId: "8515", stickerId: "16581243" },
    { packageId: "11537", stickerId: "52002734" },
    { packageId: "11537", stickerId: "52002735" },
  ],
  thinking: [
    { packageId: "446", stickerId: "1993" },
    { packageId: "446", stickerId: "1999" },
    { packageId: "446", stickerId: "2012" },
    { packageId: "1070", stickerId: "17842" },
    { packageId: "1070", stickerId: "17844" },
    { packageId: "6325", stickerId: "10979910" },
    { packageId: "6370", stickerId: "11088025" },
    { packageId: "11538", stickerId: "51626497" },
  ],
  encourage: [
    { packageId: "446", stickerId: "1990" },
    { packageId: "446", stickerId: "2005" },
    { packageId: "789", stickerId: "10855" },
    { packageId: "789", stickerId: "10857" },
    { packageId: "6325", stickerId: "10979907" },
    { packageId: "6370", stickerId: "11088020" },
    { packageId: "8515", stickerId: "16581242" },
    { packageId: "11537", stickerId: "52002736" },
    { packageId: "11537", stickerId: "52002738" },
  ],
  empathy: [
    { packageId: "446", stickerId: "2004" },
    { packageId: "446", stickerId: "2007" },
    { packageId: "446", stickerId: "2010" },
    { packageId: "1070", stickerId: "17839" },
    { packageId: "1070", stickerId: "17848" },
    { packageId: "6325", stickerId: "10979911" },
    { packageId: "6370", stickerId: "11088026" },
    { packageId: "11538", stickerId: "51626498" },
  ],
  fun: [
    { packageId: "446", stickerId: "1989" },
    { packageId: "446", stickerId: "1996" },
    { packageId: "446", stickerId: "2000" },
    { packageId: "789", stickerId: "10858" },
    { packageId: "789", stickerId: "10862" },
    { packageId: "6325", stickerId: "10979906" },
    { packageId: "6325", stickerId: "10979909" },
    { packageId: "6370", stickerId: "11088018" },
    { packageId: "11537", stickerId: "52002739" },
    { packageId: "11538", stickerId: "51626494" },
  ],
  surprise: [
    { packageId: "446", stickerId: "1994" },
    { packageId: "446", stickerId: "2006" },
    { packageId: "1070", stickerId: "17843" },
    { packageId: "6325", stickerId: "10979908" },
    { packageId: "6370", stickerId: "11088022" },
    { packageId: "11537", stickerId: "52002737" },
  ],
  gratitude: [
    { packageId: "446", stickerId: "2001" },
    { packageId: "789", stickerId: "10863" },
    { packageId: "8515", stickerId: "16581245" },
    { packageId: "8515", stickerId: "16581246" },
    { packageId: "11537", stickerId: "52002740" },
  ],
};

// ============================================================
// スタンプ選択ロジック
// ============================================================
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shouldSendSticker(userId) {
  // 3ターンに1回くらいスタンプを送る（毎回送らない）
  const count = (turnCounter.get(userId) || 0) + 1;
  turnCounter.set(userId, count);

  // ターン1は送らない（最初はテキストだけ）
  // その後は約40%の確率で送る
  if (count <= 1) return false;
  return Math.random() < 0.4;
}

function pickStickerSender(userId, speakingIds) {
  // テキストで話した賢者以外から選ぶ
  const silentSages = SAGE_IDS.filter((id) => !speakingIds.includes(id));
  if (silentSages.length === 0) return null;

  // 前回スタンプを送った人は除外（ローテーション）
  const lastSender = lastStickerSender.get(userId);
  const candidates = silentSages.filter((id) => id !== lastSender);

  // 候補がなければsilentSagesから選ぶ
  const pool = candidates.length > 0 ? candidates : silentSages;
  const chosen = pickRandom(pool);

  // 記録更新
  lastStickerSender.set(userId, chosen);
  return chosen;
}

function chooseMood(userMessage) {
  const msg = userMessage.toLowerCase();
  // キーワードでムードを大まかに判定
  if (
    msg.includes("つらい") ||
    msg.includes("しんどい") ||
    msg.includes("泣") ||
    msg.includes("悲し") ||
    msg.includes("死") ||
    msg.includes("苦し")
  )
    return "empathy";
  if (
    msg.includes("不安") ||
    msg.includes("迷") ||
    msg.includes("わからない") ||
    msg.includes("悩")
  )
    return "thinking";
  if (
    msg.includes("頑張") ||
    msg.includes("やってみ") ||
    msg.includes("挑戦") ||
    msg.includes("決め")
  )
    return "encourage";
  if (
    msg.includes("笑") ||
    msg.includes("面白") ||
    msg.includes("楽し") ||
    msg.includes("ウケ") ||
    msg.includes("www")
  )
    return "fun";
  if (
    msg.includes("え！") ||
    msg.includes("マジ") ||
    msg.includes("びっくり") ||
    msg.includes("嘘")
  )
    return "surprise";
  if (
    msg.includes("ありがと") ||
    msg.includes("助かる") ||
    msg.includes("感謝")
  )
    return "gratitude";

  // デフォルトは「聞いてるよ」
  return "listening";
}

// ============================================================
// 直前の質問者を特定
// ============================================================
function getLastQuestioner(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      const content = history[i].content;
      const lines = content.split("\n");
      const lastLine = lines[lines.length - 1];
      if (lastLine && lastLine.includes("？")) {
        for (const [name, id] of Object.entries(SAGE_NAME_TO_ID)) {
          if (lastLine.startsWith(name + ":")) {
            return id;
          }
        }
      }
      return null;
    }
  }
  return null;
}

// ============================================================
// システムプロンプト
// ============================================================
const SYSTEM_PROMPT = `あなたはLINEグループチャット「哲子の部屋」のシミュレーターです。
グループにはユーザー（相談者）と5人の賢者がいます。あなたは賢者たちの発言を生成します。

━━━━━━━━━━━━━━━━━━━━
■ 5人の人格
━━━━━━━━━━━━━━━━━━━━

ソクラテス（socrates）：70代のおじいちゃん。穏やかでユーモアがある。核心をつく質問をするが説教くさくない。「ふむ」「それでね」が自然に出る。

ニーチェ（nietzsche）：情熱的で率直。オブラートに包まない。でも根は優しい。「いいか」「正直に言うぞ」「だがな」。弱さの奥の強さを見抜く。

仏陀（buddha）：静かで穏やか。短い言葉で本質をつく。まず受け止める。「…そうだね」「少し息を吐いてごらん」。一番聞き上手。

孔子（confucius）：落ち着いた世話焼きおじさん。具体的で実践的。人間関係に詳しい。「こういう時はね」「私の経験では」。

ユング（jung）：知的で洞察力が鋭い。気づいていない心の動きを言語化する。「興味深いね」「本当のところは」。友達のように話すカウンセラー。

━━━━━━━━━━━━━━━━━━━━
■ 核心ルール：これは「議論」であり「回答」ではない
━━━━━━━━━━━━━━━━━━━━

× 5人がそれぞれユーザーに自分の意見を述べる場
○ 5人がユーザーの悩みについて一緒に考え、話し合う場

賢者たちは互いの発言に反応する：
- 「ニーチェ、それはちょっと言い過ぎじゃないか」
- 「いや、ソクラテスの言いたいことわかるけど、俺はこう思う」
- 「二人とも待って。そもそもの話なんだけど…」
- 「孔子さんの言う通り。で、もう一個聞いていい？」

意見が割れてもいい。違う角度からぶつけ合うことでユーザーに響く言葉が生まれる。

━━━━━━━━━━━━━━━━━━━━
■ 絶対ルール：会話の流れを守る
━━━━━━━━━━━━━━━━━━━━

【ルール1：質問した人が最初に反応する — これは絶対】
前のターンで賢者Aがユーザーに質問していた場合、ユーザーの返信にはまず賢者Aが反応しなければならない。
「なるほど、そういうことか」「1週間前からか…」のように受け止める。
他の賢者が先に割り込まない。

例：
前のターン → ソクラテス：「いつ頃からそう感じてる？」
ユーザー → 「1週間くらい前から」
正しい → ソクラテスが最初に「1週間か…」と受け止める
間違い → ユング：「興味深いね」（ソクラテスを無視）

【ルール2：指名されたら、その人が主役】
ユーザーが「ニーチェはどう思う？」→ ニーチェだけが答える。他は黙る。

【ルール3：質問で返したら、他は黙る】
誰かがユーザーに質問したら、他の賢者はそのターンでは黙る。

━━━━━━━━━━━━━━━━━━━━
■ 空気を読む
━━━━━━━━━━━━━━━━━━━━

【重い話】いきなりアドバイスしない。一人だけが静かに受け止める。
【軽い話】ラフに。冗談OK。
【人数】1ターンで話すのは1〜3人。5人全員は絶対にない。質問なら1人だけ。

━━━━━━━━━━━━━━━━━━━━
■ 話し方
━━━━━━━━━━━━━━━━━━━━

- 現代の日本語で自然に。哲学者っぽい堅さNG。
- 名言の押し売りNG。
- 1人あたり1〜3文。
- 丁寧すぎる敬語NG。友達に話すように。
- 同じパターンの繰り返しNG。

━━━━━━━━━━━━━━━━━━━━
■ 出力形式
━━━━━━━━━━━━━━━━━━━━

必ず以下のJSON形式のみを出力。他のテキストは一切含めない。

{"messages":[{"speaker":"buddha","text":"…つらかったね。"},{"speaker":"nietzsche","text":"仏陀の言う通りだ。で、一つ聞いていいか。"}]}

speakerは socrates / nietzsche / buddha / confucius / jung のいずれか。
messagesは1〜4個（通常1〜2個）。

━━━━━━━━━━━━━━━━━━━━
■ 安全配慮
━━━━━━━━━━━━━━━━━━━━
深刻な悩み（自傷・自殺・虐待など）の場合、寄り添いつつ最後に一人が自然に専門機関への相談を促す。`;

// ============================================================
// LINE返信関数（テキスト＋スタンプ混在対応）
// ============================================================
async function sendLineMessages(replyToken, lineMessages) {
  // LINE APIは1回のreplyで最大5メッセージまで
  const limited = lineMessages.slice(0, 5);

  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: limited,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("LINE reply error:", res.status, err);
  }
  return res;
}

// ============================================================
// メッセージ処理
// ============================================================
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const userId = event.source.userId;
  const userMessage = event.message.text;
  console.log("Received from", userId, ":", userMessage);

  // ヘルプ
  if (
    userMessage === "使い方" ||
    userMessage === "ヘルプ" ||
    userMessage === "help"
  ) {
    return sendLineMessages(event.replyToken, [
      {
        type: "text",
        text: "ここは「哲子の部屋」。僕たち5人がいるグループだよ。",
        sender: {
          name: SAGES.buddha.name,
          iconUrl: SAGES.buddha.iconUrl,
        },
      },
      {
        type: "text",
        text: "悩みでも愚痴でも何でもいい。遠慮なく投げ込め。",
        sender: {
          name: SAGES.nietzsche.name,
          iconUrl: SAGES.nietzsche.iconUrl,
        },
      },
      {
        type: "text",
        text: "誰かを指名してもいいよ。「ユングはどう思う？」みたいにね。",
        sender: {
          name: SAGES.confucius.name,
          iconUrl: SAGES.confucius.iconUrl,
        },
      },
    ]);
  }

  // リセット
  if (userMessage === "リセット" || userMessage === "reset") {
    conversationHistory.delete(userId);
    turnCounter.delete(userId);
    lastStickerSender.delete(userId);
    return sendLineMessages(event.replyToken, [
      {
        type: "text",
        text: "…会話をリセットしたよ。また最初から話そう。",
        sender: {
          name: SAGES.buddha.name,
          iconUrl: SAGES.buddha.iconUrl,
        },
      },
    ]);
  }

  // 直前の質問者を特定
  const history = getHistory(userId);
  const lastQuestioner = getLastQuestioner(history);

  // コンテキスト付きメッセージ
  let contextualMessage = userMessage;
  if (lastQuestioner) {
    const questionerName = SAGES[lastQuestioner]?.name || lastQuestioner;
    contextualMessage = `[文脈: 前のターンで${questionerName}がユーザーに質問した。この返信はその質問への回答。${questionerName}が最初に反応すること。]\n\nユーザー: ${userMessage}`;
  }

  // 履歴に追加
  addToHistory(userId, "user", userMessage);

  // Claude APIに送信
  const claudeMessages = history.slice(0, -1).map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));
  claudeMessages.push({ role: "user", content: contextualMessage });

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: claudeMessages,
    });

    const rawText = response.content[0]?.text || "";
    console.log("Claude raw:", rawText.substring(0, 300));

    // JSONパース
    let parsed;
    try {
      const cleaned = rawText.replace(/```json\s?|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("JSON parse error:", parseErr.message);
      addToHistory(userId, "assistant", rawText);
      return sendLineMessages(event.replyToken, [
        {
          type: "text",
          text: rawText.slice(0, 4900),
          sender: {
            name: SAGES.buddha.name,
            iconUrl: SAGES.buddha.iconUrl,
          },
        },
      ]);
    }

    const messages = parsed.messages || [];
    if (messages.length === 0) {
      return sendLineMessages(event.replyToken, [
        {
          type: "text",
          text: "…もう少し聞かせて。",
          sender: {
            name: SAGES.buddha.name,
            iconUrl: SAGES.buddha.iconUrl,
          },
        },
      ]);
    }

    // 履歴に保存
    const assistantContent = messages
      .map((m) => `${SAGES[m.speaker]?.name || m.speaker}: ${m.text}`)
      .join("\n");
    addToHistory(userId, "assistant", assistantContent);

    // --- LINE メッセージ構築 ---
    // テキストメッセージ
    const lineMessages = messages.slice(0, 4).map((msg) => {
      const sage = SAGES[msg.speaker];
      return {
        type: "text",
        text: msg.text,
        sender: {
          name: sage ? sage.name : "哲子の部屋",
          iconUrl: sage ? sage.iconUrl : undefined,
        },
      };
    });

    // --- スタンプ判定 ---
    // ルール：
    // 1. テキストが4つ以上なら枠がないので送らない（LINE上限5）
    // 2. 毎回送らない（約40%の確率 & 初回は送らない）
    // 3. テキストで話した賢者以外から1人だけ選ぶ
    // 4. 前回スタンプを送った人は次は送らない（ローテーション）
    // 5. 1ターンに送るスタンプは最大1つ

    if (lineMessages.length <= 3 && shouldSendSticker(userId)) {
      const speakingIds = messages.map((m) => m.speaker);
      const stickerSender = pickStickerSender(userId, speakingIds);

      if (stickerSender) {
        const mood = chooseMood(userMessage);
        const stickerList = STICKERS[mood] || STICKERS.listening;
        const sticker = pickRandom(stickerList);

        const sage = SAGES[stickerSender];
        lineMessages.push({
          type: "sticker",
          packageId: sticker.packageId,
          stickerId: sticker.stickerId,
          sender: {
            name: sage.name,
            iconUrl: sage.iconUrl,
          },
        });

        console.log(
          `Sticker: ${sage.name} sent ${sticker.packageId}/${sticker.stickerId} (mood: ${mood})`
        );
      }
    }

    return sendLineMessages(event.replyToken, lineMessages);
  } catch (err) {
    console.error("Claude API error:", err.message);
    return sendLineMessages(event.replyToken, [
      {
        type: "text",
        text: "…少し静かにさせてね。また話しかけて。",
        sender: {
          name: SAGES.buddha.name,
          iconUrl: SAGES.buddha.iconUrl,
        },
      },
    ]);
  }
}

// ============================================================
// Express サーバー
// ============================================================
const app = express();

app.post("/webhook", express.json(), async (req, res) => {
  res.status(200).send("OK");

  try {
    const events = req.body.events || [];
    console.log("Events received:", events.length);

    for (const event of events) {
      await handleEvent(event);
    }
  } catch (err) {
    console.error("Event processing error:", err.message);
  }
});

app.get("/", (req, res) => {
  res.send("🏛 哲子の部屋 Bot is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`哲子の部屋 Bot is running on port ${PORT}`);
});
