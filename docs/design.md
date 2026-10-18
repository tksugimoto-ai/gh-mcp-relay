# 設計: fork から本流への Issue・PR

この中継がなぜこの形なのかをまとめます。使い方は [README](../README.md) を見てください。

## 背景

- AI 用アカウント `tksugimoto-ai` で、fork から本流（upstream）へ Issue と PR を出す。cloud でもローカルでも同じ仕組みで動かす。
- AI が本流の `main` を変えられない仕組みにする。

## 解決したい課題

claude.ai のコネクタはアカウント単位なので、1つのセッションから全部の GitHub コネクタが見え、それらが届く全部の repo を操作できる。これを、セッションごとに決めた本流の repo だけに絞る（将来 Claude 側が環境ごとのコネクタ管理を提供すれば、この中継は不要になるかもしれない）。

### 要件

- Issue・PR・コメントは `tksugimoto-ai` の名前で出す。
- Claude GitHub App は本流に入れない（public も private も）。fork だけに入れる。
- `tksugimoto-ai` は本流の `main` を変えられない（public なら権限なし、org の private なら Triage）。
- 1つのセッション（環境）で操作できる本流の repo は、基本は1つにする。private と public の間だけでなく、public の repo どうしも混ぜない。
- submodule の編集などのために、1つのセッションに複数の repo を許すこともできる。
- 認可の仕組みは Claude と GitHub に任せ、token を自分で管理しない。
- 新しい repo は、何も設定しなくても本流に届かない状態になる。

## 前提と制約

Claude Code の cloud 環境と claude.ai のコネクタには次の制約があり、設計はこれを前提にしています。

| 制約 | 内容 |
| --- | --- |
| 同名 repo | 持ち主が違う同名の repo を、1つのセッションに入れられない（checkout 先が衝突する） |
| GitHub 専用 proxy | セッションから GitHub への通信は専用 proxy を通り、セッションに入っていない repo への API は 403 になる（public の読み取りも） |
| GraphQL | proxy で拒否される。`gh pr` / `gh issue` は動かず、REST（`gh api`）のみ |
| ネットワークシークレット | GitHub 宛ての通信には付かない |
| コネクタの範囲 | claude.ai のアカウント単位。どのセッションからも全部見え、セッションの repo 範囲に縛られない |
| コネクタの重複 | 同じ URL のコネクタは2つ目を登録できない |
| MCP の通信経路 | コネクタの呼び出しは Anthropic 側の MCP proxy から出る。セッションの環境変数やネットワークシークレットは乗らない |
| 公式 GitHub MCP | URL で絞れるのはツールセットと読み取り専用だけ。repo の範囲は絞れない |
| GitHub App の install 先 | private 設定の App は、App 所有者のアカウントにしか install できない |

cloud セッションでも、`~/.claude/settings.json` の `deniedMcpServers` で claude.ai のコネクタを止められることを確かめました。ただし、表示名と UUID 名の両方を書く必要があります（表示名だけだと、UUID 名の同じコネクタがすり抜けます）。コネクタを登録し直すと UUID 名が変わるので、そのたびに確認し直します。

## 検討した方式

| 方式 | 採用 | 理由 |
| --- | --- | --- |
| fork と本流を1つのセッションに入れる | 不可 | 同名 repo の制約で入らない |
| collaborator（Write）＋本流に Claude GitHub App | 不採用 | merge できるので `main` への push と実質同じ。Actions の secrets にも届く |
| 独自コネクタ1つで全本流を扱う（中継なし） | 不採用 | 全セッションから全部の repo に届き、prompt injection による漏洩の経路ができる |
| repo の数だけコネクタを登録し、deny で出し分ける | 不採用 | deny は許可リストではないので、コネクタを足すたびに全環境の設定を直す必要がある。設定漏れで開いてしまう |
| PAT を環境変数 `GH_TOKEN` に入れる | 不可 | GitHub 専用 proxy の repo 範囲で 403 になる見込み。token がセッションから見える |
| 自作 proxy ＋ネットワークシークレットに PAT | 次点 | token が見えず隔離が強い。ただし PAT を自分で管理し、repo の制限は proxy だけが担う。ローカルでは使えない |
| ネットワークシークレットでコネクタの利用を絞る | 不可 | MCP の通信は agent proxy を通らないので、シークレットが付かない |
| 入力済みリンク（compare の URL、`issues/new`） | 代替案 | 混ざらず、本流の設定も要らない。ただし PR の編集やコメントのたびに手作業が要る |
| 薄い自作 proxy ＋ repo を書いた署名つき key | **採用** | 認可は Claude と GitHub に任せられる。key を置かないセッションは何もできず、新しい repo は閉じたまま。中継は状態を持たない。cloud とローカルで共通 |

## 採用した設計

コネクタは GitHub App ごとに1つ登録し、どのセッションからも見えるままにします。そのかわり、セッションに置いた key で、操作できる repo を中継が絞ります。fork への push は、これとは別に fork だけに入れた Claude GitHub App が行います。

