# FlEq

[dmdata.jp](https://dmdata.jp/) の API を利用して、地震・津波・緊急地震速報（EEW）・火山情報をリアルタイムに CLI で受信・表示するツールです。

npm パッケージ名: `@sayue_ltr/fleq` / CLI コマンド名: `fleq`

> [!NOTE]
> ![再構成の進捗 42%](https://img.shields.io/badge/%E5%86%8D%E6%A7%8B%E6%88%90%E3%81%AE%E9%80%B2%E6%8D%97-42%25-blue)
>
> FlEq は現在、内部構造の全面再構成を進めています。現行の v4 系は引き続き npm で配布し、不具合修正も続けています。
> 新しい実装はリポジトリ内の [`reconstruction/`](reconstruction/) で開発中で、npm パッケージにはまだ含まれていません。

## 必要なもの

- Node.js 18 以上
- [dmdata.jp](https://dmdata.jp/) のアカウントと API キー
- API キーの権限: `socket.start` と、受信したい区分に対応する `telegram.get.*`・`eew.get.*`

受信する情報の種類によっては、dmdata.jp の有料契約が必要です。
詳しくは [dmdata.jp](https://dmdata.jp/) の料金・契約ページを確認してください。

Windows・macOS・Linux に対応しています。

## インストール

```bash
npm install -g @sayue_ltr/fleq
```

## 最初の起動

```bash
fleq init   # API キーと受信設定を対話形式で行います
fleq
```

API キーは `fleq config set apiKey <key>`、環境変数 `DMDATA_API_KEY`、カレントディレクトリの `.env` でも設定できます。

起動時に npm registry（接続できないときは GitHub Releases）へ新しいバージョンを確認します。止めるには環境変数 `FLEQ_NO_UPDATE_CHECK=1` を設定してください。

## 主な機能

- WebSocket によるリアルタイム受信（自動再接続・複線接続対応）
- 地震・津波・EEW・火山情報を震度やレベルに応じた色分けで表示
- 気象警報・注意報、竜巻・記録的短時間大雨・土砂災害・洪水・台風・熱中症など気象電文の表示に対応
- 緊急地震速報の同時追跡・ログ記録・差分表記
- 内蔵ブラウザ表示サーバ（`--display`）で常設モニタ向けの情報ディスプレイ画面を配信
- デスクトップ通知・通知音（カテゴリ別 ON/OFF）
- REPL による実行中の設定変更・状態確認
- CUD 配色準拠のテーマシステム（カスタマイズ可能）とナイトモード（`--night`）
- 1 行表示の compact モード（`--mode compact`）と定期受信要約（`--summary-interval`）
- Raspberry Pi 等の低メモリ環境でも動作

## よく使う起動例

```bash
# 地震・火山情報だけ受信
fleq -c telegram.earthquake,telegram.volcano

# コンパクト表示で起動
fleq --mode compact

# テスト電文も含めて受信
fleq --test including

# ナイトモード + 30 分ごとの受信要約
fleq --night --summary-interval 30

# 情報ディスプレイを有効化（デフォルト: http://127.0.0.1:7788/）
fleq --display
```

デフォルトの受信区分は `telegram.earthquake,eew.forecast,eew.warning,telegram.volcano,telegram.weather` です。
契約内容によっては一部の区分を受信できない場合があります。

複数のデバイスで同時に起動するときは、`fleq config set appName <名前>` でデバイスごとに異なる名前を設定してください。
`appName` が同じだと、起動時の残留ソケットのクリーンアップで他デバイスのソケットまで閉じてしまいます。

## 詳しい使い方

- CLI オプション: `fleq --help`
- 設定: `fleq config keys` でキーの一覧、`fleq config path` で保存先を表示します
- REPL: 実行中に `commands` で一覧、`help <command>` で詳細を表示します
- [表示リファレンス](docs/display-reference.md) — 電文タイプ別の表示フォーマット一覧
- [情報ディスプレイセットアップガイド](docs/display-setup.md) — 常設ディスプレイ表示のセットアップ
- [Raspberry Pi 500 セットアップガイド](docs/raspi500-setup-guide.md) — Raspberry Pi での常時稼働セットアップ
- [内部仕様書](docs/specs/) — 開発者向けドキュメント

## アンインストール

`npm uninstall -g @sayue_ltr/fleq` で削除できます。設定も消す場合は、先に `fleq config path` で保存先を確かめ、そのディレクトリを手動で削除してください。

## 出典

テストで使用しているフィクスチャデータ (`test/fixtures/`) は、気象庁防災情報 XML のサンプルデータを加工して作成しています。

> 気象庁「防災情報 XML フォーマット 技術資料」 (https://xml.kishou.go.jp/tec_material.html) を加工して作成

## ライセンス

MIT
