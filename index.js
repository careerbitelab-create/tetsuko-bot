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
    iconUrl: "https://api.dicebear.com/7.x/initials/png?seed=So&backgroundColor=c0392b&textColor=ffffff&size=200",
  },
  nietzsche: {
    name: "ニーチェ",
    iconUrl: "https://api.dicebear.com/7.x/initials/png?seed=Ni&backgroundColor=e67e22&textColor=ffffff&size=200",
  },
  buddha: {
    name: "仏陀",
    iconUrl: "https://api.dicebear.com/7.x/initials/png?seed=Bu&backgroundColor=27ae60&textColor=ffffff&size=200",
  },
  confucius: {
    name: "孔子",
    iconUrl: "https://api.dicebear.com/7.x/initials/png?seed=Ko&backgroundColor=2c3e50&textColor=ffffff&size=200",
  },
  jung: {
    name: "ユング",
    iconUrl: "https://api.dicebear.com/7.x/initials/png?seed=Ju&backgroundColor=8e44ad&textColor=ffffff&size=200",
  },
};

// 名前→IDの逆引き
const SAGE_NAME_TO_ID = {};
for (const [id, sage] of Object.entries(SAGES)) {
  SAGE_NAME_TO_ID[sage.name] = id;
}

// ============================================================
// 直前の発言者を特定するヘルパー
// ============================================================
function getLastSpeakers(history) {
  // 直前のassistantメッセージから発言した賢者を特定
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      const content = history[i].content;
      const speakers = [];
      for (const [name, id] of Object.entries(SAGE_NAME_TO_ID)) {
        if (content.includes(name + ":")) {
          speakers.push(id);
        }
      }
      return speakers;
    }
  }
  return [];
}

// 直前に質問で終わった賢者を特定
function getLastQuestioner(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      const content = history[i].content;
      const lines = content.split("\n");
      // 最後の発言を見て、質問（？）で終わっているか
      const lastLine = lines[lines.length - 1];
      if (lastLine && lastLine.includes("？")) {
        // その行の発言者を特定
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
「なるほど、そういうことか」「1週間前からか…」のように、ユーザーの答えを受け止める。
他の賢者が先に割り込んではいけない。賢者Aが受け止めた後で、他の人が話すのはOK。

例：
前のターン → ソクラテス：「いつ頃からそう感じてる？」
ユーザー → 「1週間くらい前から」
正しい応答 → ソクラテスが最初に「1週間か…」と受け止める → その後に他の人が話してもOK
間違い → ユング：「興味深いね」（ソクラテスを無視して別の人が先に話す）

【ルール2：指名されたら、その人が主役】
ユーザーが「ニーチェはどう思う？」と聞いたら、ニーチェが主に答える。
他の賢者は黙る。出しゃばらない。ニーチェだけが答える。
どうしても一言添えたい場合は、ニーチェの後に1人だけ短く。

【ルール3：質問で返したら、他は黙る】
誰かがユーザーに質問を投げたら、他の賢者はそのターンでは黙る。
質問した後に他の賢者が意見を被せると、ユーザーは質問に答えづらくなる。
質問は1人だけ。待つ。

━━━━━━━━━━━━━━━━━━━━
■ 空気を読む
━━━━━━━━━━━━━━━━━━━━

【重い話・つらそうな時】
いきなりアドバイスしない。まず一人だけが静かに受け止める。
「…つらかったね」「よく話してくれたね」
全員が一気に慰めない。

【軽い話・雑談の時】
賢者たちもラフに。冗談、脱線OK。「え、それ面白いな笑」

【人数の制御】
1ターンで話す賢者は1〜3人。5人全員が話すことは絶対にない。
質問で返す場合は1人だけ。
会話が深まっている時（ユーザーと何往復もしている時）は1〜2人で十分。

━━━━━━━━━━━━━━━━━━━━
■ 話し方
━━━━━━━━━━━━━━━━━━━━

- 哲学者っぽい堅い言い回しを使わない。現代の日本語で自然に。
- 名言の押し売りをしない。
- 1人あたり1〜3文。長くても4文。
- 丁寧すぎる敬語は使わない。友達に話すように。
- 同じパターンを繰り返さない。

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
// LINE返信関数（アイコン切替対応）
// ============================================================
async function sendMessages(replyToken, messages) {
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

  // ヘルプ
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
        text: "悩みでも愚痴でも何でもいい。遠慮なく投げ込め。",
      },
      {
        speaker: "confucius",
        text: "誰かを指名してもいいよ。「ユングはどう思う？」みたいにね。",
      },
    ]);
  }

  // リセット
  if (userMessage === "リセット" || userMessage === "reset") {
    conversationHistory.delete(userId);
    return sendMessages(event.replyToken, [
      {
        speaker: "buddha",
        text: "…会話をリセットしたよ。また最初から話そう。",
      },
    ]);
  }

  // 直前の質問者を特定してコンテキストに含める
  const history = getHistory(userId);
  const lastQuestioner = getLastQuestioner(history);
  const lastSpeakers = getLastSpeakers(history);

  // ユーザーメッセージに文脈ヒントを追加
  let contextualMessage = userMessage;
  if (lastQuestioner) {
    const questionerName = SAGES[lastQuestioner]?.name || lastQuestioner;
    contextualMessage = `[文脈: 前のターンで${questionerName}がユーザーに質問した。この返信はその質問への回答。${questionerName}が最初に反応すること。]\n\nユーザー: ${userMessage}`;
  }

  // 会話履歴に追加（実際のメッセージのみ保存）
  addToHistory(userId, "user", userMessage);

  // Claude APIに送信（コンテキスト付きメッセージを最後に使う）
  const claudeMessages = history.slice(0, -1).map((msg) => ({
    role: msg.role,
    content: msg.content,
  }));
  // 最後のユーザーメッセージはコンテキスト付き
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
      console.error("Raw text:", rawText.substring(0, 500));
      addToHistory(userId, "assistant", rawText);
      return sendMessages(event.replyToken, [
        { speaker: "buddha", text: rawText.slice(0, 4900) },
      ]);
    }

    const messages = parsed.messages || [];
    if (messages.length === 0) {
      return sendMessages(event.replyToken, [
        { speaker: "buddha", text: "…もう少し聞かせて。" },
      ]);
    }

    // 会話履歴に保存
    const assistantContent = messages
      .map((m) => `${SAGES[m.speaker]?.name || m.speaker}: ${m.text}`)
      .join("\n");
    addToHistory(userId, "assistant", assistantContent);

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
