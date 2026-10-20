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
  （GH_MCP_RELAY_KEY=gh-mcp-relay:tksugimoto/pocket-ssh-agent:<署名>）
  │
  ├─ git push ─────────────► fork  tksugimoto-ai/pocket-ssh-agent   （Claude GitHub App）
  │
  └─ コネクタ「GitHub relay」 ─► gh-mcp-relay
                                  │ ・gh_mcp_relay_key の署名が正しいか
                                  │ ・owner/repo が key に書かれた repo か
                                  ▼
                                公式 GitHub MCP ─► 本流 tksugimoto/pocket-ssh-agent
                                                  （独自 GitHub App を本流と fork に install）
```

## 例

| もの | 例 |
| --- | --- |
| 公式 GitHub MCP の URL | `https://api.githubcopilot.com/mcp` |
| claude.ai に登録するコネクタの URL | `https://gh-mcp-relay.<アカウント>.workers.dev/mcp` |
| key（repo 1つ） | `gh-mcp-relay:tksugimoto/pocket-ssh-agent:<署名>` |
| key（repo 2つ、期限つき） | `gh-mcp-relay:tksugimoto/app,tksugimoto/app-submodule:2027-04-01:<署名>` |

コネクタの URL は、公式 GitHub MCP の URL のホスト部分だけを中継のものに置き換えたものです。中継はパスをそのまま `api.githubcopilot.com` に渡します。転送先はこのホストに固定で、パスは `/mcp`（既定のツールセット）、`/mcp/x/<ツールセット>` と、それぞれの `/readonly` 版を受け付けます（`/insiders` は通しません）。`/mcp/x/` で通すツールセットは、ツールが `owner`/`repo` を取り、repo の中に閉じるもの（`actions`、`code_quality`、`code_security`、`dependabot`、`discussions`、`git`、`issues`、`labels`、`pull_requests`、`repos`、`secret_protection`）だけです。repo の外に届くツールを含むもの（gists、notifications など）と、上流の更新でツールが増える `all` は通しません。1 つの URL で選べるツールセットは 1 つなので、既定と actions を使うなら `/mcp` と `/mcp/x/actions` のようにコネクタを並べます。何ができるか（actions の再実行など）は App の権限で決まるので、使わせたくない操作は App の権限を付けないでおきます。

key は `gh-mcp-relay:<owner/repo>[,<owner/repo>...][:<期限>]:<署名>` の形です。期限の日付になった時点（その日の 0 時 UTC、日本時間 9 時）から使えなくなります。中身は読めるので、どの repo 用の key か見ればわかります。署名は HMAC-SHA256 で、署名用の鍵（`KEY_SECRET`）を持つ人しか作れません。

## 使い方（Claude のセッションから）

1. コードを変更し、fork のブランチに `git push` する（通常どおり）。
2. コネクタの `create_pull_request` を、本流を `owner`/`repo` に、head を `tksugimoto-ai:<branch>` にして呼ぶ。
3. その際、すべてのツール呼び出しに引数 `gh_mcp_relay_key` を付ける。値は環境変数 `GH_MCP_RELAY_KEY` にあり、セットアップスクリプトが入れる SessionStart の hook が、セッションの開始時に Claude の文脈に入れる。Claude はそれを渡す。

`gh_mcp_relay_key` は中継が確認したあと引数から消すので、GitHub には届きません。`tools/list` の結果にも中継が `gh_mcp_relay_key`（必須）を足すので、Claude は引数があることを自然に知ります。

## 中継が確かめること

