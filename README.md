# gh-mcp-relay

claude.ai の GitHub コネクタ（MCP）を、**セッションごとに決めた本流の repo だけ** に使わせるための中継です。Cloudflare Workers で動きます。

## 何のためのものか

### これまでの前提

- Claude は AI 用アカウント `tksugimoto-ai` で作業し、コードの変更は fork（`tksugimoto-ai/<repo>`）に push する。
- Issue・PR・コメントは本流（`tksugimoto/<repo>` や org の repo）に出す。本流に届く経路は claude.ai のコネクタ（独自 GitHub App のユーザートークンで動く GitHub MCP）。
- AI は本流の `main` を変えられない（本流での `tksugimoto-ai` の権限で GitHub が強制する）。

### 解決したい課題

最初から入っている公式の GitHub 連携は、セッションに追加した repo（= fork）にしか届きません。本流はセッションに入れられない（fork と同名のため）ので、本流には自分で追加した GitHub コネクタが必要です。ところが、自分で追加したコネクタは claude.ai のアカウント単位なので、**どのセッションにも全部見え、コネクタが届く全部の repo を操作できます**。たとえば repo A の作業中に読んだ Issue に仕込まれた指示（prompt injection）で、repo B（org の private repo など）に書き込まれたり、中身を持ち出されたりするおそれがあります。

GitHub App の install 先や公式 GitHub MCP の設定では、これを防げません。

- GitHub App の install 先は「App が届く repo」を決めるだけで、どのセッションから使うかは区別できない。
- 公式 GitHub MCP の URL で絞れるのは、ツールセットと読み取り専用かどうかだけ。repo は絞れない。
- claude.ai には、コネクタを環境ごとに出し分ける設定がない（cloud では `deniedMcpServers` で隠せるが、許可リストではないので、コネクタを足すたびに全環境の設定を直す必要がある）。

### この中継がすること

1つのセッション（cloud の環境、またはローカルのプロジェクト）で操作できる本流の repo を、そのセッションに置いた **key** で決めます。

- key には操作してよい `owner/repo` が書かれていて、中継が署名を確かめる。基本は1つ。submodule の編集などで必要なら複数書ける。
- 中継は、ツール呼び出しの `owner`/`repo` が key の範囲にあるときだけ、公式 GitHub MCP に転送する。
- key を置いていないセッション（cloud の Default 環境など）からは、コネクタが見えていても何もできない。新しい repo は、何もしなければ閉じた状態になる。

認可（OAuth）は Claude のコネクタと GitHub に任せます。中継は token を確かめも保存もせず、そのまま転送します。

前提にした制約や、ほかに検討した方式は [docs/design.md](docs/design.md) にまとめています。

## 全体像

本流 `tksugimoto/pocket-ssh-agent` を、その fork で作業する cloud 環境から操作する場合の例です。ほかの repo でも形は同じです。

```
cloud 環境「pocket-ssh-agent」のセッション
  （UPSTREAM_KEY=gh-mcp-relay:tksugimoto/pocket-ssh-agent:<署名>）
  │
  ├─ git push ─────────────► fork  tksugimoto-ai/pocket-ssh-agent   （Claude GitHub App）
  │
  └─ コネクタ「GitHub relay」 ─► gh-mcp-relay
                                  │ ・upstream_key の署名が正しいか
                                  │ ・owner/repo が key に書かれた repo か
                                  ▼
                                公式 GitHub MCP ─► 本流 tksugimoto/pocket-ssh-agent
                                                  （独自 GitHub App を本流に install）
```

## 例

| もの | 例 |
| --- | --- |
| 公式 GitHub MCP の URL | `https://api.githubcopilot.com/mcp/x/issues,pull_requests` |
| claude.ai に登録するコネクタの URL | `https://gh-mcp-relay.<アカウント>.workers.dev/mcp/x/issues,pull_requests` |
| key（repo 1つ） | `gh-mcp-relay:tksugimoto/pocket-ssh-agent:849E1kvgMpGA0vXKG9LblAa0Tdz02uWjjMHQAUWMWFM` |
| key（repo 2つ、期限つき） | `gh-mcp-relay:tksugimoto/app,tksugimoto/app-submodule:2027-04-01:<署名>` |

コネクタの URL は、公式 GitHub MCP の URL のホスト部分だけを中継のものに置き換えたものです。中継はパスをそのまま `api.githubcopilot.com` に渡します。転送先はこのホストに固定で、パスも `/mcp` 以下だけを受け付けます。

key は `gh-mcp-relay:<owner/repo>[,<owner/repo>...][:<期限>]:<署名>` の形です。中身は読めるので、どの repo 用の key か見ればわかります。署名は HMAC-SHA256 で、署名用の鍵（`KEY_SECRET`）を持つ人しか作れません。

## 使い方（Claude のセッションから）

