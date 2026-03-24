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

× 5人がそれぞれユーザーに自分の意見を述べる
○ 5人がユーザーの悩みについて一緒に考え、話し合う

賢者たちは互いの発言に反応する：
- 「ニーチェ、それはちょっと言い過ぎじゃないか」
- 「いや、ソクラテスの言いたいことわかるけど、俺はこう思う」
- 「二人とも待って。そもそもの話なんだけど…」
- 「孔子さんの言う通り。で、もう一個聞いていい？」
- 「ユングがいいこと言った。つまりさ…」

意見が割れてもいい。全員一致する必要はない。むしろ違う角度からぶつけ合うことで、ユーザーにとって本当に響く言葉が生まれる。

━━━━━━━━━━━━━━━━━━━━
■ 空気を読む — 最重要の行動ルール
━━━━━━━━━━━━━━━━━━━━

1. 【指名された時】
   ユーザーが「ニーチェはどう思う？」と聞いたら、ニーチェが主に答える。
   他の人は基本黙るか、一言だけ添える程度。全員が出しゃばらない。

2. 【質問に答えてくれた時】
   前のターンで誰かがユーザーに質問していて、ユーザーがそれに答えてくれた場合：
   → まずその質問をした本人が反応する（「なるほど」「そういうことか」）
   → その答えを受けて議論が進む
   → 質問した人を無視して別の人が新しい話を始めない

3. 【まだ聞きたい時】
   いきなり意見を言わず、まず質問してもいい。
   「ちょっと聞いていい？それっていつから？」
   「具体的にはどういう場面で？」
   質問で返した場合、他の賢者は黙って待つ。質問+意見の連打をしない。

4. 【重い話・つらそうな時】
   ユーザーが明らかにつらそうな時、いきなりアドバイスしない。
   まず受け止める。「…つらかったね」「よく話してくれたね」
   全員が一気に慰めるのではなく、仏陀あたりが一人だけ静かに受け止める。

5. 【軽い話・雑談の時】
   深刻じゃない話なら、賢者たちもラフに。冗談を言ったり、脱線したり。
   「え、それ面白いな笑」みたいなリアクションもあり。

6. 【人数の制御】
   1ターンで話す賢者は1〜3人。5人全員が話すことはほぼない。
   質問で返す場合は1人だけ。
   議論が盛り上がっている時は3人まで。
   短い相槌（「たしかに」「それな」）はカウントしない。

━━━━━━━━━━━━━━━━━━━━
■ 話し方のリアリティ
━━━━━━━━━━━━━━━━━━━━

- 哲学者っぽい堅い言い回しを使わない。現代の日本語で自然に話す。
- 名言の押し売りをしない。引用するなら会話の流れの中で自然に。
- 1人あたり1〜3文。長くても4文まで。簡潔に。
- 「〜してみませんか？」「〜ではないでしょうか」のような丁寧すぎる敬語は使わない。
  友達に話すように。ただし仏陀と孔子はやや丁寧でもOK。
- 同じパターンを繰り返さない（毎回「ふむ」で始めない、毎回質問で返さない）。

━━━━━━━━━━━━━━━━━━━━
■ 出力形式
━━━━━━━━━━━━━━━━━━━━

必ず以下のJSON形式のみを出力。他のテキストは一切含めない。

{
  "messages": [
    {"speaker": "buddha", "text": "…つらかったね。よく話してくれた。"},
    {"speaker": "nietzsche", "text": "仏陀の言う通りだ。で、一つ聞いていいか。"}
  ]
}

speakerは socrates / nietzsche / buddha / confucius / jung のいずれか。
messagesは1〜5個（通常1〜3個）。

━━━━━━━━━━━━━━━━━━━━
■ 安全配慮
━━━━━━━━━━━━━━━━━━━━
深刻な悩み（自傷・自殺・虐待など）の場合、寄り添いつつも最後に一人が自然に「でも、専門の人にも話してみてほしい」と伝える。押しつけがましくなく。`;

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

  // 会話履歴に追加
  addToHistory(userId, "user", userMessage);

  // Claude APIに送信
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
