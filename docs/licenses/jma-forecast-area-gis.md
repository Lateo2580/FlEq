# 気象庁「予報区等 GIS データ」

出典: 気象庁「予報区等 GIS データ」を加工して作成

- 取得元: https://www.data.jma.go.jp/developer/gis.html
- 取得日: 2026-07-30
- 利用条件: [気象庁ホームページ利用規約](https://www.jma.go.jp/jma/kishou/info/coment.html)（政府標準利用規約に準拠）
- 対象データ:
  - `AreaForecastLocalE`（2024-05-20版）
  - `AreaInformationCity_quake`（2024-11-28版）
- 加工内容: mapshaper 0.7.49による `simplify 0.1%`、`keep-shapes`、`clean`（`name` は空code allowlist検証時だけ保持し、生成物はcode別pathのみ）、d3-geo 3.1.1による固定投影、沖縄・先島・小笠原等のbuild-time inset配置、コード別SVG pathへの集約
- 座標系: JGD2011（EPSG:6668）
- 投影・inset設定: `jma-quake-projection-insets-v1`

入力archiveには `.prj` が含まれていないため、変換処理はlockされたJGD2011宣言と経緯度boundsを検証してから投影する。

上流配布物が消失し、同一SHA-256のarchiveを正規配布元から取得できない場合は再生成不能となる。その場合、コミット済みの変換済みJSONを表示・配布上の真実源として維持する。
