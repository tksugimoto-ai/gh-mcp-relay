# 設計: fork から本流への Issue・PR

この中継がなぜこの形なのかをまとめます。使い方は [README](../README.md) を見てください。

## 目的

AI 用アカウント `tksugimoto-ai` で、fork から本流（upstream）へ Issue と PR を出せるようにする。cloud でもローカルでも同じ仕組みで動かす。

### 要件

- Issue・PR・コメントは `tksugimoto-ai` の名前で出す。
- Claude GitHub App は本流に入れない（public も private も）。fork だけに入れる。
- `tksugimoto-ai` は本流の `main` を変えられない（public なら権限なし、org の private なら Triage）。
- org の private repo と個人の public repo が、1つのセッションの中で混ざらないようにする。
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
| 独自コネクタ1つで全本流を扱う | 不採用 | 全セッションから private と public の両方に届き、prompt injection による漏洩の経路ができる |
| PAT を環境変数 `GH_TOKEN` に入れる | 不可 | GitHub 専用 proxy の repo 範囲で 403 になる見込み。token がセッションから見える |
| 自作 proxy ＋ネットワークシークレットに PAT | 次点 | token が見えず隔離が強い。ただし PAT を自分で管理し、repo の制限は proxy だけが担う。ローカルでは使えない |
| ネットワークシークレットでコネクタの利用を絞る | 不可 | MCP の通信は agent proxy を通らないので、シークレットが付かない |
| 入力済みリンク（compare の URL、`issues/new`） | 代替案 | 混ざらず、本流の設定も要らない。ただし PR の編集やコメントのたびに手作業が要る |
| 環境ごとの専用コネクタ＋薄い自作 proxy | **採用** | 認可は Claude と GitHub に任せられ、repo の範囲も GitHub が強制する。cloud とローカルで共通 |

## 採用した設計

環境ごとに専用のコネクタを、URL のパスで分けて登録します。中継は、パス・token の持ち主・環境ごとの key だけを確認し、公式 GitHub MCP に転送します。fork への push は、これとは別に fork だけに入れた Claude GitHub App が行います。

| 守るもの | 強制するもの | 仕組み |
| --- | --- | --- |
| repo の範囲 | GitHub | 所有者ごと（または環境ごと）の GitHub App を、その本流にだけ install |
| 操作の範囲（merge、push） | GitHub | `tksugimoto-ai` の本流での権限 |
| 環境ごとの利用許可 | 中継 | パスと key の対応。key は環境変数 |
| 誰の名前で動くか | GitHub と中継 | OAuth の token の持ち主を `allowed_logins` に限る |
| token の管理 | Claude | コネクタの OAuth。中継は保存しない |

- GitHub App は、少なくとも所有者ごと（org と個人）に分けます。private 設定の App は所有者にしか install できないので、org の private repo と個人の public repo の境界を GitHub 側で守れます。
- 同じ所有者の repo どうしで App を共用すると、その間の境界は中継だけになります。厳しくしたい repo は専用の App にします。
- 中継は通信の中身をほぼ解析しません。ツールごとに細かく制限したくなったら、公式サーバーへの転送をやめて、少数の自前ツールを実装します。

## cloud の環境構成

本流ごとに環境を作り、key はその環境にだけ置きます。Default 環境には key を置かないので、新しい repo は初期状態で本流に届きません。

| 環境 | 使う repo（fork） | 環境変数 | セットアップスクリプト |
| --- | --- | --- | --- |
| Default | 専用環境のない repo すべて | なし | 中継のコネクタを deny（任意） |
| 本流ごとの環境 | その本流の fork | `UPSTREAM_KEY=<その環境用>` | ほかの環境のコネクタを deny（任意）、`~/.claude/CLAUDE.md` に使い方 |

- key は推測できないランダムな値にします。環境変数はその環境を使う人とセッションから読めるので、認証情報ではなく「利用許可の合言葉」として扱います。
- 使い方の説明は本流の repo に入れず、セットアップスクリプトで `~/.claude/CLAUDE.md` に書き出します。
- 環境変数 `ENABLE_CLAUDEAI_MCP_SERVERS=false` は全コネクタを止めるだけで個別に戻せないので使いません。

### repo を1つ足す手順

1. 本流で `tksugimoto-ai` に権限を付ける（private なら Triage、public なら不要）。
2. 本流を `tksugimoto-ai` に fork する。
3. 本流の所有者の GitHub App を、本流に install する（Only select repositories）。
4. 中継にパスを追加し、ランダムな key を発行する。
5. そのパスの URL を、claude.ai にコネクタとして登録する。
6. 専用の環境を作り、`UPSTREAM_KEY` とセットアップスクリプトを設定する。

## リスク

この設計が防ぐのは、環境どうしの誤った混在と、repo をまたぐ prompt injection です。同じ環境のセッションによる、許可した範囲内での悪用は防げません。

| リスク | 内容 | 対策 |
| --- | --- | --- |
| key がセッションから読める | 別の環境のセッションに key を渡されると、そのパスを使われる | key の定期的な入れ替え、`expires` |
| fork への git push | 組み込みの GitHub 連携なので、コネクタ側の制御が効かない | private のコネクタは、その環境以外で deny する |
| deny の列挙漏れ | コネクタの登録し直しで UUID 名が変わる | 登録し直したら確認し直す。deny は多重の守りで、中心は key |
| 中継を通る通信 | token と PR 本文が中継を通過する | ヘッダーをログに残さない。信頼できるホスティング先に置く |
| 組み込みの PR 監視 | 本流の PR には効かない | コネクタ経由で PR の状態を読みに行く |

## 未確認のこと

- [x] GitHub を認可サーバーにした OAuth で、claude.ai のコネクタ登録が通るか。GitHub は `https://github.com/.well-known/oauth-authorization-server/login/oauth` でメタデータを公開している（PKCE S256、refresh token 対応、DCR なし）。Client ID と secret はコネクタ登録画面の Advanced settings に入れる。
- [ ] 公式 GitHub MCP への転送で、届いた OAuth の token がそのまま使えるか。
- [ ] 同じユーザーと App の組み合わせで、発行できる user token の数に上限があるか。
- [ ] cloud で `~/.claude/CLAUDE.md` が読まれるか。
- [ ] `allowedMcpServers`（許可リスト）がユーザー設定で効くか（効けば deny の列挙が不要になる）。