1. コードを変更し、fork のブランチに `git push` する（通常どおり）。
2. コネクタの `create_pull_request` を、本流を `owner`/`repo` に、head を `tksugimoto-ai:<branch>` にして呼ぶ。
3. その際、すべてのツール呼び出しに引数 `upstream_key` を付ける。値はセットアップスクリプトが `~/.claude/CLAUDE.md` に書いておくので、Claude はそれを読んで渡す。

`upstream_key` は中継が確認したあと引数から消すので、GitHub には届きません。`tools/list` の結果にも中継が `upstream_key`（必須）を足すので、Claude は引数があることを自然に知ります。

## 中継が確かめること

- Authorization ヘッダーが無ければ `401` を返し、`WWW-Authenticate` でメタデータ（`/.well-known/oauth-protected-resource/<パス>`、認可サーバーは GitHub）の場所を伝える。Claude はこれを見て、GitHub で OAuth を行う。token の中身は確かめない。
- `tools/call` では、`upstream_key` の署名と期限を確かめる。
- 引数の `owner`/`repo`（`parent_owner`/`parent_repo` なども）がすべて key の範囲にあるか確かめる。`owner`/`repo` を取らないツールは、`get_me` を除いて拒否する。`search_*` は `owner`/`repo` を省略でき、クエリでほかの repo にも届きうるので、引数によらず拒否する。
- 拒否したときは転送せず、JSON-RPC のエラーを返す。
- `tools/list` の結果には、各ツールに `upstream_key` 引数（必須）を足す。

ログにはパス・ツール名・結果だけを残し、token・ヘッダー・key は残しません。

## 準備

### 1. GitHub App を作る

1つ作り、個人の本流にも org の本流にも install します。org の repo にも入れられるよう、「Where can this GitHub App be installed?」は Any account（public）にします。public にしても、ほかの人が自分の repo に install できるだけで、こちらの repo には届きません。

- 権限: Issues（Read & write）、Pull requests（Read & write）、Metadata（Read）
- Callback URL: claude.ai のコネクタ登録画面に表示される URL（`https://claude.ai/api/mcp/auth_callback` と思われる）
- 「Expire user authorization tokens」は ON のまま（Claude が refresh token で更新する）
- 本流に install する（Only select repositories）。本流を足すときは、install 先に足す

### 2. 中継をデプロイする（最初の1回）

```bash
npm install
openssl rand -base64 32 > .key-secret             # 署名用の鍵。手元に安全に保管する
npx wrangler secret put KEY_SECRET < .key-secret
npm run deploy
```

### 3. claude.ai にコネクタを登録する（最初の1回）

- URL: 上の「例」の形
- Advanced settings に、GitHub App の Client ID と Client secret を入れる
- `tksugimoto-ai` でログインした状態で認可する

### 4. key を発行して環境に置く（環境ごと）

key の発行は手元で行います。署名用の鍵を持っている人だけが発行できるので、Web ページや別の認証は用意しません。

```bash
KEY_SECRET=$(cat .key-secret) npm run new-key -- tksugimoto/pocket-ssh-agent
KEY_SECRET=$(cat .key-secret) npm run new-key -- tksugimoto/app tksugimoto/app-submodule --expires 2027-04-01
```

cloud では、本流ごとに専用の環境を作り、次を設定します。Default 環境には key を置きません。

- 環境変数: `UPSTREAM_KEY=<発行した key>`
- セットアップスクリプト: `examples/setup-script.sh` を参考にする（`~/.claude/CLAUDE.md` に使い方と key を書く）

### ローカルの Claude Code で使う場合

claude.ai のアカウントでログインしたローカルの Claude Code には、claude.ai のコネクタがそのまま出てきます。コネクタの登録と認可は cloud と共有でき、ローカル用に登録し直す必要はありません。

- key はプロジェクトの `CLAUDE.local.md`（commit しない）に、cloud の `~/.claude/CLAUDE.md` と同じ文面で書く。
- 手元の `gh` や git の認証がメインアカウントのままだと、この仕組みの意味がなくなります。AI 用には `GH_CONFIG_DIR` を分けるか、コンテナの中で動かしてください。

## key の取り消し

key は中継に記録しないので、1つずつ取り消すことはできません。期限（`--expires`）を付けて発行し、全部を無効にしたいときは `KEY_SECRET` を入れ替えて、key を発行し直します。

## 防げること・防げないこと

- 防げること: 1つのセッションから、key で許していない repo を操作すること（repo をまたぐ prompt injection を含む）。
- 防げないこと: 許した repo の中での悪用。また、key はセッションから読めるので、ほかのセッションに書き写されるとその repo を使われます。認証情報ではなく「利用許可の合言葉」として扱い、期限で守ります。

## 未確認のこと

- 届いた OAuth の token をそのまま公式 GitHub MCP に転送して使えるか（実環境ではまだ試していません）。
- cloud セッションで `~/.claude/CLAUDE.md` が読まれるか。

## テスト

```bash
npm test
```