- Authorization ヘッダーが無ければ `401` を返し、`WWW-Authenticate` でメタデータ（`/.well-known/oauth-protected-resource/<パス>`、認可サーバーは GitHub）の場所を伝える。Claude はこれを見て、GitHub で OAuth を行う。token の中身は確かめない。
- 通す JSON-RPC のメソッドは `initialize`・`ping`・`tools/list`・`tools/call`・`notifications/*` だけ。`resources/read`・`prompts/get`・`completion/complete` などは repo を引数ではなく URI などで渡し、確かめられないので拒否する。
- `tools/call` では、`gh_mcp_relay_key` の署名と期限を確かめる。
- 引数の `owner`/`repo`（`parent_owner`/`parent_repo` なども）がすべて key の範囲にあるか確かめる。`owner`/`repo` を取らないツールは、`get_me` を除いて拒否する。`search_*` は `owner`/`repo` を省略でき、クエリでほかの repo にも届きうるので、引数によらず拒否する。Projects のツールも、`owner` だけでアカウントや org 全体に効くので、引数によらず拒否する。`create_repository`・`get_teams`・`get_team_members` のように key の repo の外に効くツールと、`organization`・`org`・`user` など owner/repo とは別に対象を決める引数が付いた呼び出しも拒否する（使わない `owner`/`repo` を足して確認を通り抜けられないように）。
- 拒否したときは転送せず、JSON-RPC のエラーを返す。
- `tools/list` の結果には、各ツールに `gh_mcp_relay_key` 引数（必須）を足す。

ログにはパス・ツール名・結果だけを残し、token・ヘッダー・key は残しません。

`wrangler.jsonc` で Workers Logs を有効にしているので、このログは Cloudflare に保存され、ダッシュボードで後から見られます（拒否された呼び出しを追うため）。リクエストごとの invocation log は URL やリクエストの情報を含むので、無効にしています。保存したくなければ `observability.enabled` を `false` にしてください。

## 準備

### 1. GitHub App を作る

1つ作り、個人の本流にも org の本流にも install します。org の repo にも入れられるよう、「Where can this GitHub App be installed?」は Any account（public）にします。public にしても、ほかの人が自分の repo に install できるだけで、こちらの repo には届きません。

- 権限: Issues（Read & write）、Pull requests（Read & write）、Contents（Read）、Metadata（Read）。Contents は、fork から本流への PR を作るときに、GitHub が head と base を比べるのに要る
- Callback URL: claude.ai のコネクタ登録画面に表示される URL（`https://claude.ai/api/mcp/auth_callback` と思われる）
- 「Expire user authorization tokens」は ON のまま（Claude が refresh token で更新する）
- 本流に install する（Only select repositories）。private の本流では fork にも install する。fork に入れないと、PR を作るときに head のある fork を読めず `not all refs are readable` で失敗する。public の本流と fork なら、fork に入れなくても PR を作れる（確かめた）。fork に入れても、中継が key に書いた本流だけに絞るので、届く範囲は変わらない

### 2. 中継をデプロイする（最初の1回）

```bash
npm install
openssl rand -base64 32 > .key-secret             # 署名用の鍵。手元に安全に保管する
npx wrangler secret put KEY_SECRET < .key-secret
npm run deploy
```

- コンテナや SSH の先など、ブラウザから `localhost:8976` に戻れない環境では、先に `npx wrangler login --device` でログインする（表示された URL とコードをブラウザで開いて承認する）。
- デプロイし直した後や、key・セットアップスクリプトを変えた後は、コネクタを使うセッションを始め直す。ツールの定義はセッションの開始時に読まれるため。

### 自動デプロイ（GitHub Actions）

本流の main に push されると、`.github/workflows/deploy.yml` が `npm test` の後に `wrangler deploy` します（Actions の画面から手動でも動かせます）。md・`docs/`・`examples/`・`.devcontainer/`・`LICENSE` だけの変更ではデプロイしません。最初の1回だけ、次を設定します。

1. Cloudflare で account-owned の API token を作る。権限は Workers の **Editor を、この Worker（`gh-mcp-relay`）だけ**に付ける。期限も付ける（切れるとデプロイが認証エラーで失敗するので、作り直して secret を入れ替える）。`wrangler login` の token は範囲が広いので CI には使わない。
2. 本流の Settings → Environments に `production` を作り、Deployment branches を `main` だけにする。
3. その Environment に、secret `CLOUDFLARE_API_TOKEN`（1 の token）と variable `CLOUDFLARE_ACCOUNT_ID`（secret ではなく variable）を入れる。repo の secret ではなく Environment の secret にする。
4. 任意: Environment の required reviewers に自分を入れると、デプロイごとに承認を挟める。

