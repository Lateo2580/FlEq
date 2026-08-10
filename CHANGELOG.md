# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [3.3.0](https://github.com/Lateo2580/FlEq/compare/v3.2.0...v3.3.0) (2026-08-10)


### 機能追加

* **foundation:** 台風移動速度の定性語を CLI とテロップへ拡張表示する ([6d1c79b](https://github.com/Lateo2580/FlEq/commit/6d1c79bf6979aff03e72eca4e795f790cbd8db41))
* **foundation:** 深さ「ごく浅い」へ内部 upperBound を付与し ? badge を解消する ([909f203](https://github.com/Lateo2580/FlEq/commit/909f2038858edc0a4099ac9955bc5ec1db4dc7b9))
* **foundation:** 電文基盤 Phase 1 として共通型と shadow extractor を追加する ([fffb84e](https://github.com/Lateo2580/FlEq/commit/fffb84e915387bb069864572cd141d5e14890d6e))
* **foundation:** 電文基盤 Phase 2 として訓練・試験判定を一元化する ([013961f](https://github.com/Lateo2580/FlEq/commit/013961f9c6da8fe303d3ce2b1acbb83f179b22c5))
* **foundation:** 電文基盤 Phase 3A として共通 revision gate を EEW へ適用する ([92245f9](https://github.com/Lateo2580/FlEq/commit/92245f94376606a28f28a0aab4c0377b133749ad))
* **foundation:** 電文基盤 Phase 3B 変更単位 1 として VPWS50 を共通 registry と persistence v2 へ移行する ([4e07b5c](https://github.com/Lateo2580/FlEq/commit/4e07b5c3b7616b55567d99c26c6a4f269ac0b648))
* **foundation:** 電文基盤 Phase 3B 変更単位 2 として津波 domain を共通 registry へ移行する ([e528b9a](https://github.com/Lateo2580/FlEq/commit/e528b9a8ebec4f0a9d3cb7fdda54012e587b6bd7))
* **foundation:** 電文基盤 Phase 3B 変更単位 3 として VPWW56 を共通 registry へ移行する ([0d84f42](https://github.com/Lateo2580/FlEq/commit/0d84f42a2aeef7692b3d5ea71fe0d798c635330f))
* **foundation:** 電文基盤 Phase 3B 変更単位 4 として火山 domain を共通 registry へ移行する ([4f9bf26](https://github.com/Lateo2580/FlEq/commit/4f9bf26cf8cbf4ef4305f4a3c5b20537eb2a0740))
* **foundation:** 電文基盤 Phase 3B 変更単位 5 として洪水 domain を共通 registry へ移行する ([4790fcb](https://github.com/Lateo2580/FlEq/commit/4790fcb70911013dccfafdd61edae17d1aaa1ce2))
* **foundation:** 電文基盤 Phase 3B 変更単位 6+7 として standby/transient 全 domain を共通 registry へ移行する ([9f88b6b](https://github.com/Lateo2580/FlEq/commit/9f88b6b450e09022540dc10093f8446961b5d099))
* **foundation:** 電文基盤 Phase 4A 変更単位 1 として共通震度契約を導入する ([c393158](https://github.com/Lateo2580/FlEq/commit/c393158dd87fa4b7bbc8bf96d5ab152771c09bba))
* **foundation:** 電文基盤 Phase 4A 変更単位 2 として parser を SpecialValue へ実移行する ([59ae6f7](https://github.com/Lateo2580/FlEq/commit/59ae6f7c952a8efda6b52c1f4da272ccc79bbc16))
* **foundation:** 電文基盤 Phase 4A 変更単位 3 として観測保持と永続化を共通契約へ移行する ([78bf07b](https://github.com/Lateo2580/FlEq/commit/78bf07b777e8613fa1ff458e2303bb61d0ad45e9))
* **foundation:** 電文基盤 Phase 4A 変更単位 4 として EEW safety flow を共通契約へ移行する ([81df922](https://github.com/Lateo2580/FlEq/commit/81df922e97e138dbce65cb857a572079bdef0045))
* **foundation:** 電文基盤 Phase 4A 変更単位 5 として下流出口の qualifier 貫通を実装する ([b33acf7](https://github.com/Lateo2580/FlEq/commit/b33acf7589ffc4337da0fc75847eef825258313e))
* **foundation:** 電文基盤 Phase 4A 変更単位 6 として display protocol と projection を semantic 化する ([eac04d5](https://github.com/Lateo2580/FlEq/commit/eac04d5fcc4b183104d0d59af445a429ff9f7640))
* **foundation:** 電文基盤 Phase 4A 変更単位 7 として frontend の特殊値表示を実装する ([052dfd1](https://github.com/Lateo2580/FlEq/commit/052dfd1d130d92dbc328583279debb8eafa7d161)), closes [#cc79a7](https://github.com/Lateo2580/FlEq/issues/cc79a7)
* **foundation:** 電文基盤 Phase 4A 変更単位 8 として契約テストと仕様書を完了同期する ([0e67c22](https://github.com/Lateo2580/FlEq/commit/0e67c223551f1d8a4843903b349bca72180c8fa4))
* **foundation:** 電文基盤 Phase 4B 変更単位 1 として津波 parser のコード保持と TsunamiHeight の SpecialValue 化を実装する ([327f9a2](https://github.com/Lateo2580/FlEq/commit/327f9a21f31deb8879fa68390d2392c77500ecad))
* **foundation:** 電文基盤 Phase 4B 変更単位 2 として keyed tsunami state と EventID revision gate・取消規約を実装する ([826ce16](https://github.com/Lateo2580/FlEq/commit/826ce16c01b002f4b2d387cdb5c4a88567ffe0de))
* **foundation:** 電文基盤 Phase 4B 変更単位 3 として presentation・CLI・通知の code 貫通を実装する ([73a01e3](https://github.com/Lateo2580/FlEq/commit/73a01e33c8a0f49ce5d9e4923bf9b31502ae7112))
* **foundation:** 電文基盤 Phase 4B 変更単位 4 として display protocol と Pi 行 identity の code 化を実装する ([b94149e](https://github.com/Lateo2580/FlEq/commit/b94149e783b55ce9eb1a3331f8538c59e972226f))
* **foundation:** 電文基盤 Phase 4B 変更単位 5 として高さ semantic の Pi 表示・色・badge を実装する ([7c14480](https://github.com/Lateo2580/FlEq/commit/7c14480cb51d65c4ae1aa1415f56374e226fbcaa))
* **foundation:** 電文基盤 Phase 4B 変更単位 6 として永続化 migration と legacy adapter 読込専用化を実装する ([f7d2f5d](https://github.com/Lateo2580/FlEq/commit/f7d2f5dd01538b3a2509f9947d3ed350300da7d2))
* **foundation:** 電文基盤 Phase 5A 変更単位 2 として Magnitude・Depth の SpecialValue 抽出と旧 scalar adapter を実装する ([505d171](https://github.com/Lateo2580/FlEq/commit/505d171270a4adc8e90422f5d25c4bd9251eb593))
* **foundation:** 電文基盤 Phase 5A 変更単位 3 として Magnitude・Depth semantic の伝搬・通知・engine 投影を実装する ([8e7dffc](https://github.com/Lateo2580/FlEq/commit/8e7dffc7cd2c5a30116fcf026722b4a1c63d0ae0))
* **foundation:** 電文基盤 Phase 5A 変更単位 4 として地震 state・merge・永続化の semantic 対応を実装する ([638b190](https://github.com/Lateo2580/FlEq/commit/638b1904a0a40159a8442eefa2b3e47e9a26d104))
* **foundation:** 電文基盤 Phase 5A 変更単位 5 として EEW tracker の canonical diff と diff 行表示を実装する ([16815ad](https://github.com/Lateo2580/FlEq/commit/16815ad2fca03ee9b28d92af2f1ffb8e2c6caaf3))
* **foundation:** 電文基盤 Phase 5A 変更単位 6 として全表示 surface と frontend の semantic 対応・横断 contract を実装する ([30b0d4d](https://github.com/Lateo2580/FlEq/commit/30b0d4dd7dd673d37e3897b6f258c3cbc4d7a622))
* **foundation:** 電文基盤 Phase 5B 変更単位 2 として台風数値の SpecialValue 抽出と共通 helper を実装する ([e15ed6b](https://github.com/Lateo2580/FlEq/commit/e15ed6b88348db7a85f2cfcd7a072858609580ff))
* **foundation:** 電文基盤 Phase 5B 変更単位 3 として台風数値の semantic 伝搬・state・永続化を実装する ([f86d853](https://github.com/Lateo2580/FlEq/commit/f86d853d01b33dcb595906e2a72f3438c118cb7b))
* **foundation:** 電文基盤 Phase 5B 変更単位 4 として台風カードの qualitative 表示と横断 contract を実装する ([0e964f5](https://github.com/Lateo2580/FlEq/commit/0e964f5a9e039413b579d40ea8582a905ac3d904))
* **foundation:** 電文基盤 Phase 5C 変更単位 2 として噴煙高度の SpecialValue 抽出と共通 helper を実装する ([fc9f32e](https://github.com/Lateo2580/FlEq/commit/fc9f32e9b74a984c8bd8c226f01ef238fa1920e6))
* **foundation:** 電文基盤 Phase 5C 変更単位 3 として噴煙高度の semantic 伝搬・fingerprint 移行・永続化を実装する ([11d4709](https://github.com/Lateo2580/FlEq/commit/11d4709ace59c055e9901c16f3c831c775979051))
* **foundation:** 電文基盤 Phase 5C 変更単位 4 として噴煙高度の表示 surface と警報 canonical 切替を実装する ([da5f5a5](https://github.com/Lateo2580/FlEq/commit/da5f5a580fda1b2e9378dd0d385a3a979154befa))


### バグ修正

* **display:** 待機カードの選抜を三段構えにして重要カードの無言非表示を解消する ([f59ff5d](https://github.com/Lateo2580/FlEq/commit/f59ff5d808de92230b65fb8e4d2e6e73e9b43a10))
* **display:** 火山カードの警戒レベル重複行を抑止し待機カード仕様を同期する ([cb646be](https://github.com/Lateo2580/FlEq/commit/cb646be28d8b995af5b2e598cf22011c329c4b94))
* **display:** 火山警戒レベル重複を実データの warningKind へ対応し台風 compact の表示を調整する ([892bc28](https://github.com/Lateo2580/FlEq/commit/892bc283dd1d5d8e85a978596362b114cf5ee93c))


### ドキュメント

* **foundation:** Phase 5B・5C の仮裁定 10 件をご主人確認済みとして確定に更新する ([391bfab](https://github.com/Lateo2580/FlEq/commit/391bfab897f62cb526447afa5c788d59e9d55faa))
* **foundation:** 電文基盤 Phase 4B の完了を仕様書へ同期する ([cab086e](https://github.com/Lateo2580/FlEq/commit/cab086e09faf68612581e817f2557d7e8c4b8735))
* **foundation:** 電文基盤 Phase 5A の完了を仕様書へ同期する ([5bfe725](https://github.com/Lateo2580/FlEq/commit/5bfe725a2fdbfa2c2c72bc0271f5fb513d10141b))
* **foundation:** 電文基盤 Phase 5A 変更単位 1 として実装契約と変更単位を仕様書へ固定する ([342e102](https://github.com/Lateo2580/FlEq/commit/342e102f7d46860c15c86dcaac8e7a67fdc063db))
* **foundation:** 電文基盤 Phase 5B・5C の完了を仕様書へ同期する ([eb706fd](https://github.com/Lateo2580/FlEq/commit/eb706fdc4d3f3be852a47c78d8b18539a2b015d5))
* **foundation:** 電文基盤 Phase 5B・5C の実装契約と変更単位を仕様書へ固定する ([834449f](https://github.com/Lateo2580/FlEq/commit/834449f4f4965d4d49d9692c2131ac6cb0999bf6))
* **specs:** 電文基盤共通化仕様に Sol レビュー 3 巡の指摘を反映し実装可とする ([eedfc55](https://github.com/Lateo2580/FlEq/commit/eedfc5506d6d90b891efcfcabbb1c1e217bfa8f0))
* **specs:** 電文基盤共通化仕様のドラフトを追加する ([f634e41](https://github.com/Lateo2580/FlEq/commit/f634e410a39e3799646ec5cf2b38929673d29b2f))
* **specs:** 電文基盤共通化仕様を Phase 3B 実装確定の最終設計へ同期する ([809b056](https://github.com/Lateo2580/FlEq/commit/809b056c660127c6e6e96bc237e75732b6d2bb73))

## [3.2.0](https://github.com/Lateo2580/FlEq/compare/v3.1.0...v3.2.0) (2026-07-30)


### 機能追加

* **display:** EEW パネルの震度別地域数の集約表示を削除する ([ed26604](https://github.com/Lateo2580/FlEq/commit/ed26604317c58c6b47a61a2cc0c02eb025026068))
* **display:** L4 危険警報の見出し昇格・更新バッジ移動・台風の最大瞬間風速を追加する ([aebb220](https://github.com/Lateo2580/FlEq/commit/aebb22005b52ccba51e73ce6777126942e84bba1))
* **display:** 火山カードに警報種別の補助行を追加し深さを「ごく浅い」表記にする ([2bfe72d](https://github.com/Lateo2580/FlEq/commit/2bfe72d9ba967bb69635d4c2abe49549569fd8a7))
* **display:** 火山カードに噴火観測の数値ブロックと警戒レベル併記を追加する ([8e87682](https://github.com/Lateo2580/FlEq/commit/8e876828486e452a84077e8f178f15e2bc0e78b6))
* **display:** 震度マップ Phase 1 境界アセットパイプラインを実装する ([9b4a4bd](https://github.com/Lateo2580/FlEq/commit/9b4a4bd30159e59261fd4a75f6c8c80b0eeb227d))
* **display:** 震度マップ Phase 2 として VXSE の地域コードを Presentation まで通す ([147fafd](https://github.com/Lateo2580/FlEq/commit/147fafd4769590d8b138ff54fda2c90c0108be7c))
* **display:** 震度マップ Phase 3 として mapLayers の wire と状態管理を実装する ([fd09249](https://github.com/Lateo2580/FlEq/commit/fd09249632e47c4ed635d5f6441c3364764b9646))
* **display:** 震度マップ Phase 4A として全国図を QuakePanel に統合する ([0bda651](https://github.com/Lateo2580/FlEq/commit/0bda651eb0d194abfdff25cef89dec8efae6e311))
* **display:** 震度マップ Phase 4B として震度3〜4の専用非緊急画面を追加する ([9fe3874](https://github.com/Lateo2580/FlEq/commit/9fe38748b4906e6960b2dd653b20424308034055))
* **display:** 台風カードに気圧・最大風速の変化と発達/衰弱傾向を表示する ([4ee669d](https://github.com/Lateo2580/FlEq/commit/4ee669dab1e80ced2550694627e2ee36891fe22c))
* **display:** 台風カードの見出しを強さ・大きさ階級の意味色にする ([6ed62fc](https://github.com/Lateo2580/FlEq/commit/6ed62fc90be42189fc71e6cc3aab8fdd18e97404))
* **display:** 地震カードの市区町村数カウント表示を削除する ([1785ee9](https://github.com/Lateo2580/FlEq/commit/1785ee970cf247c040a289715892ff64ac8a9b5f))
* **display:** 地震履歴と当日カウンタを永続化し再起動を跨いで復元する ([6b1c185](https://github.com/Lateo2580/FlEq/commit/6b1c185dc1017a47b593279620f95dc1a0f041d5))
* **display:** 熱中症警戒アラートカードの日付を「きょう」「あす」相対表記にする ([f127306](https://github.com/Lateo2580/FlEq/commit/f127306fbf54392f2b6835d5610b6d7f7c2ef1d3))
* **display:** 背景トーンの本番色を公的定義色アンカーで確定する ([05e4c72](https://github.com/Lateo2580/FlEq/commit/05e4c72fd9077c66c597f91a0c8271bfc68c5354)), closes [#131300](https://github.com/Lateo2580/FlEq/issues/131300) [#1A0400](https://github.com/Lateo2580/FlEq/issues/1A0400) [#1A001](https://github.com/Lateo2580/FlEq/issues/1A001) [#1D0010](https://github.com/Lateo2580/FlEq/issues/1D0010) [#566069](https://github.com/Lateo2580/FlEq/issues/566069) [#59636](https://github.com/Lateo2580/FlEq/issues/59636)
* **display:** 竜巻注意情報のテロップに優先粒度の全対象地域を流す ([f7cf536](https://github.com/Lateo2580/FlEq/commit/f7cf536911f3e9fcb3ac756b05acf8ad3d453cba))


### バグ修正

* **display:** 監査 High 対応 (A) — M不明表現・EEW範囲・津波予報音・訂正反映を修正する ([013718b](https://github.com/Lateo2580/FlEq/commit/013718b350497c3229af2a6869942752a78961d1))
* **display:** 監査 High 対応 (B) — 津波の実測値表示と観測状態管理を修正する ([4672984](https://github.com/Lateo2580/FlEq/commit/467298467e5716eab4beacda3967f74e7000b6cb))
* **display:** 監査 High 対応 (C) — 取消・終了電文の残留カードを解消する ([c76f357](https://github.com/Lateo2580/FlEq/commit/c76f3578ebb4fbdd20ef5d824ac99a90ce9ab012))
* **display:** 再起動時に気象警報カードと河川水位カードが復元されない問題を修正する ([47d7c8b](https://github.com/Lateo2580/FlEq/commit/47d7c8b79d333945f5965534b37848f1b30e5b54))
* **display:** 台風カードの stat 列を 2×2 グリッド化し狭幅の折り返しを制御する ([81cbbf9](https://github.com/Lateo2580/FlEq/commit/81cbbf99cb2fc79cb1054f275ac9b5f869ddc7c6))
* **display:** 同一地震の震度なし続報で観測済み震度が「-」に退行する問題を修正する ([8ae54aa](https://github.com/Lateo2580/FlEq/commit/8ae54aa7d988bd9e904618e8df922c2a5f5d1a52))


### ドキュメント

* **specs:** 震度マップ (地図レイヤー a) 仕様のドラフトを追加する ([894a0a4](https://github.com/Lateo2580/FlEq/commit/894a0a489d91ee9068f019c3b1e2ba4587da342e))
* **specs:** 震度マップ仕様に Sol レビュー 2 巡の指摘を反映し実装可とする ([10ceaed](https://github.com/Lateo2580/FlEq/commit/10ceaede956016920822c80b5cd87205d660db94))

## [3.1.0](https://github.com/Lateo2580/FlEq/compare/v3.0.0...v3.1.0) (2026-07-29)


### 機能追加

* **display:** dim transition を共有トークン化し洪水モーション検証シナリオを追加 ([94ab388](https://github.com/Lateo2580/FlEq/commit/94ab3887821a040544f7ee0ec75b83a6ac1ad170))
* **display:** NumberUnit に prefix 対応と添え字サイズ変数を追加 ([927882a](https://github.com/Lateo2580/FlEq/commit/927882a6f39f7e00134a7d81dd77b5b3757f1b40))
* **display:** overflow 集約行を 32px 固定化し実機再現 preview シナリオを追加 ([120ad45](https://github.com/Lateo2580/FlEq/commit/120ad450435f238fe0d00a5e48f12ad8d938306b))
* **display:** preview に standbyItems の目視シナリオ 2 種を追加 ([ca825c1](https://github.com/Lateo2580/FlEq/commit/ca825c1bf92a3b9d51d9379b5056b8f83f4b316b))
* **display:** コントラスト監査に panel 面のペアを追加し、仕様を同期する ([406da97](https://github.com/Lateo2580/FlEq/commit/406da97753ad559cf39f06fc8fc33dce4e38ed90))
* **display:** 右スタックに measurement shelf を配線し実高選抜へ切替 ([209ba60](https://github.com/Lateo2580/FlEq/commit/209ba604559a9245ae5c3247cb7abdf1d178ad73))
* **display:** 右スタック実高計測ストアを追加 (一括切替ゲート + ヒステリシス) ([3193c48](https://github.com/Lateo2580/FlEq/commit/3193c4862b78709c941755b154148c8445b85f17))
* **display:** 右スタック選抜に severity 下限ガードを導入 ([1870009](https://github.com/Lateo2580/FlEq/commit/1870009d6ed07ddb33c5b5d1f5706e9608259858))
* **display:** 火山・早期天候テロップに専用文言を追加し headline 生流出を解消 ([9f29ef0](https://github.com/Lateo2580/FlEq/commit/9f29ef0fae472a91b3b1d717ffb6323c32124296))
* **display:** 火山警戒レベルを NumberUnit prefix 形式に統一 ([8880206](https://github.com/Lateo2580/FlEq/commit/8880206f5e7d6046c0a7305d7e2b4c3375755b3d))
* **display:** 気象・台風・火山・津波カードの見出しに最終更新時刻を表示する ([437dae1](https://github.com/Lateo2580/FlEq/commit/437dae19d53b2de36c7d5fcc0b21a2de75ad3c71))
* **display:** 気象警報を緊急画面の主役パネルへ昇格させる (Spec C Phase 2) ([7824926](https://github.com/Lateo2580/FlEq/commit/7824926dda4619e0f0a4aed62f77135085921882))
* **display:** 規模表示を NumberUnit prefix 形式に統一 ([b27cae5](https://github.com/Lateo2580/FlEq/commit/b27cae595b4eb1c927fa25414c0b8b3c17ea6b95))
* **display:** 緊急カードを流動レイアウト化し「今日あった地震」を追加する ([df179e2](https://github.com/Lateo2580/FlEq/commit/df179e2a5801772c5b3cfb5430bc476a56ecfd50))
* **display:** 緊急画面に防災情報テロップを追加する ([fc8449a](https://github.com/Lateo2580/FlEq/commit/fc8449ae99a0466307c11fd0eb539f47d4742caa))
* **display:** 警戒レベル4/5相当の気象警報の昇格状態を engine に追加 ([d3b6563](https://github.com/Lateo2580/FlEq/commit/d3b6563374fd0a60bdf61ab2e0d785fab77fba80))
* **display:** 洪水 corner カードの水位表記を構造化 (サイズ据置き) ([322b008](https://github.com/Lateo2580/FlEq/commit/322b008e8560464aea7f5108b154ffc3ae1c4e31))
* **display:** 洪水カード (projection 三分類・FloodActiveReducer・通常/中央ワイド表示) を追加 ([48aac42](https://github.com/Lateo2580/FlEq/commit/48aac42e0e29e4da5e8aac20a3d78bf6760e19ce))
* **display:** 洪水カードの水位表示とデザイン反復ラウンドをまとめて反映 ([113344d](https://github.com/Lateo2580/FlEq/commit/113344d2868a2d2e5ac6463fd966289c7a39a722))
* **display:** 洪水セルの観測所名を小見出し化し水位を主役数値に拡大 ([bf1edd5](https://github.com/Lateo2580/FlEq/commit/bf1edd574874d8cab17588313a49e275f7b800a2))
* **display:** 洪水ワイドカードの増減アニメーション ([e490232](https://github.com/Lateo2580/FlEq/commit/e490232776b558050b12d238f0665b5acb0a8301))
* **display:** 洪水ワイドセルの微調整 (水位拡大・矢印色分け・グラフ拡張・集約行圧縮) ([4fbc149](https://github.com/Lateo2580/FlEq/commit/4fbc14994cf16b9bb6d24162318681f6919d1f08))
* **display:** 洪水ワイドセルを 2×2 ラベルグリッドに再構成 (ご主人レイアウト案) ([cc1002a](https://github.com/Lateo2580/FlEq/commit/cc1002a9d3c2b6688405bc30ff91c28e8f29d7d3))
* **display:** 洪水ワイドセルを低背化 (ラベル削除・左右 4:6・グラフ全幅) ([276618d](https://github.com/Lateo2580/FlEq/commit/276618dea814a29d8949fe1e179298999a1e79b1))
* **display:** 昇格の根拠になった view を record に内包して永続化する ([b1915a3](https://github.com/Lateo2580/FlEq/commit/b1915a35190bcab4fcb5203aee900a6ff4f17b21))
* **display:** 情報ゼロの VPWP50 テロップを tickerSuppressed で抑制 ([c966c6c](https://github.com/Lateo2580/FlEq/commit/c966c6cc7642f88541b1041c1cf4bf09f38f1049))
* **display:** 数値+単位タイポグラフィ (NumberUnit) とグラフ端切れ修正 ([baea096](https://github.com/Lateo2580/FlEq/commit/baea096a14a32d11d7e62225ab8ba02fab86885d))
* **display:** 待機画面カード基盤 (protocol/registry/StandbyStateStore/永続化/monitor 配線) ([a54a1fd](https://github.com/Lateo2580/FlEq/commit/a54a1fd9f874fe9e2e5b1e06af6e709050426682))
* **display:** 点灯規則を仕上げる (engine) — resume/restore 責務分離と SSE 可視時間契約 ([a43c209](https://github.com/Lateo2580/FlEq/commit/a43c209f85869cb759e027713e46b12b26fb52c1))
* **display:** 点灯規則を仕上げる (frontend) — 跨 source 行統合・装飾スコープ・実測ガード ([76976fe](https://github.com/Lateo2580/FlEq/commit/76976fe1b9b41e8e471f35940df5d906c921105c))
* **display:** 南海トラフバッジ・竜巻/長周期 rider・減光連動・統合テストを追加 ([607b5dc](https://github.com/Lateo2580/FlEq/commit/607b5dc0b944b4b46c4fa8f0f2c9c9996a1a37ed))
* **display:** 熱中症・台風・火山カードと右上スタック/overflow 要約を追加 ([94625ad](https://github.com/Lateo2580/FlEq/commit/94625ad2c90218f81aa377ee0b1869e162dedd8c))
* **display:** 熱中症カードの対象府県をカード内マーキーで全数表示 ([485c00c](https://github.com/Lateo2580/FlEq/commit/485c00c46cb7e3bfa2d0213a21de2d8631e6f50e))
* **display:** 背景トーンを表示契約化する (backgroundTone / tickerSurface) ([9635537](https://github.com/Lateo2580/FlEq/commit/9635537fc5c155d85a13e2754e91875119de4116))
* **messages:** message-router に汎用 routed-message tap を追加 (R1 手順 1) ([14c528e](https://github.com/Lateo2580/FlEq/commit/14c528edd0f52c8013adeb764793034b0a62c1b3))
* **messages:** runDisplayPipeline 入口に処理済み outcome の汎用 tap を追加 ([bc1c6be](https://github.com/Lateo2580/FlEq/commit/bc1c6beec4f903f8cd3a3a0371f3823125b20ae1))
* **site:** Features + Categories ([6054ab2](https://github.com/Lateo2580/FlEq/commit/6054ab2ffa30cd4824c96d9dabe3a71cdd116675))
* **site:** hero DOM + CSS + animation overlay ([98318f2](https://github.com/Lateo2580/FlEq/commit/98318f25047fb051e0ec51c8684034e2bcefd604))
* **site:** hero アニメの退場を「全表示 → 保持 → 同時フェード」に変更 (ご主人要望) ([77402ea](https://github.com/Lateo2580/FlEq/commit/77402ea7f3abbbc88363f8f309ddf5d4a64ed8b7))
* **site:** Install + Footer ([79e1a75](https://github.com/Lateo2580/FlEq/commit/79e1a75c45e8580cc74d52889a7f8a6eb3c1fa5b))
* **site:** script.js の 5 IIFE (nav-height / theme / copy / hero animation / smooth scroll) ([9db761d](https://github.com/Lateo2580/FlEq/commit/9db761dbe3120ed89fedd7e209c74797cbc8bb5e))
* **site:** ランディングページ v3.0.0 全面刷新 (観測所の紙記録 design language) ([b21306d](https://github.com/Lateo2580/FlEq/commit/b21306d793dd41a975b2803ad9cd68ad5f48df29))
* **site:** 表示とテーマ編集セクション (CLI + Display + Studio) ([c18426f](https://github.com/Lateo2580/FlEq/commit/c18426f012fd0e6fb8a0b5b6c8fde4213fae537c))


### バグ修正

* **display:** EEW テロップ履歴に専用 TTL 10 分を導入 ([9ae46f0](https://github.com/Lateo2580/FlEq/commit/9ae46f0327cc0364f3ececf0c26330c31c42062d))
* **display:** push 前最終レビュー 3 件を修正 (現況/予測の断定分離ほか) ([fad1a5c](https://github.com/Lateo2580/FlEq/commit/fad1a5c18a8d02c48629b20dfd22ebfd66e8a767))
* **display:** reload クールダウンの短周期リトライループを解消 ([30dc67e](https://github.com/Lateo2580/FlEq/commit/30dc67e74865f9546d1a9e0ba37863b2a7d892a3))
* **display:** snapshot 縮退時も active EEW テロップを固定保持 ([e758607](https://github.com/Lateo2580/FlEq/commit/e758607cf87e4368d21cc08408dadda7315ebc9d))
* **display:** standby と VPWP50 の永続化で tmp 競合を解消する ([984bd09](https://github.com/Lateo2580/FlEq/commit/984bd09612fdfd7a79b7176ddabede2df903a101))
* **display:** VFVO53 バッチを火山ごとのテロップに分割し取消系列を火山単位化 ([75497c1](https://github.com/Lateo2580/FlEq/commit/75497c1b791e268e01c2e2ddcce7231fa1410de3))
* **display:** テストのタイムゾーンを Asia/Tokyo に固定する ([300a956](https://github.com/Lateo2580/FlEq/commit/300a95643194e3d4b248c0bbda9b7e268e3abd0d))
* **display:** テロップの EEW 除外と震源不明地震の地域要約 ([0bd9174](https://github.com/Lateo2580/FlEq/commit/0bd91745e4ec3e6cd7eacc8e5f15c2ca4286fbc8))
* **display:** 右上の積み順を spec §4 どおり気象警報カード最上位に修正 ([200e716](https://github.com/Lateo2580/FlEq/commit/200e716ab3912cd84d36aef2839e5acf8df14a36))
* **display:** 火山 groupKey のコード付加を VFVO53 に限定し取消の系列分裂を解消 ([b700ded](https://github.com/Lateo2580/FlEq/commit/b700deda6d40bfa9a810ab76fba1b90f0338e436))
* **display:** 熊本震度7 実機観測の緊急画面修正 第1弾 ([38514dd](https://github.com/Lateo2580/FlEq/commit/38514ddf2f65c9e2b27f64cd4959950ed7edf2f6))
* **display:** 洪水ワイドの行予算を部位別化し 720p クリップと二重 intro を解消 ([5e0966a](https://github.com/Lateo2580/FlEq/commit/5e0966a25135bdb2d792696ad296243c54845560))
* **display:** 再レビュー残 3 件を修正 (host 選択共有化・解除済み watermark・restored 意味論) ([6ced748](https://github.com/Lateo2580/FlEq/commit/6ced7481a66325e57d98caaa2e491a76f667f4cb))
* **display:** 再接続 snapshot からの古い EEW テロップ再投入を鮮度フィルタで遮断 ([98856da](https://github.com/Lateo2580/FlEq/commit/98856daa5fd3b540dc546832a85ad95a8e92df3e))
* **display:** 最終レビュー指摘 10 件を修正 (長周期 host 対・地域別キー・seed watermark ほか) ([8912f6e](https://github.com/Lateo2580/FlEq/commit/8912f6e32192c5b88a154a30b344e2ac9b4f64f3))
* **display:** 待機 slot を二層化し dim×intro 競合を解消、洪水 surface 切替に手動 FLIP ([33b2fe1](https://github.com/Lateo2580/FlEq/commit/33b2fe1a5029ed14da6fb2f95e5ea0724badcfce))
* **display:** 待機主カードを常に最新の地震へ更新する ([dfbf4ba](https://github.com/Lateo2580/FlEq/commit/dfbf4baecaadad66f5c4d2a1027a6d8423e77c5a))
* **display:** 台風集約カードの restored を some 集約に統一 ([5a0122c](https://github.com/Lateo2580/FlEq/commit/5a0122cc8f3a3cbc53f25450ff6d2dfbd48f71a0))
* **display:** 熱中症カードの対象府県を 6 件 + ほか n 件に縮約し名前内改行を禁則 ([4c51f58](https://github.com/Lateo2580/FlEq/commit/4c51f5889b23deda6251aa1c6b79f9f1bb28b5ac))
* **messages:** Sol 最終レビュー指摘 3 件を反映 ([2d3e4a8](https://github.com/Lateo2580/FlEq/commit/2d3e4a8e7d66d73d2fe1629e152c47c59a1be072))
* **messages:** VPWW56 の state を発表官署単位で保持し union して返す ([dc043c7](https://github.com/Lateo2580/FlEq/commit/dc043c773a1a477696a343130af53b33ba422e28))
* **messages:** 洪水 state holder の EventID 履歴に TTL を入れ二段構造化 ([720df8b](https://github.com/Lateo2580/FlEq/commit/720df8bbb6b81d4d1ae7094f87f7683b8ac840e3))
* **site:** 4 mock を実出力・実画面に忠実化 (誤認防止) ([2e2c1ac](https://github.com/Lateo2580/FlEq/commit/2e2c1ac2dbf7e11c42bb138f21d15f51291d4be6))
* **site:** copy button の連打復元と支援技術通知 (Codex 最終レビュー反映) ([fdc2506](https://github.com/Lateo2580/FlEq/commit/fdc25065f517866050ee76caed63747465a9c50f))
* **site:** Display mock の地震区域名を 5 文字に (390px 幅での改行解消、ご主人指摘) ([e6e093c](https://github.com/Lateo2580/FlEq/commit/e6e093cd6702b6fa2d818e53c681f1d79374bbc8))
* **site:** LP mock を実出力・実画面に忠実化 + アニメ改善 + 欧文 mono 統一 ([213b173](https://github.com/Lateo2580/FlEq/commit/213b1732784415b0fda237525dc8f4d0a67fed17))
* **site:** mock レビュー 4 点反映 (Studio 罫線は palette 非追従・Display 狭幅退避・地震情報ヘッダ帯・aria-hidden) ([e271e50](https://github.com/Lateo2580/FlEq/commit/e271e5054ff64aee2bda447651496c8b4979fb0d))
* **test:** test-samples 遅延ロードテストの実行順依存を解消 ([fe9923d](https://github.com/Lateo2580/FlEq/commit/fe9923db921cff2d584afcf1e06021e1ec6f9b6c))
* **ui:** 統計の表示順 CATEGORY_ORDER に floodForecast を追加 ([9ef4202](https://github.com/Lateo2580/FlEq/commit/9ef4202b2b5edc56d3708694b5db211693daab20))


### パフォーマンス改善

* **display:** standby / VPWP50 cache の永続化を debounce + 非同期化 ([b233fc9](https://github.com/Lateo2580/FlEq/commit/b233fc96810e2e73988860eb71fd7c2b1f0d9344))
* **display:** 続報バッジの毎秒 interval を期限 one-shot に変更 ([d227f36](https://github.com/Lateo2580/FlEq/commit/d227f3607a5adbab5019c19a8d1243b3e8783898))
* **repl:** test-samples を test コマンド実行時の遅延ロードに変更 ([a65f4fa](https://github.com/Lateo2580/FlEq/commit/a65f4faa339a1a8323ba2f8b950f359b382cd61e))
* **ui:** EEW fold の隠れ地域展開を震度別集約行に変更 ([254d8ef](https://github.com/Lateo2580/FlEq/commit/254d8ef66fe745371085c3d3c6b40796e3ffaf39))
* **ui:** VXSU50 表示で使わない河川集約を除去 ([2b39b70](https://github.com/Lateo2580/FlEq/commit/2b39b70dc962234451e7fe43a6e71679a4413194))
* **ui:** 表の詳細回収を hidden 列のみの評価に変更 ([ecc4e74](https://github.com/Lateo2580/FlEq/commit/ecc4e743f59ceb915aecaaa9b4ed4057c5e036cb))
* **weather:** VPWS50 の Body マージを索引化し二次探索を解消 ([e793042](https://github.com/Lateo2580/FlEq/commit/e7930423e16f15b3bb69f6c27c564046909ee7a4))


### リファクタリング

* **dmdata:** XMLParser 生成と抽出ヘルパを xml-shape に集約 (R2) ([88a93a8](https://github.com/Lateo2580/FlEq/commit/88a93a8b3a2371e09d5dbb6b8ec97292b6e5d181))
* **engine:** state holder から detail 描画を分離 (DetailSnapshot 方式) ([8c543bd](https://github.com/Lateo2580/FlEq/commit/8c543bde24d8b16531896f305a9bf6ab403855e6))
* **messages:** jstDayKey の重複定義を共有 util に集約 (R4) ([343f6a1](https://github.com/Lateo2580/FlEq/commit/343f6a1204071a1e4df3f097ead8b6832c023991))
* **messages:** routing を route catalog + 型付き processor 表に集約 (R1) ([9c7e398](https://github.com/Lateo2580/FlEq/commit/9c7e398d79e37f6ea8376694eac9359e3a2c8ed6))
* **messages:** VPWW56 holder のキーを (head.type, publishingOffice) に ([7755da7](https://github.com/Lateo2580/FlEq/commit/7755da77089f91202e029296a2abd0ffa4984e0c))
* **site:** tokens v5 + base + nav skeleton ([27863b0](https://github.com/Lateo2580/FlEq/commit/27863b042072856b9c7ac4707a3d57533bca3b1f)), closes [#1B1815](https://github.com/Lateo2580/FlEq/issues/1B1815)
* **ui:** earthquake-formatter を telegram-type-label に改名 ([4521173](https://github.com/Lateo2580/FlEq/commit/45211736a21d169ed12167c9eb3f6330cc9d80b2))


### ドキュメント

* **display:** NumberUnit 数値+添え字の設計方針を明文化 ([429aa81](https://github.com/Lateo2580/FlEq/commit/429aa81ae0c5d7173799659a9b87416648f4c6be))
* **display:** VFVO53 表示分割とテロップ抑制の仕様を message-pipeline に同期 ([33d4911](https://github.com/Lateo2580/FlEq/commit/33d4911e9200bbee7a8ab30c70215fd0c12a9c0e))
* **display:** 二層 slot・手動 FLIP・dim 同期契約のモーション規約を明文化 ([b9c6c26](https://github.com/Lateo2580/FlEq/commit/b9c6c26f3e49a9a9d602b6d1a46eb2301dde0040))
* **specs:** VPWW56 holder の複合キー化に合わせて仕様を同期 ([4184127](https://github.com/Lateo2580/FlEq/commit/41841272b65a5960b28ecaa260a0656f97bd40fb))
* **specs:** 気象警報の昇格と VPWW56 官署 union の仕様を同期 ([d33cc62](https://github.com/Lateo2580/FlEq/commit/d33cc62205dc437f8be4ef6d76b9636b5ab6989a))
* **specs:** 昇格根拠の控えと tmp 競合修正の仕様を同期 ([3765df5](https://github.com/Lateo2580/FlEq/commit/3765df55d6caeadd2ba948e647a0c2d736667a0a))
* **specs:** 性能修正 6 件の仕様同期 ([8e530ad](https://github.com/Lateo2580/FlEq/commit/8e530adcc4f74b971a4e35c36e1b244eedb7941c))

## [3.0.0](https://github.com/Lateo2580/FlEq/compare/v2.0.1...v3.0.0) (2026-07-19)


### 機能追加

* **core:** 気象電文対応一式とエンジン・UI の全面拡充 ([3cc3b71](https://github.com/Lateo2580/FlEq/commit/3cc3b71e0d329aff40e0a3b73cb7ee9be007ad49))
* **display:** 常設情報ディスプレイ (内蔵 SSE サーバ + Svelte フロントエンド) ([32891c7](https://github.com/Lateo2580/FlEq/commit/32891c727c67736ece545d6bceb6401a7c781181))
* **studio:** Display Studio (テーマ編集・fixture プレビュー環境) ([bf3459d](https://github.com/Lateo2580/FlEq/commit/bf3459d4f11bbf645e51dea2fba08dd571fce363))


### バグ修正

* **build:** display/.npmignore を追加し display/dist の npm 同梱を実現 ([96676e1](https://github.com/Lateo2580/FlEq/commit/96676e156b386a1f88a5b2569a33a1867d99045c))
* **eew:** VXSE44 抑制で eewTracker.update をスキップし第1報通知を発火させる ([81dca00](https://github.com/Lateo2580/FlEq/commit/81dca0086b02e9242fdcd34c7c9ddcf3ee51d07e))
* **startup:** 火山状態復元を複数火山対応の窓 replay に変更 ([222993b](https://github.com/Lateo2580/FlEq/commit/222993b41026498a8d71a0678bc5f2f9f50a938c))
* **volcano:** Lv1 への引下げ (lower) でも警報 entry を削除する ([0f604c0](https://github.com/Lateo2580/FlEq/commit/0f604c077ad21ed8ab98d01d1e182434d586320c))


### リファクタリング

* **cli:** 端末タイトル操作を ui/terminal-title に分離 (cli-run ↔ monitor 循環解消) ([c1dce1e](https://github.com/Lateo2580/FlEq/commit/c1dce1e02abd9ffe683c11b90de096058d7d563b))
* **presentation:** volcano-presentation を notification から presentation 層へ移動 ([f25491b](https://github.com/Lateo2580/FlEq/commit/f25491b42bc205eaa6b7a4f4a45f9d68f47a1b71))
* **startup:** toWsDataMessage を telegram-adapter に一本化 ([258811b](https://github.com/Lateo2580/FlEq/commit/258811b7f40a82bf7c18d3691b0b1d0d72a04f9c))


### ドキュメント

* AGENTS.md 新設 + Codex 併用ルールを分担表 v1 に更新 ([18013a1](https://github.com/Lateo2580/FlEq/commit/18013a12164e84ca483801b4f52b4721ed6e4424))
* **raspi500:** fqr alias と fqu スクリプトを start-fleq.sh 経由起動に修正 ([074c549](https://github.com/Lateo2580/FlEq/commit/074c549d6f78514d04287f051cf254bb97274678))
* README・仕様書・表示リファレンスを公開向けに整備 ([b1c92ae](https://github.com/Lateo2580/FlEq/commit/b1c92aeb865c0a70417ed18998e676c28b05d5ee))
* **specs:** 火山状態復元の窓 replay 化と telegram-adapter 共有を engine.md に反映 ([d3f8681](https://github.com/Lateo2580/FlEq/commit/d3f868157d8d771b42f609ed344eb033f1e00b30))
* **specs:** 端末タイトル分離を engine.md / ui.md に同期 ([dedfb71](https://github.com/Lateo2580/FlEq/commit/dedfb712adc01baa50144d09e9c8c486d2e6cf7a))

## [2.0.1](https://github.com/Lateo2580/FlEq/compare/v2.0.0...v2.0.1) (2026-05-03)


### バグ修正

* **update-checker:** scoped package 名の `/` を %2F に encode する ([6f02a0e](https://github.com/Lateo2580/FlEq/commit/6f02a0e5e9536272d1c4760575f10c7c93cc10d3))
* **update-checker:** scoped パッケージ名対応と personal build 検出 ([b4c75d8](https://github.com/Lateo2580/FlEq/commit/b4c75d8cbec707255e6e8d50a688dee415217f15))

## [2.0.0](https://github.com/Lateo2580/FlEq/compare/v1.51.0...v2.0.0) (2026-04-25)


### ⚠ BREAKING CHANGES

* **policy:** --event-log / --event-log-raw / --no-event-log の
CLI オプションが廃止された。eventLog / eventLogRaw 設定キーも廃止。
これらの機能に依存している外部利用者は、削除前バージョン (v1.52.x)
を pin するか、自身で private fork を保持して継続利用すること。

次回リリースは major bump (v2.0.0) として npm run release:major で
発行する想定。

関連: 段階1 (baf0b41)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

### 機能追加

* **cli:** add --event-log and --event-log-raw flags ([f046653](https://github.com/Lateo2580/FlEq/commit/f046653df9c42d88f0362bdeb34dc87bcdf999f3))
* **cli:** show eventLog status in startup banner ([07d509f](https://github.com/Lateo2580/FlEq/commit/07d509fda93cfc0e4f1d83b9208e5dc0e86e9270))
* **cli:** 起動バナーに音声バックエンドの健康状態を表示 ([30a070e](https://github.com/Lateo2580/FlEq/commit/30a070e0fa97c8c034269c608a050500b058ce6d))
* clock コマンド・ヘルプ・status 表示を uptime 対応に ([f362927](https://github.com/Lateo2580/FlEq/commit/f362927c84515770b609628c2ced7ba0cf19004f))
* commands コマンド新設 — help から一覧表示を分離 ([0eb81c1](https://github.com/Lateo2580/FlEq/commit/0eb81c1fe335617e6346657a0d9bf1cacca0b387))
* **config:** add eventLog and eventLogRaw configuration ([db1f376](https://github.com/Lateo2580/FlEq/commit/db1f376648e705c61d1439f85e75fdde17a74810))
* EEW isWarning 判定を XML ベースに移行 (classification はフォールバック) ([c2087cd](https://github.com/Lateo2580/FlEq/commit/c2087cd931a31af603cadd4eff90a0a33bac833f))
* Event File Writer — write telegrams as individual JSON files ([0ebbd0c](https://github.com/Lateo2580/FlEq/commit/0ebbd0cb21e33d03cb97f7c6a78f996941dbfcad))
* formatUptime 関数を追加 (DDD:HH:MM:SS, dim ゼロ桁) ([a694522](https://github.com/Lateo2580/FlEq/commit/a6945227cc1c3c1d16728356075aae4e9765301b))
* implement EventFileWriter with atomic write ([e05e9cb](https://github.com/Lateo2580/FlEq/commit/e05e9cb66cd61e9af049b2c6e8d2beed7c1f50e8))
* **monitor:** apply eventLog config to EventFileWriter on startup ([12c251b](https://github.com/Lateo2580/FlEq/commit/12c251b1c298d4f8f0446ec93576d8904bed091b))
* ParsedEarthquakeInfo に eventId を追加し、地震情報表示に EventID 行を表示 ([7562377](https://github.com/Lateo2580/FlEq/commit/756237726821e2c48ceed4a58ba2ce62ce3270b8))
* **policy:** dmdata.jp 再配信ポリシー対応の段階1実装 ([baf0b41](https://github.com/Lateo2580/FlEq/commit/baf0b4135878ab6400554bc7c790ddd4c8be6cdc))
* processEew に suppressed kind を追加 (VXSE45 優先時) ([e65b33e](https://github.com/Lateo2580/FlEq/commit/e65b33e6d7ab7480bd13359a7da21661b78a40a7))
* PromptClock 型に uptime を追加 ([d7c2829](https://github.com/Lateo2580/FlEq/commit/d7c2829487b78ebf993c4188ec1054d74b8ad071))
* **repl:** add eventlog command ([874a679](https://github.com/Lateo2580/FlEq/commit/874a679eb4b12d8bba330a205d11a117ab8de2e9))
* **sound:** checkSoundBackend で実再生プローブによる健康チェックを追加 ([46c391c](https://github.com/Lateo2580/FlEq/commit/46c391cb3222e5200594e27040f2f9214aace123))
* **sound:** process.uptime ベースの単調時計ヘルパーを追加 ([6cfc195](https://github.com/Lateo2580/FlEq/commit/6cfc195bf2540f0c6586ad22be8159824fdde49f))
* **sound:** 起動直後 60 秒以内の再生失敗を 20 秒後に自動リトライ ([9b86ff9](https://github.com/Lateo2580/FlEq/commit/9b86ff96111bc18066e0f4aaba7f0f513fd07b1e))
* **sound:** 再生失敗系ログを debug から warn に格上げ ([fd9f1d5](https://github.com/Lateo2580/FlEq/commit/fd9f1d5dc07ba234bbdb9cb0cb76bd9015662673))
* StatusLine で uptime モード表示に対応 (未接続時も表示) ([55c93c7](https://github.com/Lateo2580/FlEq/commit/55c93c7733d5e31fccd5f47944e37736aaa5ec41))
* wire EventFileWriter into message-router and VolcanoRouteHandler ([a1107e0](https://github.com/Lateo2580/FlEq/commit/a1107e00db7adbfdd81c3e377143001c7542e8ce))
* wrap-up コマンド新設 + Codex CLI フラグ更新 + commit リマインド hook 追加 ([68dac86](https://github.com/Lateo2580/FlEq/commit/68dac861fc17e95ce1fb6ac9cb0c43bc5bc62592))
* 警報昇格通知をイベント単位の isUpgradeToWarning に変更 ([2e338dd](https://github.com/Lateo2580/FlEq/commit/2e338dd797f4c814da8209505f2d1e2a822e951b))
* 待機中Tipsに火山カテゴリを追加 (+78項目) ([0f619bb](https://github.com/Lateo2580/FlEq/commit/0f619bb87eb663f611ea461d2002040a0fedafe6))
* 待機中Tipsに気象カテゴリを追加 (警報・予報・定時報) ([deda85e](https://github.com/Lateo2580/FlEq/commit/deda85e46f1b154248a919ac623c3e81ea5d1048))
* 待機中Tipsを大幅拡充 — 新8カテゴリ+229件追加 (444→673件) ([bac458a](https://github.com/Lateo2580/FlEq/commit/bac458a556ddaa807f558fcf57cc0199b10c2a40))
* 統計表示にテーマロールベースのカラーリングを追加 ([d816b17](https://github.com/Lateo2580/FlEq/commit/d816b1766f3b25c2cbd199ee54248df995ef3121))


### バグ修正

* **cli:** let --no-event-log override --event-log-raw ([fe5226e](https://github.com/Lateo2580/FlEq/commit/fe5226e13ccf7d3c8357c925cdff5466755a340f))
* **eew:** isWarning 観測ログを真の仕様不整合のみに絞る ([be1757c](https://github.com/Lateo2580/FlEq/commit/be1757cabf7ae22b7c8045e316477ad338fac049))
* **event-file-writer:** prevent collision and enforce maxFiles strictly ([a7227d6](https://github.com/Lateo2580/FlEq/commit/a7227d6f6b619fcd5a5ddfbf972aa143a5c5ff63))
* formatUptime の日部分を文字レベルで dim 表示する ([67d5c70](https://github.com/Lateo2580/FlEq/commit/67d5c700a35d48b97de2c7534392ef33109af59c))
* **monitor:** drain EventFileWriter queue on shutdown ([6cd0fc2](https://github.com/Lateo2580/FlEq/commit/6cd0fc2836e51c43218202ea51257a18cdb8056b))
* processMessage の EEW suppressed 結果ハンドリングを追加 ([3b5f48f](https://github.com/Lateo2580/FlEq/commit/3b5f48f72e627ee0e68372e892959c623bab174b))
* **sound:** Codex レビュー 2 の指摘を反映 ([3d3fdf1](https://github.com/Lateo2580/FlEq/commit/3d3fdf185a51c43d6519c7fb083a415ffa184249))
* **sound:** DoneHandle 化で launch 経路の log/bell も二重完了ガードで保護 ([cc5fd1c](https://github.com/Lateo2580/FlEq/commit/cc5fd1c126a38c39585250dd15831f436b2a02b7))
* **sound:** runPlay の timeout と execFile コールバックによる二重完了を防止 ([b0456dc](https://github.com/Lateo2580/FlEq/commit/b0456dc8f78ea1b7e6d6f62bcc8e4a007fb90aae))
* VXSE61 の複数 Coordinate ノードから十進度を正しく抽出 ([bdcfb38](https://github.com/Lateo2580/FlEq/commit/bdcfb383f0d34694714fa81da38cee875529e424))
* 起動メッセージをcommands案内に更新、+マーカーの位置と凡例を改善 ([f13fabd](https://github.com/Lateo2580/FlEq/commit/f13fabd7c688ef9da5b171787de51e5aa80d2c00))
* 抑制報の hasWarningIssued 更新と終端処理を修正 (Codex レビュー指摘) ([34676ba](https://github.com/Lateo2580/FlEq/commit/34676ba8a5c0d434de387a13b7349740abaaeafb))


### リファクタリング

* codex-design スキルを対立的レビュー方式に刷新 ([6db5a6d](https://github.com/Lateo2580/FlEq/commit/6db5a6d6dd17ca8bcdf0192064458dc866f92752))
* EewTracker を byType Map ベースに再設計 ([79a606f](https://github.com/Lateo2580/FlEq/commit/79a606fbcb80fe2b15ee5887529140ec9c311f56))
* **policy:** dmdata.jp 再配信ポリシー対応の段階2 ([cf5c6fb](https://github.com/Lateo2580/FlEq/commit/cf5c6fbe047953ce256827e18ce5a62d74186096))


### ドキュメント

* EEW再設計に伴う仕様書同期 (5ファイル) ([a4f4b4a](https://github.com/Lateo2580/FlEq/commit/a4f4b4ad15f2c764599078884e50a427f678aa08))
* uptime モードの Tip・仕様書を同期 ([6b77ae5](https://github.com/Lateo2580/FlEq/commit/6b77ae57298584e7978bdae40cc3c2b86e4ae084))
* 待機中Tipsを現行機能に同期 (21件追加, 1件修正) ([078e070](https://github.com/Lateo2580/FlEq/commit/078e0708b76e2a89246dac67a2242cd3387558ea))

## [1.51.0](https://github.com/Lateo2580/FlEq/compare/v1.50.1...v1.51.0) (2026-03-29)


### 機能追加

* **compact:** add width-adaptive summary line display (Phase 3) ([2a747ef](https://github.com/Lateo2580/FlEq/commit/2a747efc12379c72c458a2767e328a83096ed3b4))
* **diff/focus:** add PresentationDiffStore and focus mode (Phase 4) ([00f7cb3](https://github.com/Lateo2580/FlEq/commit/00f7cb3d65558f92bd34b1bc6e0e73374fe0b5d2))
* distribute waiting tips across categories with epoch-deck shuffler ([fd87c84](https://github.com/Lateo2580/FlEq/commit/fd87c84b99c0fb83dec47f3205f1d3a0c70213da))
* **filter/template:** add --filter and --template with REPL support (Phase 2) ([7acad77](https://github.com/Lateo2580/FlEq/commit/7acad777e11cdb0955fba97a8c64d250db40d1d8))
* **integration:** volcano pipeline + final fixes + documentation ([a2ffae1](https://github.com/Lateo2580/FlEq/commit/a2ffae139eb0893406a0128e04542c3ec0d7e205))
* **minimap:** add 47-prefecture area-to-pref mapping ([1b0a58a](https://github.com/Lateo2580/FlEq/commit/1b0a58a8926097965dd19d1e559d73cd07fbe6e0))
* **minimap:** add 47-prefecture grid layout ([eab5f1b](https://github.com/Lateo2580/FlEq/commit/eab5f1b4376bad7bb1b6a31661f3b18dada5f819))
* **minimap:** add ASCII minimap with 12-block Japan layout (Phase 7) ([195f404](https://github.com/Lateo2580/FlEq/commit/195f404c3fd2b33a2e0aafa9396d45c035a2939b))
* **minimap:** rewrite renderer for 47-prefecture grid layout ([70d0e95](https://github.com/Lateo2580/FlEq/commit/70d0e95d26cbccb476f73531f510a73ae334f368))
* **night:** add night mode as theme overlay (Phase 6) ([b206b22](https://github.com/Lateo2580/FlEq/commit/b206b22000666bff18b6ed65aa29352e1bda6434))
* **presentation:** add PresentationEvent common layer (Phase 1) ([7afdea5](https://github.com/Lateo2580/FlEq/commit/7afdea57960c192996fa10b83fd448a91f8ef87c))
* **rest:** REST API に指数バックオフ付きリトライ機構を追加 ([3837964](https://github.com/Lateo2580/FlEq/commit/3837964545b064b7ad856d95e5bb3185dc77a586))
* **site:** add CSS with light/dark theme and navbar/hero styles ([6213fd3](https://github.com/Lateo2580/FlEq/commit/6213fd3dcaa8314f854c31e421372d24b2113e1a))
* **site:** add dark mode toggle, copy button, smooth scroll ([2fdde07](https://github.com/Lateo2580/FlEq/commit/2fdde0784805e70ca26b88fbfaa367d80bc42625))
* **site:** add features section with responsive grid ([add41eb](https://github.com/Lateo2580/FlEq/commit/add41ebf6fa0db46e58a2aa40bb82eb8f0930c33))
* **site:** add footer with links and attribution ([24e055f](https://github.com/Lateo2580/FlEq/commit/24e055faeaba03ed5c9fe92100a658586115b01a))
* **site:** add HTML skeleton with navbar and hero section ([0de85af](https://github.com/Lateo2580/FlEq/commit/0de85afa569daf9aa9fa471e0f5bf2af9bf72fa5))
* **site:** add install section with steps, prerequisites, and OS table ([4f2db43](https://github.com/Lateo2580/FlEq/commit/4f2db4327f4c0fdfd010eab1db699f066f7d4807))
* **site:** add screenshot section with terminal mockup ([a65b381](https://github.com/Lateo2580/FlEq/commit/a65b381e8a4bb7f973a0a9af34c682cef89871f4))
* **site:** add supported categories section ([af495e3](https://github.com/Lateo2580/FlEq/commit/af495e3df7010d9c8ea5321fa07b7e69163716f4))
* **site:** finalize responsive breakpoints ([202adc2](https://github.com/Lateo2580/FlEq/commit/202adc230bc1c98c45d2c792dee0eefd7aac4eae))
* **site:** overhaul output preview with tabbed terminal and update content ([94d5354](https://github.com/Lateo2580/FlEq/commit/94d5354bba04970886492a1a15defa68b79575a4))
* **stats:** add telegram statistics display (Phase 0) ([9d29b82](https://github.com/Lateo2580/FlEq/commit/9d29b821014e8904bf4979c5da821898fd08a7fd))
* **summary:** add periodic summary with sparkline (Phase 5) ([fc4879c](https://github.com/Lateo2580/FlEq/commit/fc4879c359f4ff8368a05e01490644451f2ae682))
* **ui:** add renderGroupedItemList helper for compact area display ([06afba3](https://github.com/Lateo2580/FlEq/commit/06afba3fdb2a70fa3543c8197fab7520f2246144))


### バグ修正

* **config:** summaryInterval のバリデーションを追加し窓幅を統一 ([0fccdb8](https://github.com/Lateo2580/FlEq/commit/0fccdb838e3b2ea6b34d82adc8e0dc24b36dfdc9))
* **diff-store:** previous Map に TTL/クリーンアップを追加しメモリ蓄積を防止 ([7b9434a](https://github.com/Lateo2580/FlEq/commit/7b9434a5c502413cd8913db5571586b7ac5edfdd))
* **filter,template:** ReDoS 対策・実行時 try-catch・パーサ再帰深度制限を追加 ([05d9a6f](https://github.com/Lateo2580/FlEq/commit/05d9a6f545ab1df826c9a9b02aada05a32fbdd24))
* info-handlers.ts に NotifyCategory の import を追加 ([5ab9df0](https://github.com/Lateo2580/FlEq/commit/5ab9df0d9d20e1aaae70aa8caf4d533420339f17))
* **monitor:** シャットダウン時に要約タイマーを停止 ([24099b1](https://github.com/Lateo2580/FlEq/commit/24099b1ad024fe30204a016b2a499eb3a510b48e))
* **router:** volcanoMsgCache に TTL を追加し残留エントリを防止 ([db4c683](https://github.com/Lateo2580/FlEq/commit/db4c683bdea28e468aedad28e3a88822da4305b4))
* **site:** address code review findings ([28dda04](https://github.com/Lateo2580/FlEq/commit/28dda04158e898255591b2343a03bbb492c32e76))
* **site:** fix CSS dark mode fallback for no-JS scenarios ([59e3ba1](https://github.com/Lateo2580/FlEq/commit/59e3ba1b8f69263449eed55ddade9b381d137cf8))
* **sound:** Windows カスタム通知音が再生されないバグを修正 ([69486a8](https://github.com/Lateo2580/FlEq/commit/69486a8c4276080917ea95f2896ff3b9e8d837a8))
* **telegram-stats:** eewEventIds/earthquakeMaxIntByEvent にサイズ上限を追加 ([7c6ff34](https://github.com/Lateo2580/FlEq/commit/7c6ff34fd7f9474bf8e912163819b6be4dd215a6))
* **ui:** summary/minimap の PresentationEvent フィールド参照を修正 ([b85e8c1](https://github.com/Lateo2580/FlEq/commit/b85e8c1e0e0b8a9b25b2049fdd687cac70cf8b8e))
* **ws:** 孤立ソケット防止のため doConnect に多層世代チェックを追加 ([f671708](https://github.com/Lateo2580/FlEq/commit/f67170815b0d712a78aac6d6225801dddf635162))
* セキュリティ・互換性の修正8件 ([ad557be](https://github.com/Lateo2580/FlEq/commit/ad557bed33136e5adb9c5d8d6f0b3db94e784df9))


### パフォーマンス改善

* **filter:** 正規表現パターンをコンパイル時にキャッシュ ([545c725](https://github.com/Lateo2580/FlEq/commit/545c725ef3f13f07a2b70aaed512a1358e7fa438))
* **notifier:** resolveIconPath の結果をキャッシュ ([6e104c9](https://github.com/Lateo2580/FlEq/commit/6e104c933c88b99a3a3a4321516f71d2a99c218f))
* **sound:** 音声再生を有界キューで直列化しタイムアウトを追加 ([675748b](https://github.com/Lateo2580/FlEq/commit/675748ba5e3cc2eb2257c18a708840a59fa1e4ff))


### リファクタリング

* apply Claude Code best practices — rules, commands, hooks, slim CLAUDE.md ([9fda668](https://github.com/Lateo2580/FlEq/commit/9fda66837cd107797944e00cc329eabbe8b03ac7))
* **eew:** use renderGroupedItemList for compact forecast area display ([eb6ef92](https://github.com/Lateo2580/FlEq/commit/eb6ef9234c1a9cc3a5ef6d9ca56770202288e52c))
* FrameLevel を ui/formatter から types.ts に移動 ([beb7893](https://github.com/Lateo2580/FlEq/commit/beb789352cef9577382ec9402a024046e4d1babc))
* **minimap:** remove old block-mapping, update exports for v2 ([b75392a](https://github.com/Lateo2580/FlEq/commit/b75392a39a6d5c2f728459a59e184350e814addb))
* **minimap:** replace BlockId with PrefId (47 prefectures) ([118a3ad](https://github.com/Lateo2580/FlEq/commit/118a3ad952d96c3793625c9590f455c97f7af4dd))
* **parser:** 6つのparse関数の共通前処理を extractBaseReport に集約 ([8eed90f](https://github.com/Lateo2580/FlEq/commit/8eed90fc946f85820d9ba35104f24897417ee1e8))
* **repl:** repl.ts を大規模リファクタリング (2,500行→310行) ([abf8253](https://github.com/Lateo2580/FlEq/commit/abf825351ad2ad184ee03b3130b5d147536a6092))
* **router:** 表示パイプラインを runDisplayPipeline に共通化 ([08b7a84](https://github.com/Lateo2580/FlEq/commit/08b7a84712f4b2834e7b8b3bf571a0b1fd4a2e4f))
* **ui:** CJK文字幅判定の重複を isWideChar ヘルパーに統合 ([3ad362a](https://github.com/Lateo2580/FlEq/commit/3ad362a2544774593bd2007e2a16cfd765091c16))
* **ui:** use renderGroupedItemList for compact long-period area display ([44577f6](https://github.com/Lateo2580/FlEq/commit/44577f6f7b13506ce742433f50273ceb03f0a491))
* **volcano:** use renderSimpleNameList, remove municipality truncation ([6b9a8d6](https://github.com/Lateo2580/FlEq/commit/6b9a8d6b91d89885d3bd61b5420fba3201f8abf4))
* **ws:** close/error ハンドラの重複処理を onDisconnect に統合 ([fc84374](https://github.com/Lateo2580/FlEq/commit/fc84374d90f0acf5d9a80423f7e522bc11694c0c))
* アーキテクチャリファクタリング3件 (W8/W7/C2) ([724c2a0](https://github.com/Lateo2580/FlEq/commit/724c2a0b6f4a85cb570e66d4ea621a575eeb3085))
* 未使用フィールドの削除 ([16e9e12](https://github.com/Lateo2580/FlEq/commit/16e9e1262444c6c42eb759e806af1838d2acbca9))


### ドキュメント

* add Claude Harness policy and hook configuration ([91f5b54](https://github.com/Lateo2580/FlEq/commit/91f5b54d4912d3a7a0172f7e9864137a62cd99fc))
* add landing page design spec ([b1acb2b](https://github.com/Lateo2580/FlEq/commit/b1acb2b9ec0476b9621f17f4d64765609903a7a8))
* add landing page implementation plan ([8afda8a](https://github.com/Lateo2580/FlEq/commit/8afda8af92ef6ba3ad712d65152b67f6895d65f4))
* Codexレビューのフィードバックを設計・プランに反映 ([1f1c71b](https://github.com/Lateo2580/FlEq/commit/1f1c71baa56b2ea6d96cd3ee1eb03d81450e7f0c))
* **engine:** engine.md の critical 乖離10件を修正 ([36a598e](https://github.com/Lateo2580/FlEq/commit/36a598e68ff2f57147b1179493109b0836f6fecd)), closes [#3](https://github.com/Lateo2580/FlEq/issues/3)
* fix GitHub Pages deployment method in landing page spec ([26df90a](https://github.com/Lateo2580/FlEq/commit/26df90a804c9fb1a423164cc459a5395fc7a51fc))
* **minimap:** add implementation plan and fix spec overlaps ([57b5414](https://github.com/Lateo2580/FlEq/commit/57b541434f45cd0519529494349657668cdc5599))
* **minimap:** add v2 design spec for prefecture-level ASCII minimap ([20b47d0](https://github.com/Lateo2580/FlEq/commit/20b47d0a7c0835f5fb6c609df4e5ba2ea0f45b74))
* remove hamburger menu from landing page spec ([756132a](https://github.com/Lateo2580/FlEq/commit/756132abf323a420512b3ea075dab860b146175f))
* root.md/dmdata.md/display-reference.md の critical 乖離を修正 ([b39fbad](https://github.com/Lateo2580/FlEq/commit/b39fbad9f49951c7696f85c21c082a0eff9215b7))
* **site:** 対応区分・機能説明を実装と同期 ([4b83a79](https://github.com/Lateo2580/FlEq/commit/4b83a7988e5d10279bae64bfe26805f0bd1cc96a))
* **specs:** add telegram statistics feature design ([39916a4](https://github.com/Lateo2580/FlEq/commit/39916a42a549694d7a248776f90bb3650f234bbe))
* **specs:** address Codex review feedback on telegram statistics spec ([5f22851](https://github.com/Lateo2580/FlEq/commit/5f22851500fd2c9c1e7cd19c322fd2c6f3c51b5c))
* summary コマンドの help 一覧に間隔設定可能な旨を追記 ([e55c769](https://github.com/Lateo2580/FlEq/commit/e55c76920a3ed7d5ee72d02b4dbedfcba9e327f8))
* **ui:** add JSDoc note about renderSimpleNameList label styling ([5e74594](https://github.com/Lateo2580/FlEq/commit/5e745943e514960f9d398e834664d045e0476a55))
* **ui:** ui.md の critical 乖離5件を修正 ([d0e336e](https://github.com/Lateo2580/FlEq/commit/d0e336e28ea6dbbf27339a9e38f4accdab9fcb24))
* ヘルスチェックで検出されたドキュメント乖離31件を解消 ([f428dc7](https://github.com/Lateo2580/FlEq/commit/f428dc7124add03c32d1cff723af5451e45ab952))
* 総合ヘルスチェック実装プランを追加 ([5767864](https://github.com/Lateo2580/FlEq/commit/5767864ad7bbc75e131315a729b423994adaeb92))
* 総合ヘルスチェック設計を追加 ([da35d32](https://github.com/Lateo2580/FlEq/commit/da35d32451c8fd9b5b9010395ba0d6039a93f01d))

## [1.50.1](https://github.com/Lateo2580/FlEq/compare/v1.50.0...v1.50.1) (2026-03-23)


### ドキュメント

* add JMA data attribution to README ([13c664a](https://github.com/Lateo2580/FlEq/commit/13c664a81ee4d4b0213ba98d870ae860ca777660))

## [1.50.0](https://github.com/Lateo2580/FlEq/compare/v1.49.8...v1.50.0) (2026-03-22)


### 機能追加

* add Material Symbols notification icons for all categories ([034ec40](https://github.com/Lateo2580/FlEq/commit/034ec40bb11b5937ec3b12b219b99b6c74515b4b))
* add resolveIconPath with 3-step fallback ([015f175](https://github.com/Lateo2580/FlEq/commit/015f1755fa4a95a45667ffa253c2d456d830ed57))
* pass category to send() and update all 15 call sites ([9aba49e](https://github.com/Lateo2580/FlEq/commit/9aba49e078f979fc2d2064039932da1749e1da00))
* per-category notification icons with 3-step fallback ([5695d1a](https://github.com/Lateo2580/FlEq/commit/5695d1ab418fdaf2ca42e59c05ab250ba2622a7e))


### バグ修正

* align waiting tip timing with prompt elapsed clock ([7b7566c](https://github.com/Lateo2580/FlEq/commit/7b7566c9bd2e89d360be6b145e9329c7bda4c2d5))


### ドキュメント

* add notification icons implementation plan ([e95e2be](https://github.com/Lateo2580/FlEq/commit/e95e2be2ec8d9af015dea8a34134d66d296b0dda))
* add notification icons per category & level design spec ([fc17b13](https://github.com/Lateo2580/FlEq/commit/fc17b13df790069620cddc7329a5089912e06450))
* add review policy and superpowers archive rule to CLAUDE.md ([8039a58](https://github.com/Lateo2580/FlEq/commit/8039a58f57ab3909bf113a14272aebce08e01974))
* address spec review feedback — export resolveIconPath, add call site table, clarify icon matrix ([6a5c9e7](https://github.com/Lateo2580/FlEq/commit/6a5c9e7c702fb0dfd55b053c7d5fa79180c5a25e))
* fix stale call site count (9 → 15) ([aca503e](https://github.com/Lateo2580/FlEq/commit/aca503e85a6725636bd82be24084458a755eecf4))
* overhaul waiting tips for commands and system mechanics ([e2dd76d](https://github.com/Lateo2580/FlEq/commit/e2dd76db822a6629ef9f1f2f7e184b39aa778965))
* README.md を全面改稿 — ユーザー導線の整理・正確性向上 ([a6ca946](https://github.com/Lateo2580/FlEq/commit/a6ca946bd1a57828b1dec10f47e61d16e4704ebc))
* streamline CLAUDE.md with concise architecture map and routing table ([1d01f45](https://github.com/Lateo2580/FlEq/commit/1d01f4573391c5e7ba60f52f8c4168f2526c1b2b))
* update release flow to batched release policy ([cebe8ed](https://github.com/Lateo2580/FlEq/commit/cebe8ed65a033e095893b37200cc2921f3079f9c))

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
