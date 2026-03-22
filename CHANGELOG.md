# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [1.49.8](https://github.com/Lateo2580/FlEq/compare/v1.49.7...v1.49.8) (2026-03-22)


### バグ修正

* **ci:** npm を v11.5.1+ に更新し OIDC publish を有効化 ([f6c55e2](https://github.com/Lateo2580/FlEq/commit/f6c55e22b9c98d644236e7db4619e86d1cc0411c))

## [1.49.7](https://github.com/Lateo2580/FlEq/compare/v1.49.6...v1.49.7) (2026-03-22)

## [1.49.6](https://github.com/Lateo2580/FlEq/compare/v1.49.5...v1.49.6) (2026-03-22)


### バグ修正

* **ci:** NPM_TOKEN と registry-url を復元 ([f63d1c4](https://github.com/Lateo2580/FlEq/commit/f63d1c46a7c7009b3e54b493891969544982fbd9))

## [1.49.5](https://github.com/Lateo2580/FlEq/compare/v1.49.4...v1.49.5) (2026-03-22)


### ドキュメント

* README に dmdata.jp の契約が必要な旨を追記 ([07735f9](https://github.com/Lateo2580/FlEq/commit/07735f93a78588ea9b4d8754f5c742e392494e59))

## [1.49.4](https://github.com/Lateo2580/FlEq/compare/v1.49.3...v1.49.4) (2026-03-22)


### バグ修正

* **ci:** setup-node から registry-url を除去し OIDC 認証を有効化 ([dd88007](https://github.com/Lateo2580/FlEq/commit/dd88007cb423e258987000162451e8e7b1fbd0a3))

## [1.49.3](https://github.com/Lateo2580/FlEq/compare/v1.49.2...v1.49.3) (2026-03-22)

## [1.49.2](https://github.com/Lateo2580/FlEq/compare/v1.49.1...v1.49.2) (2026-03-22)


### バグ修正

* formatTimestamp テストをタイムゾーン非依存に修正 ([8729402](https://github.com/Lateo2580/FlEq/commit/8729402f99c803054ce77ca1ffee5ba77b77468d))

## [1.49.1](https://github.com/Lateo2580/FlEq/compare/v1.49.0...v1.49.1) (2026-03-22)

## [1.49.0](https://github.com/Lateo2580/FlEq/compare/v1.48.2...v1.49.0) (2026-03-21)


### 機能追加

* VFVO53（降灰予報・定時）まとめ表示機能を追加 ([53e8700](https://github.com/Lateo2580/FlEq/commit/53e87006db20505d447b84cb91018551aa16e78f))
* 電文タイプ別の省略表示上限設定 (truncation) を追加 ([545def8](https://github.com/Lateo2580/FlEq/commit/545def854161ec23e900b636dafd5068ba05ab5c))


### バグ修正

* EEW表示の仮定震源グレーアウトと長行折り返し対応 ([bdde3d6](https://github.com/Lateo2580/FlEq/commit/bdde3d60efecfb8c6e76f389cf347ad1be5f04b5))
* 火山フォーマッタの表示品質を大幅改善 ([f59c7e8](https://github.com/Lateo2580/FlEq/commit/f59c7e8255291b7eeaa8bebd525200346f4015ab))
* 火山電文タイトルから「火山名＋山名」プレフィックスを除去 ([04e76d0](https://github.com/Lateo2580/FlEq/commit/04e76d0465c8dac9cdf5ce28b9f179329c06f3e6))


### ドキュメント

* 電文フローのドキュメントを追加 ([a108e12](https://github.com/Lateo2580/FlEq/commit/a108e12725856e791e222bdf9ff9da43a31b4350))
* 表示リファレンスに火山情報セクションを追加 ([4f772c9](https://github.com/Lateo2580/FlEq/commit/4f772c9fc33bb34b4dfb169025990973a2aee476))

## [1.48.2](https://github.com/Lateo2580/FlEq/compare/v1.48.1...v1.48.2) (2026-03-20)


### バグ修正

* 火山機能の安定性・品質向上 (Codexレビュー指摘対応) ([aaaf489](https://github.com/Lateo2580/FlEq/commit/aaaf489e2e6333df3a5c343f4c28b226fe478f78))

## [1.48.1](https://github.com/Lateo2580/FlEq/compare/v1.48.0...v1.48.1) (2026-03-20)


### バグ修正

* fleq init に火山関連(telegram.volcano)の選択肢を追加 ([d3247be](https://github.com/Lateo2580/FlEq/commit/d3247becb33479f56e102275fd24cbd2bf705763))

## [1.48.0](https://github.com/Lateo2580/FlEq/compare/v1.47.3...v1.48.0) (2026-03-20)


### 機能追加

* 火山区分(telegram.volcano)対応 — 10種類の火山電文パース・表示・通知 ([695094e](https://github.com/Lateo2580/FlEq/commit/695094e29224b51a3a6859affe09bfb531523019))

## [1.47.3](https://github.com/Lateo2580/FlEq/compare/v1.47.2...v1.47.3) (2026-03-19)


### バグ修正

* clearコマンド後にプロンプトが毎秒新しい行として出力される問題を修正 ([088f34c](https://github.com/Lateo2580/FlEq/commit/088f34cdac965cfe4022255e6fbbd2e90993e77f))

## [1.47.2](https://github.com/Lateo2580/FlEq/compare/v1.47.1...v1.47.2) (2026-03-19)


### バグ修正

* chalk トゥルーカラー強制で端末間の色表示差異を解消 ([39b04cd](https://github.com/Lateo2580/FlEq/commit/39b04cd73ca739fa5b9ce58337c88ea4a65f6c26))

## [1.47.1](https://github.com/Lateo2580/FlEq/compare/v1.47.0...v1.47.1) (2026-03-19)


### バグ修正

* Telegram List APIのbody未返却時のパースエラーを修正 ([1fcd0dc](https://github.com/Lateo2580/FlEq/commit/1fcd0dca97647c3890821909ea923d46aff48b45))

## [1.47.0](https://github.com/Lateo2580/FlEq/compare/v1.46.0...v1.47.0) (2026-03-19)


### 機能追加

* EEW副回線(backup)とエンドポイントフェイルオーバーを追加 ([b0cdc5a](https://github.com/Lateo2580/FlEq/commit/b0cdc5a68903e99af4d20f763423e7c6c18ad26e))
* 津波状態復元・REPLコマンド短縮形・通知音改善・ping色分け ([373bcde](https://github.com/Lateo2580/FlEq/commit/373bcde975f95ba38086bb8c11d381816b14e124))


### リファクタリング

* engine/をサブディレクトリ化し責務を明確に分離 ([0e4f2c5](https://github.com/Lateo2580/FlEq/commit/0e4f2c58064ebd7c7b3bdc1b4c8bec5b364db7df))

## [1.46.0](https://github.com/Lateo2580/FlEq/compare/v1.45.1...v1.46.0) (2026-03-17)


### 機能追加

* 津波警報レベルのプロンプト表示とdetailコマンドを追加 ([b595ac6](https://github.com/Lateo2580/FlEq/commit/b595ac67e2765c9e4b6279a52361c4110378148c))

## [1.45.1](https://github.com/Lateo2580/FlEq/compare/v1.45.0...v1.45.1) (2026-03-16)


### バグ修正

* 津波情報のヘッドライン改行処理とNaN規模表示を修正 ([821c57f](https://github.com/Lateo2580/FlEq/commit/821c57f57e7a5cf154957948d92972c9994b78f8))

## [1.45.0](https://github.com/Lateo2580/FlEq/compare/v1.44.0...v1.45.0) (2026-03-16)


### 機能追加

* 津波情報にバナー表示を追加し、warningCommentの折り返しを修正 ([19e2b25](https://github.com/Lateo2580/FlEq/commit/19e2b2575104f71b15209b33b690642e58103b10))


### バグ修正

* マグニチュード値の小数点第1位を保証する表示修正 ([2e53250](https://github.com/Lateo2580/FlEq/commit/2e53250b67902d99333fc3b94727124afc3d1d53))


### ドキュメント

* 仕様書をソースコード実装に同期 ([e65959e](https://github.com/Lateo2580/FlEq/commit/e65959ee9344970a502e33d19d9659a2b31d3291))

## [1.44.0](https://github.com/Lateo2580/FlEq/compare/v1.43.0...v1.44.0) (2026-03-16)


### 機能追加

* test tableコマンドに番号指定のバリエーション表示を追加 ([38daab3](https://github.com/Lateo2580/FlEq/commit/38daab38de17c23ded03760df0a43a568f57d98f))
* 南海トラフ情報のマグニチュード単独パターン強調表示を追加 ([c99f68f](https://github.com/Lateo2580/FlEq/commit/c99f68f6b10b8eb37634e1cbe94a02dc8815da3e))

## [1.43.0](https://github.com/Lateo2580/FlEq/compare/v1.42.0...v1.43.0) (2026-03-16)


### 機能追加

* テキスト電文・南海トラフ情報の本文キーワード強調表示 ([fd6b937](https://github.com/Lateo2580/FlEq/commit/fd6b937e0fa1a941714ab0f48736a1b408b668ad))

## [1.42.0](https://github.com/Lateo2580/FlEq/compare/v1.41.0...v1.42.0) (2026-03-16)


### 機能追加

* helpコマンドの全設定コマンドにサブコマンドツリー表示を追加 ([dfad680](https://github.com/Lateo2580/FlEq/commit/dfad680b5e05564a2bae248fc1c3c1b09201973a))


### ドキュメント

* READMEにクイックスタート追加・必要条件と使い方セクションを改善 ([df88992](https://github.com/Lateo2580/FlEq/commit/df88992d1df7b9478af736e54fcf434b7f8c9a07))

## [1.41.0](https://github.com/Lateo2580/FlEq/compare/v1.40.1...v1.41.0) (2026-03-15)


### 機能追加

* REPLにtestコマンド追加・helpのツリー表示とサブコマンド解決を実装 ([8584f9d](https://github.com/Lateo2580/FlEq/commit/8584f9d855538088dc5d211f2e3950117c355435))

## [1.40.1](https://github.com/Lateo2580/FlEq/compare/v1.40.0...v1.40.1) (2026-03-15)


### ドキュメント

* ソースファイル全24件の詳細仕様書を作成 ([7c351fa](https://github.com/Lateo2580/FlEq/commit/7c351fa0457187bdb3caf28ff6b7b6e3158a0c4a))

## [1.40.0](https://github.com/Lateo2580/FlEq/compare/v1.39.1...v1.40.0) (2026-03-15)


### 機能追加

* VXSE51 震度速報で震源未確定メッセージを表示 ([20097ac](https://github.com/Lateo2580/FlEq/commit/20097ac623885b64307f675cd7e6b01997182d83))

## [1.39.1](https://github.com/Lateo2580/FlEq/compare/v1.39.0...v1.39.1) (2026-03-15)


### バグ修正

* テーマ機能の型安全性・堅牢性を強化 ([66794d3](https://github.com/Lateo2580/FlEq/commit/66794d3172dd6533ecccea4d53882f6f8c71f36f))

## [1.39.0](https://github.com/Lateo2580/FlEq/compare/v1.38.0...v1.39.0) (2026-03-15)


### 機能追加

* カラーテーマカスタマイズ機能を追加 ([ea33f1d](https://github.com/Lateo2580/FlEq/commit/ea33f1def602cd49d5a2b2f9acd862f60a8efd39))

## [1.38.0](https://github.com/Lateo2580/FlEq/compare/v1.37.3...v1.38.0) (2026-03-15)


### 機能追加

* EEWログに7項目を追加し、REPL表示をグループ化 ([8ea1a29](https://github.com/Lateo2580/FlEq/commit/8ea1a29d442a00fecc7b315ce76f268cc4168ba6))

## [1.37.3](https://github.com/Lateo2580/FlEq/compare/v1.37.2...v1.37.3) (2026-03-15)


### バグ修正

* 全表示色をCUDカラーパレット準拠に統一 ([23fde8c](https://github.com/Lateo2580/FlEq/commit/23fde8c9545c8b4c209ec650db3652d3076b4a96))

## [1.37.2](https://github.com/Lateo2580/FlEq/compare/v1.37.1...v1.37.2) (2026-03-15)


### バグ修正

* colorsコマンドの震度6強/7・階級4のラベルを実際の表示スタイルに修正 ([3cbfdfa](https://github.com/Lateo2580/FlEq/commit/3cbfdfaf31a11eef0af734049c7d97cc7836504d))

## [1.37.1](https://github.com/Lateo2580/FlEq/compare/v1.37.0...v1.37.1) (2026-03-15)


### バグ修正

* colorsコマンドでCUDパレットを元の表示に戻し、震度/長周期の文字色・背景色を分離表示 ([7994c16](https://github.com/Lateo2580/FlEq/commit/7994c16d321221a7451b6d76a2878ef97e003b32))

## [1.37.0](https://github.com/Lateo2580/FlEq/compare/v1.36.0...v1.37.0) (2026-03-15)


### 機能追加

* colorsコマンドの表示をマルチカラム対応＆文字色/背景色を分離表示 ([1018df5](https://github.com/Lateo2580/FlEq/commit/1018df5aa657188c9bae8ea6c0fea8c26970e35d))

## [1.36.0](https://github.com/Lateo2580/FlEq/compare/v1.35.0...v1.36.0) (2026-03-15)


### 機能追加

* PLUM法EEWバナー装飾行の色を青系に変更 ([dc00a3a](https://github.com/Lateo2580/FlEq/commit/dc00a3a47061add228861d738a06ef68e29373dd))


### バグ修正

* waiting-tipsのプロンプト説明文を現行仕様に合わせて修正 ([56fc3fc](https://github.com/Lateo2580/FlEq/commit/56fc3fc69d1d7e4678262514494950a6a6a2d79b))


### ドキュメント

* display-reference.mdの記載を実装に合わせて修正 ([c74c5c4](https://github.com/Lateo2580/FlEq/commit/c74c5c4d4ee69b6bd86d317607fd74eba4a6941a))
* display-reference.mdの色テーブルにHEXカラーコード列を追加 ([227251a](https://github.com/Lateo2580/FlEq/commit/227251a2c21ffad634d576fc84395ae80b501dad))

## [1.35.0](https://github.com/Lateo2580/FlEq/compare/v1.34.0...v1.35.0) (2026-03-14)


### 機能追加

* Tip表示・電文受信時に入力中の文字をクリアして行更新を再開 ([1384876](https://github.com/Lateo2580/FlEq/commit/13848767265b88615b5ac754c625fb457509ff6a))

## [1.34.0](https://github.com/Lateo2580/FlEq/compare/v1.33.0...v1.34.0) (2026-03-14)


### 機能追加

* helpカテゴリ分け・EEWログ設定コマンド・history表示順逆転 ([c40f185](https://github.com/Lateo2580/FlEq/commit/c40f1851d3b3da1bbcf931b6523d340ec16bae61))

## [1.33.0](https://github.com/Lateo2580/FlEq/compare/v1.32.4...v1.33.0) (2026-03-14)


### 機能追加

* 待機中ヒントに歴史的大地震・今後想定される地震の情報を追加 ([11e182e](https://github.com/Lateo2580/FlEq/commit/11e182e8134b93e681d5f7e9c0af9094130e75fb))

## [1.32.4](https://github.com/Lateo2580/FlEq/compare/v1.32.3...v1.32.4) (2026-03-14)


### リファクタリング

* 関数分割・重複解消・マジックナンバー定数化・ネスト平坦化 ([4e0a7c5](https://github.com/Lateo2580/FlEq/commit/4e0a7c5875dddcb24fe02bcad44f6c986a8999b4))

## [1.32.3](https://github.com/Lateo2580/FlEq/compare/v1.32.2...v1.32.3) (2026-03-14)


### バグ修正

* ANSI エスケープコードを含むプロンプトの区切り修正 ([ab7e89c](https://github.com/Lateo2580/FlEq/commit/ab7e89c2e560e9de3d36452986fd2908b7a7a7d6))

## [1.32.2](https://github.com/Lateo2580/FlEq/compare/v1.32.1...v1.32.2) (2026-03-14)


### バグ修正

* プロンプトの経過時間とping時間の区切り表示を修正 ([33c53e4](https://github.com/Lateo2580/FlEq/commit/33c53e42358c8d1bb255813a4d82e5c569be6aa4))

## [1.32.1](https://github.com/Lateo2580/FlEq/compare/v1.32.0...v1.32.1) (2026-03-14)


### バグ修正

* clearコマンド実装とmode fullのtip誤記を修正 ([b3611a0](https://github.com/Lateo2580/FlEq/commit/b3611a0b475303736d31b05fc3115c38df66f06e))

## [1.32.0](https://github.com/Lateo2580/FlEq/compare/v1.31.5...v1.32.0) (2026-03-14)


### 機能追加

* ターミナルタイトルにアプリ名とバージョンを表示 ([4f22d68](https://github.com/Lateo2580/FlEq/commit/4f22d680de7a26c2cb38adc072a3abb109fd2c3d))


### ドキュメント

* raspi500セットアップガイドにmicroSD寿命対策と複数デバイス同時運用を追記 ([033c4b4](https://github.com/Lateo2580/FlEq/commit/033c4b4f434be8bb034c1611140ebadc4f1525ca))

## [1.31.5](https://github.com/Lateo2580/FlEq/compare/v1.31.4...v1.31.5) (2026-03-14)


### バグ修正

* ソケット削除後にサーバー側の反映を待ってから新規作成する ([df2a202](https://github.com/Lateo2580/FlEq/commit/df2a202db13a8df06549beb6829bac2166346443))

## [1.31.4](https://github.com/Lateo2580/FlEq/compare/v1.31.3...v1.31.4) (2026-03-14)


### バグ修正

* ソケットクリーンアップにデバッグログ追加で原因調査を容易に ([e79e316](https://github.com/Lateo2580/FlEq/commit/e79e31601489d2686d33f4b4cfaabe85a2e77d36))

## [1.31.3](https://github.com/Lateo2580/FlEq/compare/v1.31.2...v1.31.3) (2026-03-13)


### バグ修正

* keepExistingConnections=false パスでも appName フィルタリングを適用 ([20358f0](https://github.com/Lateo2580/FlEq/commit/20358f088b342fb5c59547256f2aa85c5717f193))

## [1.31.2](https://github.com/Lateo2580/FlEq/compare/v1.31.1...v1.31.2) (2026-03-13)


### バグ修正

* 複数デバイス同時運用時に他デバイスのソケットを閉じてしまう問題を修正 ([c2adff0](https://github.com/Lateo2580/FlEq/commit/c2adff06516edba6fac6ad77ed6956f2c6c73909))

## [1.31.1](https://github.com/Lateo2580/FlEq/compare/v1.31.0...v1.31.1) (2026-03-13)


### バグ修正

* サーバーエラーメッセージのパース改善と再接続時404の静粛化 ([f175f9a](https://github.com/Lateo2580/FlEq/commit/f175f9a226bb97e82ca4aa7ada38d2d0e179bdc3))

## [1.31.0](https://github.com/Lateo2580/FlEq/compare/v1.30.0...v1.31.0) (2026-03-13)


### 機能追加

* fleq init のUXを改善 (番号選択式・説明付き・保存前確認) ([ed51b6c](https://github.com/Lateo2580/FlEq/commit/ed51b6c59a998d16376d16b29f748156e11b2ec4))

## [1.30.0](https://github.com/Lateo2580/FlEq/compare/v1.29.0...v1.30.0) (2026-03-12)


### 機能追加

* グレースフルシャットダウン時にREST APIでソケットを削除 ([3dad936](https://github.com/Lateo2580/FlEq/commit/3dad9362b4f043f9ab890cc6b1bbce816fddf452))

## [1.29.0](https://github.com/Lateo2580/FlEq/compare/v1.28.0...v1.29.0) (2026-03-11)


### 機能追加

* メモリ最適化 (遅延ロード・V8フラグ opt-in) ([731f2ab](https://github.com/Lateo2580/FlEq/commit/731f2ab70022cb17221a1a614993b6e489b920aa))

## [1.28.0](https://github.com/Lateo2580/FlEq/compare/v1.27.0...v1.28.0) (2026-03-11)


### 機能追加

* カスタム効果音ファイル追加とサウンドレベル判定ロジック改善 ([a3e6f94](https://github.com/Lateo2580/FlEq/commit/a3e6f9431b1932a747c76f7bd893342884d6833c))
* ログ出力に統一プレフィックス(FlEq [○ --:--:--]>)を付与 ([5401569](https://github.com/Lateo2580/FlEq/commit/540156980f6ce379e8d699bc6a63b4e8a787f92d))
* 起動ログ表示順序変更、tableWidth auto対応、通知アイコン追加 ([e38f6e6](https://github.com/Lateo2580/FlEq/commit/e38f6e6ea6aa7ec410653d6a7d25329706d4a54d))


### バグ修正

* テスト実行時のトースト通知を確実に抑制 ([37b794d](https://github.com/Lateo2580/FlEq/commit/37b794d2c91794a5dad5496b7890cce07f8f0843))

## [1.27.0](https://github.com/Lateo2580/FlEq/compare/v1.26.0...v1.27.0) (2026-03-10)


### 機能追加

* プロンプト簡素化とclock切替コマンド追加 ([1c6b2d3](https://github.com/Lateo2580/FlEq/commit/1c6b2d322a22df9df4554950276df3f8fd5a81a1))


### リファクタリング

* ログ出力からタイムスタンプ・ラベルを除去しシンプルな表示に統一 ([c2680f6](https://github.com/Lateo2580/FlEq/commit/c2680f6d4182534d13da7a5e015a5f7af39e89a8))

## [1.26.0](https://github.com/Lateo2580/FlEq/compare/v1.25.0...v1.26.0) (2026-03-09)


### 機能追加

* カスタム効果音対応（assets/sounds/ にmp3/wavを配置で自動切替） ([1d666de](https://github.com/Lateo2580/FlEq/commit/1d666de4005f885e847edd47030f19a6ee54d113))

## [1.25.0](https://github.com/Lateo2580/FlEq/compare/v1.24.0...v1.25.0) (2026-03-09)


### 機能追加

* 待機中Tipを70個→160個に拡充（全5カテゴリ） ([17a9e2b](https://github.com/Lateo2580/FlEq/commit/17a9e2b9837f10c68218d3f71b5ea3a8d1e8a96d))

## [1.24.0](https://github.com/Lateo2580/FlEq/compare/v1.23.0...v1.24.0) (2026-03-08)


### 機能追加

* REPLにcolorsコマンド追加、helpコマンド一覧をアルファベット順に ([9c4e9e8](https://github.com/Lateo2580/FlEq/commit/9c4e9e8834a01e54d200d725c56a560e198cfae8))

## [1.23.0](https://github.com/Lateo2580/FlEq/compare/v1.22.0...v1.23.0) (2026-03-08)


### 機能追加

* 通知音機能を追加（OS別ネイティブサウンド再生） ([2fc90ce](https://github.com/Lateo2580/FlEq/commit/2fc90ce630a5bfab5b138aa0b1608ebbc1c909ee))

## [1.22.0](https://github.com/Lateo2580/FlEq/compare/v1.21.0...v1.22.0) (2026-03-07)


### 機能追加

* 待機中Tipを16個から70個に大幅拡充 ([64fe653](https://github.com/Lateo2580/FlEq/commit/64fe653980a4f753a3246ed1e0db279629de7368))

## [1.21.0](https://github.com/Lateo2580/FlEq/compare/v1.20.2...v1.21.0) (2026-03-07)


### 機能追加

* OS別設定パス対応とXDG_CONFIG_HOMEサポート ([2f5fcd1](https://github.com/Lateo2580/FlEq/commit/2f5fcd16a222851357df46669c63047b18e35753))

## [1.20.2](https://github.com/Lateo2580/FlEq/compare/v1.20.1...v1.20.2) (2026-03-07)


### バグ修正

* 一般公開に向けた4点の改善 ([eefceba](https://github.com/Lateo2580/FlEq/commit/eefceba6b5eef8928a3240d2c86bda033d809856))

## [1.20.1](https://github.com/Lateo2580/FlEq/compare/v1.20.0...v1.20.1) (2026-03-07)


### リファクタリング

* cli/app/featuresをengine/に統合しディレクトリ構成を簡素化 ([2a54261](https://github.com/Lateo2580/FlEq/commit/2a5426150f3315e92d1b6e3bbaaf3bc6bf64a509))

## [1.20.0](https://github.com/Lateo2580/FlEq/compare/v1.19.1...v1.20.0) (2026-03-07)


### 機能追加

* helpコマンドで設定可能な値を表示し、待機画面の表示名をFlEqに変更 ([0226b96](https://github.com/Lateo2580/FlEq/commit/0226b96697c3d1c68c6ab28e436ad62ddf17776d))

## [1.19.1](https://github.com/Lateo2580/FlEq/compare/v1.19.0...v1.19.1) (2026-03-07)


### リファクタリング

* type/reportDateTime/publishingOfficeの表示を統一し各テーブル最下段に移動 ([6f3c10f](https://github.com/Lateo2580/FlEq/commit/6f3c10f7d4df6efb1d9fa2f807635fdc0a697a7f))

## [1.19.0](https://github.com/Lateo2580/FlEq/compare/v1.18.1...v1.19.0) (2026-03-07)


### 機能追加

* helpコマンドで設定変更可能なコマンドの現在値を表示 ([2c15715](https://github.com/Lateo2580/FlEq/commit/2c157158dfe70f2c09c559d3002ebc82071eb99d))

## [1.18.1](https://github.com/Lateo2580/FlEq/compare/v1.18.0...v1.18.1) (2026-03-07)


### バグ修正

* exit/quitコマンド実行後にzshの%記号が表示される問題を修正 ([8bfa4c8](https://github.com/Lateo2580/FlEq/commit/8bfa4c83a9a98cb70a49cf34984601c64d687d31))

## [1.18.0](https://github.com/Lateo2580/FlEq/compare/v1.17.0...v1.18.0) (2026-03-07)


### 機能追加

* 起動時にnpm registryから最新バージョンを確認し更新通知を表示 ([57d167f](https://github.com/Lateo2580/FlEq/commit/57d167f8464a6055720ee544745c9c94c0c876ba))

## [1.17.0](https://github.com/Lateo2580/FlEq/compare/v1.16.0...v1.17.0) (2026-03-07)


### 機能追加

* カラーユニバーサルデザイン(CUD)対応 ([4f7f0a3](https://github.com/Lateo2580/FlEq/commit/4f7f0a3fba300bdd41b9d98c5446789bed0d672b))

## [1.16.0](https://github.com/Lateo2580/FlEq/compare/v1.15.1...v1.16.0) (2026-03-06)


### 機能追加

* 津波情報のワイドテーブル表示対応（幅80以上でカラム区切りテーブル） ([6a926c9](https://github.com/Lateo2580/FlEq/commit/6a926c94acce23a58c1c0d1d818015bef599146a))

## [1.15.1](https://github.com/Lateo2580/FlEq/compare/v1.15.0...v1.15.1) (2026-03-06)


### ドキュメント

* CLAUDE.mdとREADME.mdを現在の実装状態に同期 ([6e37481](https://github.com/Lateo2580/FlEq/commit/6e37481a6db2e56462eeaf217407d1e49526d256))

## [1.15.0](https://github.com/Lateo2580/FlEq/compare/v1.14.0...v1.15.0) (2026-03-06)


### 機能追加

* enhance idle monitoring prompt and waiting tips ([1eccd24](https://github.com/Lateo2580/FlEq/commit/1eccd24cd0093f912b019341749ee413e0b40535))


### バグ修正

* quitコマンドで「シャットダウン中…」が重複表示される問題を修正 ([12d3c8d](https://github.com/Lateo2580/FlEq/commit/12d3c8df3e51ee5324b66e6ae34364094558bf57))

## [1.14.0](https://github.com/Lateo2580/FlEq/compare/v1.13.1...v1.14.0) (2026-03-06)


### 機能追加

* UX改善10項目の一括実装 ([8fcb129](https://github.com/Lateo2580/FlEq/commit/8fcb12951eaea1d9a8550a6d7718a44ff5fb3ace))

## [1.13.1](https://github.com/Lateo2580/FlEq/compare/v1.13.0...v1.13.1) (2026-03-06)


### バグ修正

* コードレビュー指摘14件の一括修正 (安定性・軽量化) ([c9b7db7](https://github.com/Lateo2580/FlEq/commit/c9b7db76e1c29434c2dea97dbf55f78a576b2ab8))

## [1.13.0](https://github.com/Lateo2580/FlEq/compare/v1.12.0...v1.13.0) (2026-03-06)


### 機能追加

* headline文をタイトル行直後に移動 ([ae51ede](https://github.com/Lateo2580/FlEq/commit/ae51ede96352d2278aae3b24b8132b5ed57bb4af))

## [1.12.0](https://github.com/Lateo2580/FlEq/compare/v1.11.0...v1.12.0) (2026-03-05)


### 機能追加

* お知らせ電文の全文表示切替と本文行の自動折り返し ([bf8db31](https://github.com/Lateo2580/FlEq/commit/bf8db31a8df7a02f1e54f7b67c384f9305f1c667))

## [1.11.0](https://github.com/Lateo2580/FlEq/compare/v1.10.1...v1.11.0) (2026-02-28)


### 機能追加

* EEW同時発生時のバナー色分けと震源地名表示 ([7de64d6](https://github.com/Lateo2580/FlEq/commit/7de64d6d8979b8090584817c6718bb0fddd12729))

## [1.10.1](https://github.com/Lateo2580/FlEq/compare/v1.10.0...v1.10.1) (2026-02-28)


### バグ修正

* EEW表示のバナーとカード間の空きフレームを削除 ([e38681f](https://github.com/Lateo2580/FlEq/commit/e38681f61889346e72a4030891e3a7487317cee8))

## [1.10.0](https://github.com/Lateo2580/FlEq/compare/v1.9.2...v1.10.0) (2026-02-28)


### 機能追加

* REPLにtablewidthコマンドを追加 ([0e67615](https://github.com/Lateo2580/FlEq/commit/0e676150672854d1056159e30b0e9aef2a7c87d8))


### バグ修正

* buildスクリプトでdist/index.jsに実行権限を自動付与 ([91348ee](https://github.com/Lateo2580/FlEq/commit/91348ee14c8576fc39a4d432fe932266bf81d196))


### ドキュメント

* 電文タイプ別表示リファレンスを追加 ([8acf0e2](https://github.com/Lateo2580/FlEq/commit/8acf0e27323019ba4dcee74f957548164f00d7ce))

## [1.9.3](https://github.com/Lateo2580/FlEq/compare/v1.9.2...v1.9.3) (2026-02-28)


### バグ修正

* buildスクリプトでdist/index.jsに実行権限を自動付与 ([fbce75a](https://github.com/Lateo2580/FlEq/commit/fbce75a12a69dd54a8cfcd5b992bf2186df601ec))

## [1.9.2](https://github.com/Lateo2580/FlEq/compare/v1.9.1...v1.9.2) (2026-02-27)


### リファクタリング

* EEW表示でinfoTypeをカード行に統合 ([5a922eb](https://github.com/Lateo2580/FlEq/commit/5a922ebc20841691a0c32fe90bee08be7e93ee58))

## [1.9.1](https://github.com/Lateo2580/FlEq/compare/v1.9.0...v1.9.1) (2026-02-27)


### ドキュメント

* CLAUDE.mdとREADMEをv1.9.0の現状に合わせて更新 ([81b563f](https://github.com/Lateo2580/FlEq/commit/81b563fd2f6dd36662cd972aa1407184aae49b65))

## [1.9.0](https://github.com/Lateo2580/FlEq/compare/v1.8.0...v1.9.0) (2026-02-26)


### 機能追加

* EEWで主要動到達と推測される地域をリスト表示 ([9d7a5fb](https://github.com/Lateo2580/FlEq/commit/9d7a5fb613db9bd323504baf831e806d7bc767c4))

## [1.8.0](https://github.com/Lateo2580/FlEq/compare/v1.7.1...v1.8.0) (2026-02-26)


### 機能追加

* デスクトップ通知機能を追加 ([5affacc](https://github.com/Lateo2580/FlEq/commit/5affacc6821c03d94917fa4454df6ee4e9fd803e))

## [1.7.1](https://github.com/Lateo2580/FlEq/compare/v1.7.0...v1.7.1) (2026-02-25)


### バグ修正

* 再接続時に自分の旧接続だけを閉じるように改善 ([ceae4dd](https://github.com/Lateo2580/FlEq/commit/ceae4ddc1d22941a0609790b196d5f8a0e14ff43))

## [1.7.0](https://github.com/Lateo2580/FlEq/compare/v1.6.0...v1.7.0) (2026-02-22)


### 機能追加

* EEW差分表記を「前の値 → 新しい値」形式に変更 ([cb662d6](https://github.com/Lateo2580/FlEq/commit/cb662d6c648915a7e40947812bbb3a545d0430f7))

## [1.6.0](https://github.com/Lateo2580/FlEq/compare/v1.5.0...v1.6.0) (2026-02-22)


### 機能追加

* テーブル幅設定とテキスト折り返し機能を追加 ([5ea3bcf](https://github.com/Lateo2580/FlEq/commit/5ea3bcfb7813b7b087cd1ef3745751578dc32988))


### バグ修正

* クロスプラットフォーム互換性の修正 ([72f4f0c](https://github.com/Lateo2580/FlEq/commit/72f4f0c6d3cce03250abcb23f043556a8740475c))
* セキュリティ・安定性・品質の改善 ([f041853](https://github.com/Lateo2580/FlEq/commit/f04185376a92d865f1a7530dd7a015653e2ca40b))

## [1.5.2](https://github.com/Lateo2580/FlEq/compare/v1.5.1...v1.5.2) (2026-02-21)


### バグ修正

* セキュリティ・安定性・品質の改善 ([f041853](https://github.com/Lateo2580/FlEq/commit/f04185376a92d865f1a7530dd7a015653e2ca40b))

## [1.5.1](https://github.com/Lateo2580/FlEq/compare/v1.5.0...v1.5.1) (2026-02-21)


### バグ修正

* クロスプラットフォーム互換性の修正 ([72f4f0c](https://github.com/Lateo2580/FlEq/commit/72f4f0c6d3cce03250abcb23f043556a8740475c))

## [1.5.0](https://github.com/Lateo2580/FlEq/compare/v1.4.0...v1.5.0) (2026-02-21)


### 機能追加

* EEW最終報(NextAdvisory)でログ記録終了とトラッカー終了を実行 ([3bee95e](https://github.com/Lateo2580/FlEq/commit/3bee95eba09a1924e952c265fb128b2410249002))

## [1.4.0](https://github.com/Lateo2580/FlEq/compare/v1.3.2...v1.4.0) (2026-02-21)


### 機能追加

* 緊急地震速報の最終報表示に対応（NextAdvisoryタグ） ([59ee89e](https://github.com/Lateo2580/FlEq/commit/59ee89ed5c7c72ed926ba2fe0fd8380ef68d9749))

## [1.3.2](https://github.com/Lateo2580/FlEq/compare/v1.3.1...v1.3.2) (2026-02-21)


### バグ修正

* 発生時刻・発表時刻から相対時刻表示（x秒前）を削除 ([2bd5f23](https://github.com/Lateo2580/FlEq/commit/2bd5f23a8a8c4d32c44c0d0d36ad280317ee6c0e))

## [1.3.1](https://github.com/Lateo2580/FlEq/compare/v1.3.0...v1.3.1) (2026-02-21)


### バグ修正

* ログのタイムスタンプをUTCからJST(ローカル時刻)表示に変更 ([b849f3d](https://github.com/Lateo2580/FlEq/commit/b849f3d26d9e36bee6e7439e7f8ef1be87b3f575))

## [1.3.0](https://github.com/Lateo2580/FlEq/compare/v1.2.2...v1.3.0) (2026-02-21)


### 機能追加

* VZSE40/VYSE50-52/VYSE60/VXSE62 電文タイプの対応を追加 ([eb62fe6](https://github.com/Lateo2580/FlEq/commit/eb62fe6064354f94340418c2469081b0175f5bc3))

## [1.2.2](https://github.com/Lateo2580/FlEq/compare/v1.2.1...v1.2.2) (2026-02-21)


### バグ修正

* ステータス表示をプロンプト内蔵方式に変更し視認性を改善 ([f6bcc27](https://github.com/Lateo2580/FlEq/commit/f6bcc274e7edd249940597873025d97100f63627))

## [1.2.1](https://github.com/Lateo2580/FlEq/compare/v1.2.0...v1.2.1) (2026-02-19)


### バグ修正

* dmdata-monitor から fleq へのリネーム漏れを修正 ([49b7ef7](https://github.com/Lateo2580/FlEq/commit/49b7ef778aeda3f41c04d759b8464a44c9e8c343))
* 仮定震源要素の誤検出を防止し検出ロジックを堅牢化 ([dec2e7d](https://github.com/Lateo2580/FlEq/commit/dec2e7d4eb5e495fb627cd72d32f8a7f39ef1d25))

## [1.2.0](https://github.com/Lateo2580/FlEq/compare/v1.1.0...v1.2.0) (2026-02-19)


### 機能追加

* PLUM法・仮定震源要素・既到達の検出と表示に対応 ([0409cda](https://github.com/Lateo2580/FlEq/commit/0409cda61a98fcb6b659a7f497c05382559d50b8))

## [1.1.0](https://github.com/Lateo2580/FlEq/compare/v1.0.1...v1.1.0) (2026-02-19)


### 機能追加

* 長周期地震動階級の表示に対応 ([7465301](https://github.com/Lateo2580/FlEq/commit/74653014d2b5adbad752a03fcbdb9030abf37d1d))


### ドキュメント

* README更新 - v1.0.1の現状に合わせて情報を反映 ([5c49b26](https://github.com/Lateo2580/FlEq/commit/5c49b26b37156c08f90fd3f5f55dd7a13b435ac8))

## [1.0.1](https://github.com/Lateo2580/FlEq/compare/v1.0.0...v1.0.1) (2026-02-18)


### バグ修正

* WebSocketメッセージのランタイム検証追加・serial NaN対策・EEW最大予測震度修正・REPL終了責務分離 ([8b392a5](https://github.com/Lateo2580/FlEq/commit/8b392a5a6baf7a8430d4964e5079587507282718))

## [1.0.0](https://github.com/Lateo2580/FlEq/compare/v0.1.23...v1.0.0) (2026-02-18)


### 機能追加

* v1.0.0 テストスイート追加とclassificationsバリデーション修正 ([63a9e0d](https://github.com/Lateo2580/FlEq/commit/63a9e0da6b2a2fc405f29595093281546ec63c9a))

## [0.1.23](https://github.com/Lateo2580/FlEq/compare/v0.1.22...v0.1.23) (2026-02-17)


### リファクタリング

* MCPブリッジ機能を削除 ([39267b7](https://github.com/Lateo2580/FlEq/commit/39267b7a111588ad8d6b159a4bb980e5f8eb44a2))

## [0.1.22](https://github.com/Lateo2580/FlEq/compare/v0.1.21...v0.1.22) (2026-02-17)


### 機能追加

* EEW受信時のログ記録機能を追加 ([9277b0e](https://github.com/Lateo2580/FlEq/commit/9277b0eed4e83c402cf1f0d39c0cfd7768cb4995))

## [0.1.21](https://github.com/Lateo2580/FlEq/compare/v0.1.20...v0.1.21) (2026-02-15)


### バグ修正

* WebSocketエラーメッセージの安全なパースに修正 ([8900223](https://github.com/Lateo2580/FlEq/commit/89002233d4f51e0fab08bcbcac17aefefeda05da))

## [0.1.20](https://github.com/Lateo2580/FlEq/compare/v0.1.19...v0.1.20) (2026-02-15)


### バグ修正

* DELETE APIの204レスポンスを正常処理に修正 ([a72610a](https://github.com/Lateo2580/FlEq/commit/a72610ac507e9c25a7dbc95a575511e594963cb1))

## [0.1.19](https://github.com/Lateo2580/FlEq/compare/v0.1.18...v0.1.19) (2026-02-15)


### バグ修正

* Windows互換性の修正 (パス区切り・シグナル・npmスクリプト) ([be62e10](https://github.com/Lateo2580/FlEq/commit/be62e103891c5cb4cc85264265a5b1f5e6901592))

## [0.1.18](https://github.com/Lateo2580/FlEq/compare/v0.1.17...v0.1.18) (2026-02-15)


### バグ修正

* frameLineの罫線位置ズレを全角文字幅対応で修正 ([2cedbb3](https://github.com/Lateo2580/FlEq/commit/2cedbb39e1368736c10992a157b7b8c0ec737c35))

## [0.1.17](https://github.com/Lateo2580/FlEq/compare/v0.1.16...v0.1.17) (2026-02-15)


### 機能追加

* 受信待機中のステータスラインをフッターに表示 ([54e83ae](https://github.com/Lateo2580/FlEq/commit/54e83ae50c951a4de887c26e23f73a7e60217015))


### ドキュメント

* READMEを実装現状に合わせて更新 ([dd2bbe9](https://github.com/Lateo2580/FlEq/commit/dd2bbe9eed359e7a64f1a8c02e5d5edba23ec10c))

## [0.1.16](https://github.com/Lateo2580/FlEq/compare/v0.1.15...v0.1.16) (2026-02-14)


### バグ修正

* historyテーブル描画の全角文字幅対応 ([7ec77e3](https://github.com/Lateo2580/FlEq/commit/7ec77e378689e43a1f0604bf781be62930d2969c))

## [0.1.15](https://github.com/Lateo2580/FlEq/compare/v0.1.14...v0.1.15) (2026-02-14)


### ドキュメント

* CLAUDE.mdに電文ルーティング・テスト・フレームレベルの情報を追記 ([2f99b42](https://github.com/Lateo2580/FlEq/commit/2f99b429965199a2cd0a47ead2a3e8ff13d059a2))

## [0.1.14](https://github.com/Lateo2580/FlEq/compare/v0.1.13...v0.1.14) (2026-02-14)


### 機能追加

* 津波・地震活動テキスト電文の構造化パース・表示とテスト追加 ([9a16436](https://github.com/Lateo2580/FlEq/commit/9a16436d981d927a3ed8a3a3b71890db11353a0f))

## [0.1.13](https://github.com/Lateo2580/FlEq/compare/v0.1.12...v0.1.13) (2026-02-14)

## [0.1.12](https://github.com/Lateo2580/FlEq/compare/v0.1.11...v0.1.12) (2026-02-14)


### バグ修正

* EEW表示フォーマットを改善（バナー幅・時刻形式・レイアウト調整） ([aa6e44f](https://github.com/Lateo2580/FlEq/commit/aa6e44f6b2f37ab9eaa630e7f0fe24ff9b114ff5))

## [0.1.11](https://github.com/Lateo2580/FlEq/compare/v0.1.10...v0.1.11) (2026-02-14)


### 機能追加

* 表示レイアウトを優先度別フレーム・カード形式に改修し情報伝達力を向上 ([2d06d2d](https://github.com/Lateo2580/FlEq/commit/2d06d2da7007a300f430ce3150119c656688713e))

## [0.1.10](https://github.com/Lateo2580/FlEq/compare/v0.1.9...v0.1.10) (2026-02-14)


### ドキュメント

* README.md を再構成後のコードベースに合わせて全面更新 ([594fe94](https://github.com/Lateo2580/FlEq/commit/594fe94a2cec2c525a03766162ae11b77832e517))

## [0.1.9](https://github.com/Lateo2580/FlEq/compare/v0.1.8...v0.1.9) (2026-02-14)


### リファクタリング

* src/ ディレクトリ構成を責務ベースに再編成 ([ecfca64](https://github.com/Lateo2580/FlEq/commit/ecfca644ec8d544de78202655a863c25435e1168))

## [0.1.8](https://github.com/Lateo2580/FlEq/compare/v0.1.7...v0.1.8) (2026-02-14)


### ドキュメント

* README にテスト・Config管理・EEWトラッカー等の情報を追加 ([ca72259](https://github.com/Lateo2580/FlEq/commit/ca72259e4dc8a248dd91ee78649342dcdb13c2df))

## [0.1.7](https://github.com/Lateo2580/FlEq/compare/v0.1.6...v0.1.7) (2026-02-14)


### 機能追加

* Vitest テスト基盤を構築し、パーサー・表示・EEWトラッカーのテストを追加 ([6fd8b7d](https://github.com/Lateo2580/FlEq/commit/6fd8b7d68672cfd649e0fed31f5aa64bf32d76e5))

## [0.1.6](https://github.com/Lateo2580/FlEq/compare/v0.1.5...v0.1.6) (2026-02-14)


### バグ修正

* コードレビュー指摘事項を一括修正 ([6a7e14d](https://github.com/Lateo2580/FlEq/commit/6a7e14d2e99d968762ae20c55caeafba0cabf242))

## [0.1.5](https://github.com/Lateo2580/FlEq/compare/v0.1.4...v0.1.5) (2026-02-14)


### 機能追加

* EEW キャンセル報表示と複数イベント同時管理を実装 ([1ae9f0a](https://github.com/Lateo2580/FlEq/commit/1ae9f0ac1822b18825249e08b922b124d5e39949))

## [0.1.4](https://github.com/Lateo2580/FlEq/compare/v0.1.3...v0.1.4) (2026-02-14)


### 機能追加

* REPL インタラクティブコマンドを実装 ([6bc7524](https://github.com/Lateo2580/FlEq/commit/6bc7524db9ebea82710db5988238923e1ffe0169))

## [0.1.3](https://github.com/Lateo2580/FlEq/compare/v0.1.2...v0.1.3) (2026-02-14)


### 機能追加

* 起動時に契約状況を確認し契約済み区分のみで接続する ([efad1ce](https://github.com/Lateo2580/FlEq/commit/efad1ce4394c24a6d78887ab185f3a9a00d0f719))

## [0.1.2](https://github.com/Lateo2580/FlEq/compare/v0.1.1...v0.1.2) (2026-02-14)


### リファクタリング

* bin フィールドのコマンド名を fleq に変更 ([9b527e8](https://github.com/Lateo2580/FlEq/commit/9b527e8ca346b15af17c13e7a328b28fb27474b8))


### ドキュメント

* CLAUDE.md にリリースフロー手順を追加 ([5ffa4c1](https://github.com/Lateo2580/FlEq/commit/5ffa4c1bea85b720c3bc3c0165f4d80e16db5909))

## [0.1.1](https://github.com/Lateo2580/FlEq/compare/v0.1.0...v0.1.1) (2026-02-14)

## 0.1.0 (2026-02-14)


### 機能追加

* Configファイルによる設定管理機能を追加 ([8499394](https://github.com/Lateo2580/FlEq/commit/84993941dda9f5518573d10a27df4b9323491685))
* デフォルト受信区分にEEW予報・警報を追加 ([e90a624](https://github.com/Lateo2580/FlEq/commit/e90a6240762d8cb959f4ce48cb2755d301381429))


### バグ修正

* 震源地名と最大震度が空白で表示される問題を修正 ([db72736](https://github.com/Lateo2580/FlEq/commit/db72736831694e15ead649f23c5ec1e9d955f6b4))


### リファクタリング

* 起動バナーを1行表示に簡略化 ([55e22a9](https://github.com/Lateo2580/FlEq/commit/55e22a9132eb2d49dda75474f7b4b7e5cbd15897))