- `KEY_SECRET` は GitHub に置かない。Worker の secret は `wrangler deploy` で消えないので、入れ替えるときだけ手元から `wrangler secret put` する。
- fork からの PR では、このワークフローは動かず、secret も渡らない。`pull_request_target` は使わない。
- Worker が「2. 中継をデプロイする」で一度作られていることが前提。Editor の token では Worker を新しく作れない。

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

- 環境変数: `GH_MCP_RELAY_KEY=<発行した key>`。名前で、この中継の key だとわかるようにしている
- セットアップスクリプト: [examples/setup-script.sh](examples/setup-script.sh) を参考にする（`~/.claude/CLAUDE.md` に使い方を書き、`~/.claude/settings.json` に SessionStart の hook を入れる）。key の値をファイルに書き出したり、Claude にコマンドで環境変数を読ませたりはしない。セットアップスクリプトの実行時には環境変数が空のことがあり（結果はキャッシュされる）、Claude がコマンドで環境変数を読むと自動の権限チェックで止められることがあるため

### ローカルの Claude Code で使う場合

claude.ai のアカウントでログインしたローカルの Claude Code には、claude.ai のコネクタがそのまま出てきます。コネクタの登録と認可は cloud と共有でき、ローカル用に登録し直す必要はありません。

- key はプロジェクトの `CLAUDE.local.md`（commit しない）に書く。ローカルには SessionStart の hook が無いので、cloud の `~/.claude/CLAUDE.md` の「セッションの開始時に示された値を渡す」の代わりに、「引数 gh_mcp_relay_key に次の値を渡す: `<key>`」と値をそのまま書く。
- 手元の `gh` や git の認証がメインアカウントのままだと、この仕組みの意味がなくなります。AI 用には `GH_CONFIG_DIR` を分けるか、コンテナの中で動かしてください。

### App を入れられない repo を読む場合（OAuth App と読み取り専用のコネクタ）

持ち主がほかの人で、独自の GitHub App を入れられない repo（ほかの人の private の repo など）があります。GitHub App の user token は install 先にしか届かないので、上のコネクタではその repo に届きません。install せずに届くのは OAuth App だけなので、読み取り専用のコネクタをもう1つ足します。

| | 上のコネクタ | 足すコネクタ |
| --- | --- | --- |
| OAuth のクライアント | GitHub App | OAuth App |
| URL | `https://<中継>/mcp` など | `https://<中継>/mcp/readonly` など（`/readonly` で終わるパスだけ） |
| 届く範囲を絞るもの | GitHub（App の install 先）と key | key だけ |
| 書き込み | できる（App の権限の範囲で） | できない（公式 GitHub MCP の readonly で、書き込みのツールが出ない） |

- 同じ URL のコネクタは 2 つ目を登録できないので、readonly のパスで URL を分けます。読み取り専用にすること自体も、この用途に合っています。
- ほかのツールセットを読むときも、`/mcp/x/actions/readonly` のように `/readonly` で終わるパスで登録します。OAuth App の token には App の権限による制限が無いので、`/readonly` で終わらないパスでは登録しません（中継も、`repo` の scope は `/readonly` で終わるパスでだけ求めます）。
- 中継の確認（key の署名、引数の `owner`/`repo`、`search_*` と Projects のツールの拒否）は、そのまま効きます。
- OAuth App の token は、認可のときに求めた scope しか持ちません。private の repo を読むには `repo` の scope が要るので、中継は readonly のパスでだけ、メタデータの `scopes_supported` と 401 の `WWW-Authenticate` で `repo` を伝えます。

手順:

