const express = require("express");
const { messagingApi, middleware } = require("@line/bot-sdk");
const Anthropic = require("@anthropic-ai/sdk");

// ============================================================
// 環境変数
// ============================================================
const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

// ============================================================
// クライアント初期化
// ============================================================
const client = new messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

const anthropic = new Anthropic({ apiKey: anthropicApiKey });

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
async function handleMessage(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return null;
  }

  const userMessage = event.message.text;

  // 「使い方」系のメッセージ
  if (
    userMessage === "使い方" ||
    userMessage === "ヘルプ" ||
    userMessage === "help"
  ) {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: "text",
          text: "🏛 ようこそ「哲子の部屋」へ\n\nあなたの悩みや相談を送ってください。\n5人の賢者（ソクラテス、ニーチェ、仏陀、孔子、ユング）が、それぞれの視点からアドバイスをお届けします。\n\n💡 例：\n・「転職するか悩んでいます」\n・「人間関係がうまくいきません」\n・「自分に自信が持てません」\n\n何でもお気軽にどうぞ！",
        },
      ],
    });
  }

  try {
    // Claude APIで5人の賢者の回答を生成
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const replyText =
      response.content[0]?.text || "申し訳ありません、回答を生成できませんでした。";

    // LINEの5000文字制限対応
    const truncated =
      replyText.length > 4900 ? replyText.slice(0, 4900) + "\n…" : replyText;

    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text: truncated }],
    });
  } catch (err) {
    console.error("Claude API error:", err);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: "text",
          text: "⚠️ 賢者たちが瞑想中のようです…\nしばらくしてからもう一度お試しください。",
        },
      ],
    });
  }
}

// ============================================================
// Express サーバー
// ============================================================
const app = express();

// Webhook エンドポイント
app.post("/webhook", middleware(config), async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleMessage));
    res.json(results);
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).end();
  }
});

// ヘルスチェック（Render用）
app.get("/", (req, res) => {
  res.send("🏛 哲子の部屋 Bot is running");
});

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`哲子の部屋 Bot is running on port ${PORT}`);
});
