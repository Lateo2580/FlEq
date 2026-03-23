# Raspberry Pi 500 で FlEq を常時稼働させるセットアップガイド

作成日: 2026-03-13

## 前提

- Raspberry Pi 500
- microSD カード + カードリーダー
- dmdata.jp API キー
- GitHub プライベートリポジトリに FlEq のソースコードがある

---

## 1. OS インストール

### Raspberry Pi Imager での書き込み

1. PC で **Raspberry Pi Imager** を起動
2. デバイス: **Raspberry Pi 500** を選択
3. OS: **Raspberry Pi OS (64-bit)** を選択
   - ⚠️ 32bit を選ぶと Node.js のインストールで armhf 非対応エラーになるため、必ず 64-bit を確認すること
4. ストレージ: microSD を選択
5. 「設定を編集する」で以下を事前設定:
   - ホスト名 (任意)
   - ユーザー名・パスワード
   - Wi-Fi (有線接続なら不要)
   - SSH を有効にする
   - タイムゾーン: `Asia/Tokyo`、キーボード: `jp`
6. 書き込み開始 → 完了まで待つ

### 起動と確認

1. microSD を Pi 500 に差し込み、電源を入れる
2. ターミナルで 64bit を確認:
   ```bash
   uname -m
   # → aarch64 と表示されれば OK
   ```

---

## 2. 日本語化

```bash
# 日本語ロケール生成
sudo dpkg-reconfigure locales
# → ja_JP.UTF-8 UTF-8 にチェック → デフォルトに ja_JP.UTF-8 を選択

# タイムゾーン設定
sudo timedatectl set-timezone Asia/Tokyo

# 日本語フォント (Desktop 版で文字化け防止)
sudo apt-get install -y fonts-noto-cjk

# 再起動して反映
sudo reboot
```

---

## 3. Node.js 22 インストール

```bash
# NodeSource リポジトリ追加 & インストール
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs

# 確認
node -v   # → v22.x.x
npm -v
```

> **注意**: `apt install nodejs` (OS標準リポジトリ) では古いバージョンが入るため、必ず NodeSource を使う。

---

## 4. FlEq クローン & ビルド

### GitHub 認証 (プライベートリポジトリの場合)

```bash
# GitHub CLI インストール & ログイン
sudo apt-get install -y gh
gh auth login
# → GitHub.com → HTTPS → Login with a web browser を選択
# → 表示されるコードを PC/スマホで github.com/login/device に入力
```

### クローン & ビルド

```bash
git clone https://github.com/<ユーザー名>/<リポジトリ名>.git ~/fleq
cd ~/fleq
npm install
npm run build
```

### 初期設定

```bash
npx fleq init
# → API キー入力、受信区分の選択
```

### グローバルコマンド登録

```bash
cd ~/fleq
sudo npm link
# → fleq コマンドがどこからでも使えるようになる
```

---

## 5. tmux で常時稼働

systemd サービスとして登録する方法もあるが、FlEq の REPL は TTY (ターミナル) がないと stdin が即座に EOF を出して終了してしまう。tmux を使えば色付き表示を維持しつつバックグラウンドで常時稼働できる。

### tmux インストール & 起動

```bash
sudo apt-get install -y tmux

# tmux セッションで FlEq を起動
tmux new -s fleq 'fleq'
```

### 基本操作

| 操作 | やりかた |
|------|---------|
| 画面から離れる (裏で動き続ける) | `Ctrl+B` → `D` |
| 戻って画面を見る | `tmux attach -t fleq` |
| SSH を切断しても | 動き続ける |

### 再起動時の自動起動

```bash
crontab -e
```

最後の行に追加:

```
@reboot sleep 15 && tmux new-session -d -s fleq 'cd ~/fleq && fleq'
```

> `sleep 15` はネットワークが安定するのを待つため。これがないと起動直後に DNS 解決エラー (`EAI_AGAIN`) が発生する場合がある (自動再接続で復旧はする)。

---

## 6. 便利コマンドの登録

### シェルエイリアス (bashrc)

```bash
echo "alias fq='tmux attach -t fleq'" >> ~/.bashrc
echo "alias fqs='tmux has-session -t fleq 2>/dev/null && echo \"FlEq: 稼働中\" || echo \"FlEq: 停止\"'" >> ~/.bashrc
echo "alias fqr='tmux kill-session -t fleq 2>/dev/null; tmux new -s fleq \"fleq\"'" >> ~/.bashrc
source ~/.bashrc
```

### アップデートスクリプト (~/bin/fqu)

複雑なロジックはエイリアスだと引用符の問題が起きやすいため、スクリプトとして作成する。

```bash
mkdir -p ~/bin
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

```bash
cat > ~/bin/fqu << 'SCRIPT'
#!/bin/bash
cd ~/fleq || exit 1
git checkout -- package-lock.json 2>/dev/null
output=$(git pull 2>&1)
echo "$output"
if echo "$output" | grep -q "Already up to date"; then
  echo "latest. no restart needed."
else
  npm install
  npm run build
  tmux kill-session -t fleq 2>/dev/null
  tmux new -s fleq 'fleq'