| 守るもの | 強制するもの | 仕組み |
| --- | --- | --- |
| セッションごとの repo の範囲 | 中継 | key に書いた `owner/repo` と、ツール引数の `owner`/`repo` を照らし合わせる |
| App が届く repo の範囲 | GitHub | GitHub App の install 先 |
| 操作の範囲（merge、push） | GitHub | `tksugimoto-ai` の本流での権限 |
| 誰の名前で動くか・token の管理 | Claude と GitHub | コネクタの OAuth。中継は token を確かめも保存もしない |

### key

key は `gh-mcp-relay:<owner/repo>[,<owner/repo>...][:<期限>]:<署名>` の形で、署名は `KEY_SECRET` を鍵にした HMAC-SHA256 です。

- 中身が読めるので、どの repo 用の key か人にも Claude にもわかる。書き換えると署名が合わなくなる。
- 中継は key を記録しない（状態を持たない）。設定ファイルも KV も要らない。そのかわり key を1つずつ取り消せないので、期限を付けて発行し、全部を無効にしたいときは `KEY_SECRET` を入れ替える。
- 発行は、`KEY_SECRET` を持つ人が手元の CLI で行う。発行用の Web ページは作らない（作るなら、そのページの認証が別に要る）。

### 転送先の URL

コネクタの URL のパスに、本来登録する公式 GitHub MCP の URL（`https://` を除く）をそのまま書きます。転送先のホストは `UPSTREAM_HOSTS` で縛ります。claude.ai では同じ URL のコネクタを2つ登録できないので、GitHub App ごとにコネクタを分けるときは、先頭にラベルを付けます。

### ツールの扱い

- 引数の `owner`/`repo`（`parent_owner`/`parent_repo` なども）がすべて key の範囲にあるときだけ転送する。
- `owner`/`repo` を取らないツールは、`get_me` を除いて拒否する。`search_*` はクエリでほかの repo に届くため。
- 中継は通信の中身をこれ以上は解析しない。ツールごとに細かく制限したくなったら、公式サーバーへの転送をやめて、少数の自前ツールを実装する。

## cloud の環境構成

本流ごとに環境を作り、key はその環境にだけ置きます。Default 環境には key を置かないので、新しい repo は初期状態で本流に届きません。

| 環境 | 使う repo（fork） | 環境変数 | セットアップスクリプト |
| --- | --- | --- | --- |
| Default | 専用環境のない repo すべて | なし | なし |
| 本流ごとの環境 | その本流の fork | `UPSTREAM_KEY=<その repo 用の key>` | `~/.claude/CLAUDE.md` に使い方と key |

- 環境変数はその環境を使う人とセッションから読めるので、key は認証情報ではなく「利用許可の合言葉」として扱います。
- 使い方の説明は本流の repo に入れず、セットアップスクリプトで `~/.claude/CLAUDE.md` に書き出します。
- 中継を通らない GitHub のコネクタが残っている間は、`deniedMcpServers` で見えなくします（表示名と UUID 名の両方を書く）。

### repo を1つ足す手順

1. 本流で `tksugimoto-ai` に権限を付ける（private なら Triage、public なら不要）。
2. 本流を `tksugimoto-ai` に fork する。
3. 本流の所有者の GitHub App を、本流に install する（Only select repositories）。その所有者の App がまだなければ、App を作り、コネクタを登録する。
4. その repo 用の key を発行する（`npm run new-key`）。
5. 専用の環境を作り、`UPSTREAM_KEY` とセットアップスクリプトを設定する。

## リスク

この設計が防ぐのは、1つのセッションから key で許していない repo を操作することです（repo をまたぐ prompt injection を含む）。許した repo の中での悪用は防げません。

| リスク | 内容 | 対策 |
| --- | --- | --- |
| key がセッションから読める | 別のセッションに key を書き写されると、その repo を使われる | 期限つきで発行する。必要なら `KEY_SECRET` を入れ替える |
| key を1つずつ取り消せない | 中継が key を記録しないため | 期限を短めにする。全部を無効にするときは `KEY_SECRET` を入れ替える |
| fork への git push | 組み込みの GitHub 連携なので、コネクタ側の制御が効かない | private のコネクタは、その環境以外で deny する |
| 中継を通る通信 | token と PR 本文が中継を通過する | ヘッダーをログに残さない。信頼できるホスティング先に置く |
| 組み込みの PR 監視 | 本流の PR には効かない | コネクタ経由で PR の状態を読みに行く |

## 未確認のこと

- [x] GitHub を認可サーバーにした OAuth で、claude.ai のコネクタ登録が通るか。GitHub は `https://github.com/.well-known/oauth-authorization-server/login/oauth` でメタデータを公開している（PKCE S256、refresh token 対応、DCR なし）。Client ID と secret はコネクタ登録画面の Advanced settings に入れる。
- [ ] 公式 GitHub MCP への転送で、届いた OAuth の token がそのまま使えるか。
- [ ] 同じユーザーと App の組み合わせで、発行できる user token の数に上限があるか。
- [ ] cloud で `~/.claude/CLAUDE.md` が読まれるか。
- [ ] `allowedMcpServers`（許可リスト）がユーザー設定で効くか（効けば deny の列挙が不要になる）。
