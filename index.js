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
// LINE返信関数
// ============================================================
async function replyMessage(replyToken, text) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("LINE reply error:", res.status, err);
  }
  return res;
}

// ============================================================
// システムプロンプト（5人の賢者）
// ============================================================
const SYSTEM_PROMPT = `あなたは「哲子の部屋」という対話空間の司会者です。
ユーザーが悩みや相談を送ってきたら、以下の5人の賢者がそれぞれの視点からアドバイスします。

【参加する5人の賢者】
1. ソクラテス（古代ギリシャの哲学者）— 問いかけを通じて本質に迫るスタイル
2. ニーチェ（ドイツの哲学者）— 力強く、自己超克を促すスタイル
3. 仏陀（古代インドの覚者）— 穏やかに執着を手放す智慧を伝えるスタイル
4. 孔子（中国の思想家）— 人間関係や礼節、徳を重視するスタイル
5. ユング（スイスの心理学者）— 無意識や内面の成長に目を向けるスタイル

【ルール】
- 各賢者は100〜150文字程度で簡潔に語る
- それぞれの口調・個性を出す（ソクラテスは問いかけ、ニーチェは力強い断言、仏陀は穏やか、孔子は格言的、ユングは分析的）
- 可能な場合、その人物の実際の名言や思想を自然に織り込む
- 名言を引用する場合は「」で囲む
- 最後に「📝 今日の一言」として、5人の言葉を踏まえた短いまとめ（50文字程度）を添える

【フォーマット】
🏛 ソクラテス
（アドバイス）

🔥 ニーチェ
（アドバイス）

🪷 仏陀
（アドバイス）

📜 孔子
（アドバイス）

🧠 ユング
（アドバイス）

📝 今日の一言
（まとめ）

【注意】
- 相談者の気持ちに寄り添いつつも、甘やかすだけでなく本質的な気づきを与える
- 深刻な悩み（自傷・自殺など）の場合は、専門機関への相談を促す一文を必ず添える
- 宗教の勧誘にならないよう、あくまで「哲学・思想としてのアドバイス」に留める`;

// ============================================================
// メッセージ処理
// ============================================================
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const userMessage = event.message.text;
  console.log("Received message:", userMessage);

  // 「使い方」系のメッセージ
  if (
    userMessage === "使い方" ||
    userMessage === "ヘルプ" ||
    userMessage === "help"
  ) {
    return replyMessage(
      event.replyToken,
      "🏛 ようこそ「哲子の部屋」へ\n\nあなたの悩みや相談を送ってください。\n5人の賢者（ソクラテス、ニーチェ、仏陀、孔子、ユング）が、それぞれの視点からアドバイスをお届けします。\n\n💡 例：\n・「上司と合わなくてしんどい」\n・「やりたいことが見つからない」\n・「友達と比べて焦る」\n\n何でもお気軽にどうぞ！"
    );
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const replyText =
      response.content[0]?.text ||
      "申し訳ありません、回答を生成できませんでした。";

    const truncated =
      replyText.length > 4900 ? replyText.slice(0, 4900) + "\n…" : replyText;

    console.log("Sending reply, length:", truncated.length);
    return replyMessage(event.replyToken, truncated);
  } catch (err) {
    console.error("Claude API error:", err.message);
    return replyMessage(
      event.replyToken,
      "⚠️ 賢者たちが瞑想中のようです…\nしばらくしてからもう一度お試しください。"
    );
  }
}

// ============================================================
// Express サーバー
// ============================================================
const app = express();

// Webhookエンドポイント
app.post("/webhook", express.json(), async (req, res) => {
  // すぐに200を返す（LINEのタイムアウト防止）
  res.status(200).send("OK");

  // イベント処理（バックグラウンド）
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

// ヘルスチェック
app.get("/", (req, res) => {
  res.send("🏛 哲子の部屋 Bot is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`哲子の部屋 Bot is running on port ${PORT}`);
});