fi
SCRIPT
chmod +x ~/bin/fqu
```

### コマンド一覧

| コマンド | 動作 |
|---------|------|
| `fq` | FlEq の画面に入る |
| `fqs` | 稼働状況を確認 |
| `fqr` | FlEq を再起動 |
| `fqu` | git pull → 変更あればビルド & 再起動、最新なら何もしない |

---

## 7. SSH 接続 (PC からリモート操作)

Pi 500 の IP アドレスを確認:

```bash
hostname -I
```

PC の PowerShell / Windows Terminal から:

```bash
ssh <ユーザー名>@<IPアドレス>
```

---

## 8. 運用時の便利コマンド

```bash
# ログをリアルタイムで見る (tmux 外から)
sudo journalctl -u fleq -f

# tmux セッション一覧
tmux ls
```

---

## 9. microSD 書き込み削減 (寿命対策)

Raspberry Pi は microSD カードにシステムを格納するため、常時稼働では書き込み回数による劣化が懸念される。以下の設定で不要な書き込みを削減できる。

### swap を zram に変更

デフォルトの dphys-swapfile は microSD 上にスワップファイルを作成するため、書き込みが頻発する。zram を使えばメモリ内で圧縮スワップを行い、microSD への書き込みを回避できる。

```bash
# dphys-swapfile を無効化・削除
sudo dphys-swapfile swapoff
sudo systemctl disable dphys-swapfile
sudo apt-get purge -y dphys-swapfile

# zram-tools インストール & 設定
sudo apt-get install -y zram-tools
sudo tee /etc/default/zramswap > /dev/null << 'EOF'
ALGO=zstd
PERCENT=50
EOF

# 反映
sudo systemctl restart zramswap

# 確認
swapon --show
# → /dev/zram0 が表示されれば OK
```

### /tmp を tmpfs 化

`/tmp` をメモリ上に配置し、一時ファイルの書き込みを microSD から排除する。

```bash
# /etc/fstab に追記
echo 'tmpfs /tmp tmpfs defaults,noatime,nosuid,nodev,size=256M 0 0' | sudo tee -a /etc/fstab

# 反映
sudo mount -a

# 確認
df -h /tmp
# → tmpfs と表示されれば OK
```

### systemd journal サイズ制限

ログの肥大化を防ぐ。

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/size-limit.conf > /dev/null << 'EOF'
[Journal]
SystemMaxUse=50M
SystemMaxFileSize=10M
EOF

sudo systemctl restart systemd-journald
```

> **見送った設定**: `/var/log` の tmpfs 化や journal の volatile 化は、障害発生時にログが残らなくなるため推奨しない。

---

## 10. 複数デバイスでの同時運用

Mac と Raspberry Pi のように、同一アカウントの複数デバイスで FlEq を同時に起動する場合は、追加の設定が必要。

### 問題の背景

dmdata.jp のアカウントには WebSocket の同時接続上限がある。FlEq は起動時に前回セッションの残留ソケットをクリーンアップするが、以下の条件が重なると他デバイスのソケットが切断される可能性がある:

1. **ソケットの識別**: 同一アカウントのソケットは API キーが異なっても一覧に表示されるため、`appName` が同じだと自他を区別できない
2. **サーバー側のタイミング**: ソケットの DELETE リクエスト後、サーバー側で反映されるまでにわずかな遅延がある。この間に新しいソケットを作成すると一時的に上限を超過し、サーバーが既存のソケットを強制切断することがある

### 設定手順

**デバイスごとに異なる `appName` を設定する:**

```bash
# Mac 側
fleq config set appName fleq-mac

# Raspberry Pi 側
fleq config set appName fleq-raspi
```

FlEq v1.31.2 以降、起動時のソケットクリーンアップは `appName` でフィルタリングされるため、異なる `appName` を設定すれば他デバイスのソケットを閉じない。また v1.31.5 以降、ソケット削除後にサーバー側の反映を確認してから新規ソケットを作成するため、同時接続上限の超過による強制切断も防止される。

### 確認方法

```bash
# 各デバイスで設定を確認
fleq config show

# 実行中に接続中のソケット一覧を表示 (REPL コマンド)
socket
```

---

## トラブルシューティング

### 32bit OS を入れてしまった

`uname -m` が `armv7l` と表示される場合は 32bit。Raspberry Pi Imager で 64-bit OS を書き直す。

### Node.js インストールで armhf エラー

64bit OS であることを確認 (`uname -m` → `aarch64`)。

### FlEq 起動直後に DNS エラー (`EAI_AGAIN`)

ネットワークが安定する前に起動した場合に発生。FlEq の自動再接続で復旧する。crontab の `sleep 15` で軽減可能。

### systemd で FlEq がすぐ終了する

FlEq の REPL は TTY がない環境で stdin が即 EOF になり `close` イベント → シャットダウンが発火する。tmux を使う方法で回避する。

### 他デバイスの再起動で自分のソケットが切断される

`appName` が同一の場合、他デバイスの起動時クリーンアップで自分のソケットが閉じられる。`fleq config set appName <固有の名前>` でデバイスごとに別名を設定する。v1.31.5 以降に更新されていることも確認する。

### tmux で `Ctrl+B` → `D` しても画面が変わらない

`Ctrl+B` を押した後、指を離してから `D` を押す (同時押しではない)。
