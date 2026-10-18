# gh-mcp-relay

GitHub MCP 用の薄い中継です。Cloudflare Workers で動きます。claude.ai のコネクタを環境ごとに分けて登録し、その環境のセッションからだけ使えるようにします。

- 認可（OAuth）は Claude のコネクタと GitHub に任せます。中継は token を保存しません。
- 中継が確認するのは、パス、token の持ち主（GitHub の login）、環境ごとの key の3つだけです。
- 届く repo の範囲は、GitHub App の installation 先で決まります（GitHub が強制）。

設計の背景は、別のドキュメント「fork→本流 Issue/PR運用設計」にまとめています。

## 仕組み

| URL | 役割 |
| --- | --- |
| `/e/<パス名>/mcp` | MCP の受け口。確認が通れば、設定の `upstream`（公式 GitHub MCP）に転送する |
| `/.well-known/oauth-protected-resource/e/<パス名>/mcp` | 認可サーバーとして `https://github.com/login/oauth` を返す |

1. token がない、または無効なら `401` を返し、`WWW-Authenticate` でメタデータの場所を伝えます。Claude はこれを見て、GitHub で OAuth を行います。
2. token の持ち主を `https://api.github.com/user` で確かめ、`allowed_logins` にない人は拒否します。
3. `tools/call` の引数 `upstream_key` のハッシュ値が、パスの `key_sha256` と一致するか確かめます。確かめたあと、引数から消してから転送します。
4. `tools/list` の結果には、各ツールに `upstream_key` 引数（必須）を足します。Claude が渡し忘れないようにするためです。

中身を解析するのは、上の 3 と 4 だけです。

## 準備

### 1. GitHub App を作る

本流の所有者ごとに1つ作ります（例: 個人用、org 用）。

- 権限: Issues（Read & write）、Pull requests（Read & write）、Metadata（Read）
- Callback URL: claude.ai のコネクタ登録画面に表示される URL（`https://claude.ai/api/mcp/auth_callback` と思われる）。ローカルの Claude Code でも使うなら、その URL も足す
- 「Expire user authorization tokens」は ON のまま（Claude が refresh token で更新する）
- 本流にだけ install する（Only select repositories）

### 2. key を発行して設定を作る

```bash
npm run new-key
cp examples/paths.example.json paths.json   # key_sha256 などを書き換える
npx wrangler secret put PATHS_JSON < paths.json
npm run deploy
```

`paths.json` は `.gitignore` に入っています。repo には置きません。

### 3. claude.ai にコネクタを登録する

- URL: `https://<workers のホスト>/e/<パス名>/mcp`
- Advanced settings に、GitHub App の Client ID と Client secret を入れる
- `tksugimoto-ai` でログインした状態で認可する

### 4. cloud 環境を設定する

- 環境変数: `UPSTREAM_KEY=<new-key で出た値>`
- セットアップスクリプト: `examples/setup-script.sh` を参考にする

## 設定（PATHS_JSON）

| 項目 | 内容 |
| --- | --- |
| `enabled` | `false` で停止 |
| `expires` | この日時を過ぎたら停止（ISO 8601） |
| `key_sha256` | 環境の key の SHA-256（16進64文字） |
| `allowed_logins` | 許可する GitHub の login |
| `upstream` | 転送先。公式 GitHub MCP の URL（ツールセットで絞れる） |

## テスト

```bash
npm test
```
