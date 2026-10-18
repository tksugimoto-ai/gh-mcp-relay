# gh-mcp-relay

AI 用の GitHub アカウント（`tksugimoto-ai`）で作業する Claude が、fork から本流（upstream）へ Issue や PR を出せるようにするための、GitHub MCP の薄い中継です。Cloudflare Workers で動きます。

## 何のためのものか

### やりたいこと

- Claude には AI 用アカウント `tksugimoto-ai` で作業させ、コードの変更は fork（`tksugimoto-ai/<repo>`）に push させる。
- Issue・PR・コメントは本流（`tksugimoto/<repo>` や org の repo）に、`tksugimoto-ai` の名前で出させる。
- Claude GitHub App は本流に入れない。入れると Claude が本流を直接触れるようになるため、fork にだけ入れる。

### なぜ中継が要るのか

Claude Code の cloud セッションには、次の制約があります。

- セッションから GitHub に届くのは、セッションに入っている repo（= fork）だけ。本流への API は 403 になる。
- fork と本流は同じ repo 名なので、1つのセッションに両方は入れられない。

そこで本流への操作は、claude.ai の **コネクタ**（MCP）経由で行います。独自の GitHub App を作って本流にだけ install し、そのユーザートークンで公式 GitHub MCP を呼べば、本流へ Issue・PR を出せます。

ただし、claude.ai のコネクタはアカウント単位で、どのセッションからも見えます。コネクタを1つ用意するだけだと、たとえば public の repo を扱うセッションから org の private repo にも届いてしまい、prompt injection で情報が漏れる経路になります。

この中継は、そこを **環境（cloud 環境やローカルのプロジェクト）ごと** に分けるためのものです。

- コネクタを環境ごとに、URL のパス（`/e/<パス名>/mcp`）で分けて登録する。
- 各パスは、その環境にだけ置いた key（環境変数 `UPSTREAM_KEY`）を持つセッションからしか使えない。
- 届く repo の範囲は、GitHub App の install 先で GitHub が強制する。中継は token を保存しない。

## 全体像

```
cloud 環境「pocket-ssh-agent」のセッション（UPSTREAM_KEY=k_xxx）
  │
  ├─ git push ───────────────► fork  tksugimoto-ai/pocket-ssh-agent   （Claude GitHub App）
  │
  └─ コネクタ「GitHub pocket」 ─► gh-mcp-relay  /e/pocket-ssh-agent/mcp
                                    │ ・token の持ち主が tksugimoto-ai か
                                    │ ・upstream_key が k_xxx か
                                    ▼
                                  公式 GitHub MCP ─► 本流 tksugimoto/pocket-ssh-agent
                                                    （独自 GitHub App を本流にだけ install）
```

## 使い方（Claude のセッションから）

準備（下記）が終わった環境では、Claude は次のように動きます。

1. コードを変更し、fork のブランチに `git push` する（通常どおり）。
2. コネクタ「GitHub pocket」の `create_pull_request` を、本流を `owner`/`repo` に、head を `tksugimoto-ai:<branch>` にして呼ぶ。
3. その際、すべてのツール呼び出しに引数 `upstream_key` を付ける。値はセットアップスクリプトが `~/.claude/CLAUDE.md` に書いておくので、Claude はそれを読んで渡す。

`upstream_key` は中継が確認したあと引数から消すので、GitHub には届きません。`tools/list` の結果にも中継が `upstream_key`（必須）を足すので、Claude は引数があることを自然に知ります。

## 中継が確認すること

| URL | 役割 |
| --- | --- |
| `/e/<パス名>/mcp` | MCP の受け口。確認が通れば、設定の `upstream`（公式 GitHub MCP）に転送する |
| `/.well-known/oauth-protected-resource/e/<パス名>/mcp` | 認可サーバーとして `https://github.com/login/oauth` を返す |

