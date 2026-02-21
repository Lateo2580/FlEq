# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

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
