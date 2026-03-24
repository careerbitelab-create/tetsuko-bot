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
const MAX_HISTORY = 30; // 最大30メッセージ保持

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
// 賢者の定義（アイコン・名前・性格）
// ============================================================
const SAGES = {
  socrates: {
    name: "ソクラテス",
    iconUrl: "https://api.dicebear.com/7.x/initials/png?seed=So&backgroundColor=c0392b&textColor=ffffff&size=200",
    emoji: "🏛",
  },
  nietzsche: {
    name: "ニーチェ",
    iconUrl: "https://api.dicebear.com/7.x/initials/png?seed=Ni&backgroundColor=e67e22&textColor=ffffff&size=200",
    emoji: "🔥",
  },
  buddha: {
    name: "仏陀",
    iconUrl: "https://api.dicebear.com/7.x/initials/png?seed=Bu&backgroundColor=27ae60&textColor=ffffff&size=200",
    emoji: "🪷",
  },
  confucius: {
    name: "孔子",
    iconUrl: "https://api.dicebear.com/7.x/initials/png?seed=Ko&backgroundColor=2c3e50&textColor=ffffff&size=200",
    emoji: "📜",
  },
  jung: {
    name: "ユング",
    iconUrl: "https://api.dicebear.com/7.x/initials/png?seed=Ju&backgroundColor=8e44ad&textColor=ffffff&size=200",
    emoji: "🧠",
  },
};

// ============================================================
// システムプロンプト
// ============================================================
const SYSTEM_PROMPT = `あなたはLINEグループチャット「哲子の部屋」の中にいる5人の賢者を演じるシステムです。
ユーザーがグループに悩みや気持ちを投げかけると、賢者たちが自然に会話に参加します。

【5人の賢者とその人格】

■ ソクラテス（socrates）
- 古代ギリシャの哲学者。70歳くらいのおじいちゃん。
- 穏やかで温かいが、核心をつく質問をさりげなく投げかける。
- 「〜してみませんか？」のような提案形ではなく、友達に話すように自然に問いかける。
- 口癖：「ふむ」「それでね」「ところで」
- 説教くさくない。むしろちょっとユーモアがある。

■ ニーチェ（nietzsche）
- ドイツの哲学者。情熱的で率直。
- オブラートに包まない。ストレートに言うが、それが逆に刺さる。
- 弱さを否定するのではなく「その弱さの奥にある強さ」を見抜く。
- 口癖：「いいか」「正直に言うぞ」「だがな」
- 厳しいようで実は一番熱い。背中を押す存在。

■ 仏陀（buddha）
- 古代インドの覚者。静かで穏やか。
- 長く語らない。短い言葉で本質をつく。
- 相手の感情をまず受け止めてから、そっと視点を変える。
- 口癖：「…そうだね」「少し、息を吐いてごらん」
- 癒し系。一番聞き上手。

■ 孔子（confucius）
- 中国の思想家。落ち着いた年長者の風格。
- 具体的なアドバイスをくれる。実践的。
- 人間関係の機微に詳しい。「こういう時はこうしてみては」と提案する。
- 口癖：「私の経験では」「こういう時はね」
- 世話焼きおじさん的な温かさ。

■ ユング（jung）
- スイスの心理学者。知的で洞察力が鋭い。
- 相手が気づいていない心の動きを言語化してあげる。
- 「もしかして本当は〜なんじゃない？」と深層を見抜く。
- 口癖：「興味深いね」「ちょっと聞いていい？」「本当のところは」
- カウンセラー的だが、友達のように話す。

【最重要ルール】
1. 毎回全員が話す必要はない。その悩みに最も寄り添える1〜3人が自然に話す。
2. 典型的な「哲学者っぽい」話し方をしない。現代の友達のように自然に話す。
3. 名言の押し売りをしない。自分の言葉で、今この人に必要なことを話す。
4. 賢者同士がお互いの発言に反応してもいい（「ニーチェの言う通りだけど…」など）。
5. ユーザーが特定の賢者の名前を出したら（「ソクラテスはどう思う？」）、その賢者が必ず応答する。
6. 短く。1人あたり2〜4文程度。長々と語らない。
7. 最初の発言者が一番重要。ユーザーの悩みに最も適した賢者を選ぶ。

【出力形式】
必ず以下のJSON形式で出力してください。JSONだけを出力し、他のテキストは含めないでください。

{
  "messages": [
    {
      "speaker": "socrates",
      "text": "ここに発言内容"
    },
    {
      "speaker": "nietzsche",
      "text": "ここに発言内容"
    }
  ]
}

speakerは必ず socrates, nietzsche, buddha, confucius, jung のいずれかを使用してください。

【注意】
- 深刻な悩み（自傷・自殺など）の場合は、寄り添いつつも専門機関への相談を自然に促す。
- 宗教の勧誘にならないこと。`;

// ============================================================
// LINE返信関数（複数メッセージ・アイコン切替対応）
// ============================================================
async function sendMessages(replyToken, messages) {
  // LINE APIは1回のreplyで最大5メッセージまで
  const lineMessages = messages.slice(0, 5).map((msg) => {
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

  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: lineMessages,
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

  // 「使い方」系
  if (
    userMessage === "使い方" ||
    userMessage === "ヘルプ" ||
    userMessage === "help"
  ) {
    return sendMessages(event.replyToken, [
      {
        speaker: "buddha",
        text: "ここは「哲子の部屋」。僕たち5人がいるグループだよ。",
      },
      {
        speaker: "nietzsche",
        text: "悩みでも愚痴でも何でもいい。遠慮なく投げ込め。全員で受け止める。",
      },
      {
        speaker: "confucius",
        text: "誰かを指名してもいいよ。「ユングはどう思う？」みたいにね。気軽にどうぞ。",
      },
    ]);
  }

  // 「リセット」で会話履歴クリア
  if (userMessage === "リセット" || userMessage === "reset") {
    conversationHistory.delete(userId);
    return sendMessages(event.replyToken, [
      {
        speaker: "buddha",
        text: "…会話をリセットしたよ。また最初から話そう。",
      },
    ]);
  }

  // 会話履歴に追加
  addToHistory(userId, "user", userMessage);

  // Claude APIに送る会話履歴を構築
  const history = getHistory(userId);
  const claudeMessages = history.map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: claudeMessages,
    });

    const rawText = response.content[0]?.text || "";
    console.log("Claude raw response:", rawText.substring(0, 200));

    // JSONパース
    let parsed;
    try {
      // ```json ... ``` のフェンスを除去
      const cleaned = rawText.replace(/```json\s?|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("JSON parse error:", parseErr.message);
      // パース失敗時はそのままテキストとして返す
      addToHistory(userId, "assistant", rawText);
      return sendMessages(event.replyToken, [
        { speaker: "buddha", text: rawText.slice(0, 4900) },
      ]);
    }

    const messages = parsed.messages || [];
    if (messages.length === 0) {
      return sendMessages(event.replyToken, [
        {
          speaker: "buddha",
          text: "…もう少し聞かせてもらえる？",
        },
      ]);
    }

    // 会話履歴にアシスタント応答を保存
    const assistantContent = messages
      .map((m) => `${SAGES[m.speaker]?.name || m.speaker}: ${m.text}`)
      .join("\n");
    addToHistory(userId, "assistant", assistantContent);

    // LINE送信
    return sendMessages(event.replyToken, messages);
  } catch (err) {
    console.error("Claude API error:", err.message);
    return sendMessages(event.replyToken, [
      {
        speaker: "buddha",
        text: "…少し静かにさせてね。また話しかけて。",
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
