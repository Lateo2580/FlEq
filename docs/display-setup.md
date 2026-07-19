# 情報ディスプレイ セットアップガイド

> npm パッケージにはビルド済みのフロントエンド (`display/dist`) が同梱されており、インストール後そのまま `--display` を利用できます。リポジトリを clone して使う場合のみ、以下の手順で `display/dist` のビルド・配置が必要です。

FlEq 本体プロセスに内蔵されたブラウザ表示サーバです。地震・津波・気象警報の現況を SSE (Server-Sent Events) でブラウザに配信し、Raspberry Pi 500 + モニタ等での常設表示画面として使えます。

## ① 有効化

CLI オプション:

```bash
fleq --display
```

または config で恒常的に有効化:

```bash
fleq config set display true
```

デフォルトではポート `7788`、バインド先 `127.0.0.1` (ローカルのみ) で起動します。起動に成功すると次のログが出ます。

```
情報ディスプレイ: http://127.0.0.1:7788/
```

ブラウザで上記 URL を開くと表示画面が見られます。

ポート・バインド先は CLI オプションまたは config で変更できます。

| 項目 | CLI オプション | config キー | デフォルト |
|------|----------------|-------------|-----------|
| 有効化 | `--display` | `display` (`true`/`false`) | `false` |
| ポート | `--display-port <port>` | `displayPort` (1〜65535) | `7788` |
| バインド先 | `--display-bind <host>` | `displayHost` | `127.0.0.1` |
| アクセストークン | `--display-token <token>` | `displayToken` | 非 loopback バインド時に自動生成 |

```bash
fleq --display --display-port 8080 --display-bind 0.0.0.0
# または
fleq config set displayPort 8080
fleq config set displayHost 0.0.0.0
```

CLI オプションと config の優先順位は他の設定と同じで、CLI オプション > config > デフォルト値です。

`--display-port` に無効な値 (数値でない、または 1〜65535 の範囲外) を渡すと警告ログを出して無視され、config またはデフォルトの値が使われます。

transport の起動に失敗した場合 (後述の dist 欠落・ポート衝突など) は警告ログを出した上で **本体 (電文受信・表示) は継続します**。情報ディスプレイだけが無効化された状態で動き続けます。

## ② LAN 公開時の注意 (`--display-bind 0.0.0.0`)

`--display-bind` に `127.0.0.1` 以外を指定すると、起動時に以下の警告ログが出ます。

```
display server を 0.0.0.0 に公開バインドします
```

非 loopback バインド時は、表示画面 (`/`) と `/events` (SSE) への非 loopback からの接続に**アクセストークンが必須**になります (loopback からの接続、たとえば同一マシン上のキオスクブラウザは免除)。トークンは `displayToken` config または `--display-token` で固定でき、未設定の場合は起動ごとに自動生成されて起動ログに URL 付きで表示されます。

```bash
fleq config set displayToken <任意の秘密文字列>
# 閲覧側 URL: http://<host>:7788/?token=<displayToken>
```

トークンは URL のクエリで渡るため、履歴やログに残り得る簡易認証です。これに加えて**素の LAN 公開は避け、Tailscale 等の VPN 経由でのみ到達可能にすることを推奨します。**

推奨構成:

1. Raspberry Pi 500 と閲覧側デバイス (Windows PC 等) の両方に [Tailscale](https://tailscale.com/) を導入し、同じ tailnet に参加させる
2. Raspberry Pi 500 では `fleq --display --display-bind 0.0.0.0` のように全インターフェースにバインドしつつ、`ufw` で LAN 側インターフェース (`eth0` / `wlan0`) からの display ポート宛アクセスを拒否し、Tailscale インターフェース (`tailscale0`) からのみ許可する

```bash
# Tailscale インターフェース経由のみ許可する例 (ポートはデフォルト 7788 の場合)
sudo ufw allow in on tailscale0 to any port 7788
sudo ufw deny in on eth0 to any port 7788
sudo ufw deny in on wlan0 to any port 7788
```

3. 閲覧側は Raspberry Pi 500 の Tailscale IP (`tailscale ip -4` で確認可能) に対してアクセスする

`ufw` 自体が未導入・未設定の環境ではこの手順の前に `sudo apt install ufw && sudo ufw enable` 等で有効化しておくこと。

## ③ Raspberry Pi 500 への `display/dist` 配置

`display/` はフロントエンド (Svelte + Vite) の別 `node_modules` を持つサブパッケージで、ビルド成果物 `display/dist/` は `.gitignore` 対象のため **`git pull` だけでは配置されません**。以下のいずれかの経路で配置してください。

### 第一候補: 開発機でビルド + `scp` で同期

Windows (開発機) 側:

```bash
npm run display:build
```

`display/dist/` が生成されるので、Raspberry Pi 500 へ `scp` で dist だけを同期します。

```bash
scp -r display/dist <raspi-user>@<raspi-host>:~/dev/FlEq/display/
```

Raspberry Pi 500 側の `~/dev/FlEq/display/` 配下に `dist/` が置かれれば、次回 `fleq --display` 起動時にそのまま読み込まれます。本体側 (`src/`) のビルド成果物 (`dist/`) とは別物です。FlEq 本体だけを更新する場合は、フロントエンドに変更がなければ `display/dist` の再同期は不要です。

### 代替: Raspberry Pi 500 上で直接ビルド

```bash
cd ~/dev/FlEq
npm --prefix display install
npm run display:build
```

> **注意:** `npm --prefix display install` は初回、Raspberry Pi 500 のような非力な環境では数分〜かかることがあります。メモリ不足でプロセスが落ちる場合は swap (または zram) を有効化してから実行してください ([Raspberry Pi 500 セットアップガイド](raspi500-setup-guide.md) の「microSD 書き込み削減」節を参照)。

### Chromium キオスク起動

Raspberry Pi OS Desktop 環境で、以下のコマンドでブラウザをキオスクモード (全画面・UI 非表示) で起動できます。

```bash
chromium-browser --kiosk --noerrdialogs --disable-session-crashed-bubble http://127.0.0.1:7788
```

### スクリーンブランキング (画面消灯) の無効化

`raspi-config` から:

```bash
sudo raspi-config
# → 2 Display Options → Screen Blanking → No
```

Wayland (Raspberry Pi OS Bookworm 以降のデフォルト) では `raspi-config` の設定が効かない場合があります。その場合は `wlr-randr` や compositor 側の DPMS/idle 設定 (`wayfire.ini` の `[idle]` セクションなど、使用しているコンポジタのドキュメントを参照) で無効化してください。

### 自動起動 (autostart)

`~/.config/autostart/fleq-display.desktop` を作成:

```ini
[Desktop Entry]
Type=Application
Name=FlEq Display
Exec=chromium-browser --kiosk --noerrdialogs --disable-session-crashed-bubble http://127.0.0.1:7788
X-GNOME-Autostart-enabled=true
```

FlEq 本体 (`fleq --display`) 自体の自動起動は [Raspberry Pi 500 セットアップガイド](raspi500-setup-guide.md) の tmux + crontab `@reboot` 手順を参照してください。ブラウザの起動は本体プロセスの起動より遅らせる (`sleep` を挟む等) ことを推奨します。表示サーバがまだ立ち上がっていない状態でブラウザが先に開くと、初回アクセス時にページが読み込めない場合があります。

## ④ Windows 側でブラウザ小窓表示

Raspberry Pi 500 と同じ tailnet に参加した Windows PC から、Tailscale IP を指定してブラウザでアクセスします。

```
http://<raspi の tailscale IP>:7788
```

Tailscale IP は Raspberry Pi 500 側で `tailscale ip -4` を実行するか、[Tailscale 管理コンソール](https://login.tailscale.com/admin/machines) から確認できます。

Chrome / Edge であれば、ウィンドウメニューの「その他のツール → ショートカットを作成」でアプリウィンドウとして固定できます（アドレスバー等が非表示の小窓になります）。

## ⑤ 画面の操作 (減光トグル)

- 画面の何もない場所をクリック、またはキーボードの **D キー**で夜間減光をトグルできます
- ボタン類 (ページドット・津波チップ・地震履歴の行) の上のクリックは減光に影響しません
- 警報級の情報がテロップに載っている間は、減光中でも自動で明るくなります (収まると減光に戻ります)

## ⑥ トラブルシューティング

**dist 欠落エラー**

起動ログに以下の警告が出る場合:

```
情報ディスプレイサーバの起動に失敗しました: display/dist が見つかりません。`npm --prefix display run build` を実行してください (本体は継続します)
```

`display/dist/index.html` が存在しない状態で `--display` を起動しています。③ の手順で `display/dist` を配置してください。本体の電文受信・表示自体は継続して動作します。

**ブラウザを開いても真っ白 / 何も表示されない**
- URL のポート番号が起動ログの `情報ディスプレイ: http://...` と一致しているか確認する
- REPL で `display` コマンドを実行し、`稼働中` と表示されるか、接続クライアント数が増えているか確認する
- `curl http://127.0.0.1:7788/healthz` で `{"ok":true,"clients":N}` (200) が返るか確認する（接続不可なら表示サーバ自体が起動していない。`/healthz` はクライアント数に関わらず常に 200 を返すので、接続数上限の確認には使えない — 下記「SSE 接続が 503 になる」を参照）

**REPL の `display` コマンド**

| コマンド | 動作 |
|----------|------|
| `display` | 稼働状況・ポート・接続クライアント数を表示 |
| `display on` | 表示サーバを起動 (`--display` 未指定で起動した場合や、停止後の再開に使う) |
| `display off` | 表示サーバを停止 (再開は `display on`) |

`--display` 未指定で起動した場合や、`display off` で停止した後は `display` を実行すると「情報ディスプレイは停止中です」と表示されます。この状態から `display on` で起動できます (FlEq 本体の再起動は不要)。

**SSE (`/events`) 接続が 503 になる (接続数上限)**
SSE 接続数の上限 (8 クライアント) に達しています。使っていないブラウザタブ・端末からの接続を閉じてください。`/healthz` はこの上限とは無関係に常に 200 を返すため、上限到達の確認には使えません。

**`npm run display:build` が `Cannot find package '@sveltejs/vite-plugin-svelte'` で失敗する**
`display/` サブパッケージの `node_modules` が未インストールです (`display/` は本体とは別の `package.json` / `node_modules` を持ちます)。ルートの `npm install` とは別に、初回のみ以下を実行してください。

```bash
npm --prefix display install
```

その後 `npm run display:build` が通ります (③ の代替手順を参照)。

**Raspberry Pi 上でのビルドが途中で落ちる (メモリ不足)**
③ の代替手順の注意書きの通り、swap または zram を有効化してから再実行してください。