1. その repo を `tksugimoto-ai` が読めるようにする（持ち主に招いてもらう）。org の repo なら Read でよい。個人のアカウントの repo では collaborator は必ず Write になるが、このコネクタは読み取り専用で、その repo には Claude GitHub App も入れないので、AI から書き込む経路は無い。
2. 必要なら、`tksugimoto-ai` で fork し、fork に Claude GitHub App を入れる（cloud でコードを clone して動かす場合）。private の fork は、元の repo を読む権限を失うと消える。
3. OAuth App を作る（Settings → Developer settings → OAuth Apps）。Callback URL は `https://claude.ai/api/mcp/auth_callback`。
4. claude.ai にコネクタを登録する。URL は上の readonly のもので、Advanced settings に OAuth App の Client ID と secret を入れる。`tksugimoto-ai` でログインした状態で認可する。
5. 認可した後、GitHub の Settings → Applications → Authorized OAuth Apps で、`repo` の scope が付いたか確かめる。
6. org の repo では、org の owner に OAuth App を承認してもらう。承認されるまでは「organization has enabled OAuth App access restrictions」の 403 になる。owner が org の Settings → Third-party access（`https://github.com/organizations/<org>/settings/oauth_application_policy`）で Approve する。owner でなければ、Authorized OAuth Apps でその App を開き、org の横の Request で申請する。
7. その repo 用の key を発行し、専用の環境に `GH_MCP_RELAY_KEY` として置く（上の手順と同じ）。

守りが弱くなる点:

- OAuth App の token は `repo` の scope で、`tksugimoto-ai` が触れる全部の repo に読み書きできる。GitHub 側で範囲を絞れず、境界は key と readonly のパスだけになる。
- 読み取り専用なのは、コネクタの URL（`/readonly`）で公式 GitHub MCP が書き込みのツールを出さないからで、token そのものは書き込める。token が漏れたとき（中継や claude.ai の外で使われたとき）や、同じ OAuth App を `/readonly` の無い URL のコネクタで登録したときには、この制限は効かない（漏れたときは key も効かない）。token でできるのは scope と `tksugimoto-ai` 自身の権限が重なる部分なので、被害の上限は `tksugimoto-ai` の権限の全体になる。読むだけの repo では `tksugimoto-ai` を Read の role にしておくのが守りになる（Read でも Issue の作成やコメントはできる）。
- token はセッションからは見えない（claude.ai が持ち、中継は転送するだけ）。ただし、中継を動かす Cloudflare のアカウントでコードを書き換えれば、token を記録できる。
- key は同じ claude.ai アカウントの中では強い境界にならない（[docs/design.md](docs/design.md) のリスク）。強い境界が要る repo は claude.ai のアカウントを分ける。この方法は、アカウントを分けるほどではない repo 向け。
- OAuth App の token には、既定で期限が無い。要らなくなったら、Authorized OAuth Apps で取り消す。

使わない方法:

- cloud の `/web-setup` は、`gh` の token をアカウント全体の GitHub の接続として保存し、今の接続を置き換える。環境ごとに分けられない。
- 中継を通さずに、公式 GitHub MCP の readonly の URL をそのままコネクタにすると、key の確認が無く、全部のセッションから全部の repo を読める。

## key の取り消し

key は中継に記録しないので、1つずつ取り消すことはできません。期限（`--expires`）を付けて発行し、全部を無効にしたいときは `KEY_SECRET` を入れ替えて、key を発行し直します。入れ替えるとすべての key が使えなくなるので、全環境の `GH_MCP_RELAY_KEY` を差し替えます。

## 防げること・防げないこと

- 防げること: 1つのセッションから、key で許していない repo を操作すること（repo をまたぐ prompt injection を含む）。
- 防げないこと: 許した repo の中での悪用。OAuth App のコネクタでは、GitHub 側の範囲の制限が無いので、key だけが境界になる。また、key はセッションから読めるので、ほかのセッションに書き写されるとその repo を使われます。認証情報ではなく「利用許可の合言葉」として扱い、期限で守ります。

## テスト

```bash
npm test
```
