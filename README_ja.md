# Obsidian Discussion Hub

[English](README.md)

Discussion Hub は、Obsidian で複数の AI モデルによる討論を行うための共通 UI と進行機能を提供します。AI プラグインが実行時に接続して利用可能なテキストモデルを提供するため、異なるプロバイダーのモデルを同じ討論へ参加させられます。

このワークスペースで対応している連携先：

- [LLM Hub](https://github.com/takeshy/obsidian-llm-hub)
- [Gemini Helper](https://github.com/takeshy/obsidian-gemini-helper)
- [Local LLM Hub](https://github.com/takeshy/obsidian-local-llm-hub)

![討論のセットアップ](docs/images/ai-discussion-start.png)

## 使い方

1. Discussion Hub をインストールして有効化します。AI モデルを参加させる場合は、対応する AI プロバイダープラグインも1つ以上有効化します。
2. Discussion Hub のリボンアイコンを開くか、コマンドパレットから **Discussion Hub: Open discussion** を実行します。
3. 討論のテーマを入力します。
4. 接続された任意の AI プラグインから参加者を追加するか、自分自身を追加します。
5. 必要に応じて役割を割り当て、討論参加者とは別に投票者を設定します。
6. ターン数を設定して **Start discussion** をクリックします。

討論には参考ファイルも添付できます。テキスト資料は共通コンテキストへ追加され、添付ファイルは最初のターンで接続先のモデルへ渡されます。

![進行中の討論](docs/images/ai-discussion.png)

## 討論の流れ

1. **討論ターン** — 全参加者が並列に応答します。各ターンはそれまでの応答を踏まえて進行します。
2. **結論** — 討論ターンの終了後、各参加者が最終的な結論を提示します。
3. **投票** — 設定した投票者がすべての結論を評価し、最も優れたものへ投票します。
4. **結果** — 勝者または引き分けを発表します。完全な討論内容は Markdown ノートとして保存できます。

![保存した討論ノート](docs/images/ai-discussion-result.png)

## 機能

- **プラグイン横断の参加者** — LLM Hub、Gemini Helper、Local LLM Hub が提供するモデルを同じ討論で組み合わせられます。
- **人間の参加** — 自分自身を参加者や投票者として追加し、人間参加型の討論を行えます。
- **役割の割り当て** — 各参加者に「楽観主義者」「懐疑論者」などの視点を設定できます。
- **投票者の個別設定** — 討論参加者とは独立して投票者を設定できます。
- **ファイル添付** — 画像、PDF、テキスト、音声、動画を1ファイルあたり最大 20 MB まで追加できます。
- **設定の永続化** — 参加者と投票者の構成はセッションをまたいで復元されます。
- **プロンプトの設定** — プラグイン設定でシステム、結論、投票プロンプト、出力フォルダ、デフォルトのターン数を変更できます。
- **ノートとして保存** — 討論ターン、結論、投票、勝者の結論を Markdown ファイルとしてエクスポートできます。

## 設定

Discussion Hub の設定画面では、デフォルトのターン数、出力フォルダ、討論・結論・投票に使用する各プロンプトを設定できます。

![Discussion Hub の設定](docs/images/ai-discussion-settings.png)

## 動作要件

- Obsidian 1.10.0 以上
- 参加者と投票者が全員人間の場合を除き、対応する AI プロバイダープラグインが1つ以上必要です。

## 連携仕様

プロバイダーは `discussion-hub:register-integration` ワークスペースイベントを通じて `protocolVersion: 1` の連携オブジェクトを登録し、`discussion-hub:unregister-integration` で同一のインスタンスを登録解除します。Discussion Hub は `discussion-hub:ready` も通知するため、プラグインの読み込み順には依存しません。

プロバイダーは `listModels()` と `streamText()` を提供します。認証情報やプロバイダー固有の設定は、各プロバイダープラグイン内で管理されます。
