# 🏛 哲子の部屋 — LINE Bot

5人の賢者（ソクラテス、ニーチェ、仏陀、孔子、ユング）があなたの悩みに答えるLINE Bot。

---

## 🚀 Renderへのデプロイ手順

### Step 1: GitHubにリポジトリを作成

1. [github.com/new](https://github.com/new) でリポジトリ作成
   - リポジトリ名: `tetsuko-bot`
   - Private でOK
2. このフォルダの3ファイルをアップロード
   - `package.json`
   - `index.js`
   - `README.md`

### Step 2: Renderでデプロイ

1. [render.com](https://render.com) にログイン
2. 「New +」→「Web Service」を選択
3. GitHubリポジトリを接続 → `tetsuko-bot` を選択
4. 設定:
   - **Name**: `tetsuko-bot`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free` でOK
5. **Environment Variables** に以下の3つを追加:

| Key | Value |
|-----|-------|
| `LINE_CHANNEL_SECRET` | LINE Developersで取得したChannel Secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developersで発行したChannel Access Token |
| `ANTHROPIC_API_KEY` | AnthropicのAPIキー（sk-ant-...） |

6. 「Create Web Service」をクリック → デプロイ開始！

### Step 3: LINE Webhook設定

デプロイ完了後、RenderのURL（例: `https://tetsuko-bot.onrender.com`）をコピー。

1. [LINE Developers Console](https://developers.line.biz/console/) を開く
2. 「哲子の部屋」チャンネルを選択
3. 「Messaging API」タブ
4. **Webhook URL** に入力:
   ```
   https://tetsuko-bot.onrender.com/webhook
   ```
5. 「Update」をクリック
6. **Use webhook** を ON にする
7. **Auto-reply messages** を OFF にする（LINE Official Account Managerで設定）

### Step 4: テスト！

LINEで「哲子の部屋」に悩みを送ってみてください 🎉

---

## 💡 使い方

- 悩みをそのままテキストで送る → 5人の賢者が回答
- 「使い方」と送る → ヘルプメッセージ

## ⚠️ 注意

- Renderの無料プランはスリープするため、最初の応答に30秒ほどかかる場合があります
- Anthropic APIは従量課金です（Haiku 4.5は非常に安価: 約$0.001/回答）