1. token がない、または無効なら `401` を返し、`WWW-Authenticate` でメタデータの場所を伝えます。Claude はこれを見て、GitHub で OAuth を行います。
2. token の持ち主を `https://api.github.com/user` で確かめ、`allowed_logins` にない人は拒否します（`403`）。
3. `tools/call` の引数 `upstream_key` のハッシュ値が、パスの `key_sha256` と一致するか確かめます。違えば転送せず、JSON-RPC のエラーを返します。
4. `tools/list` の結果には、各ツールに `upstream_key` 引数（必須）を足します。

中身を解析するのは 3 と 4 だけです。ほかはそのまま転送します。ログにはパス名・ツール名・結果だけを残し、token・ヘッダー・key は残しません。

## 準備

本流の repo を1つ足すたびに、次を行います。

### 1. GitHub App を作る

本流の所有者ごとに1つ作ります（例: 個人用、org 用）。所有者ごとに分けておくと、org の private repo と個人の public repo の境界を GitHub 側で守れます。

- 権限: Issues（Read & write）、Pull requests（Read & write）、Metadata（Read）
- Callback URL: claude.ai のコネクタ登録画面に表示される URL（`https://claude.ai/api/mcp/auth_callback` と思われる）。ローカルの Claude Code でも使うなら、その URL も足す
- 「Expire user authorization tokens」は ON のまま（Claude が refresh token で更新する）
- 本流にだけ install する（Only select repositories）

### 2. key を発行して中継をデプロイする

```bash
npm install
npm run new-key                                   # UPSTREAM_KEY と key_sha256 が出る
cp examples/paths.example.json paths.json         # key_sha256 などを書き換える
npx wrangler secret put PATHS_JSON < paths.json
npm run deploy
```

`paths.json` は `.gitignore` に入っています。repo には置きません。

### 3. claude.ai にコネクタを登録する

- URL: `https://<workers のホスト>/e/<パス名>/mcp`
- Advanced settings に、GitHub App の Client ID と Client secret を入れる
- `tksugimoto-ai` でログインした状態で認可する

### 4. cloud 環境を設定する

本流ごとに専用の環境を作り、key はその環境にだけ置きます。Default 環境には key を置かないので、新しい repo は何もしなければ本流に届きません。

- 環境変数: `UPSTREAM_KEY=<new-key で出た値>`
- セットアップスクリプト: `examples/setup-script.sh` を参考にする。`~/.claude/CLAUDE.md` に使い方と key を書き、ほかの環境用のコネクタを `deniedMcpServers` で見えなくする

### ローカルの Claude Code で使う場合

- ユーザー設定の `"disableClaudeAiConnectors": true` で claude.ai のコネクタを止める。
- プロジェクトごとに、そのパスのコネクタだけを登録する: `claude mcp add --transport http --scope local gh-pocket https://<workers のホスト>/e/pocket-ssh-agent/mcp`
- key は commit しない `.claude/settings.local.json` の `env` に置く。
- 手元の `gh` や git の認証がメインアカウントのままだと、この仕組みの意味がなくなります。AI 用には `GH_CONFIG_DIR` を分けるか、コンテナの中で動かしてください。

## 設定（PATHS_JSON）

| 項目 | 内容 |
| --- | --- |
| `enabled` | `false` で停止 |
| `expires` | この日時を過ぎたら停止（ISO 8601） |
| `key_sha256` | 環境の key の SHA-256（16進64文字） |
| `allowed_logins` | 許可する GitHub の login |
| `upstream` | 転送先。公式 GitHub MCP の URL（ツールセットで絞れる） |

## 防げること・防げないこと

- 防げること: 環境どうしの取り違えと、repo をまたぐ prompt injection（例: public repo の作業中に private repo へ書き込ませる）。
- 防げないこと: 同じ環境のセッションが、許可した範囲の中で悪用すること。key はセッションから読めるので、認証情報ではなく「利用許可の合言葉」として扱い、`expires` と定期的な入れ替えで守ります。

## 未確認のこと

- 届いた OAuth の token をそのまま公式 GitHub MCP に転送して使えるか（実環境ではまだ試していません）。
- cloud セッションで `~/.claude/CLAUDE.md` が読まれるか。

## テスト

```bash
npm test
```
