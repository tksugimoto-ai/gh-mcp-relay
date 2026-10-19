# cloud 環境のセットアップスクリプトの例（pocket-ssh-agent 用の環境）。
# 環境変数 GH_MCP_RELAY_KEY を環境の設定に入れておくこと。
mkdir -p ~/.claude

# - deniedMcpServers: 中継を通らない GitHub のコネクタがあれば見えなくする（任意。名前は /mcp か
#   ListConnectors で確認する）。表示名だけだと、UUID 名の同じコネクタがすり抜けるので、両方を書く。
# - SessionStart の hook: セッションが始まるたびに、環境変数の key を Claude の文脈に入れる。
#   このスクリプトの実行時には環境変数が空のことがあり（結果はキャッシュされる）、また Claude が
#   コマンドで環境変数を読むと、自動の権限チェックで止められることがあるため。
cat > ~/.claude/settings.json <<'JSON'
{
  "deniedMcpServers": [
    {"serverName": "claude.ai <そのコネクタの表示名>"},
    {"serverName": "<そのコネクタの UUID 名>"}
  ],
  "hooks": {
    "SessionStart": [
      {"hooks": [{"type": "command", "command": "printf 'コネクタ「GitHub relay」のツールの引数 upstream_key に渡す値: %s\\n' \"$GH_MCP_RELAY_KEY\""}]}
    ]
  }
}
JSON

cat > ~/.claude/CLAUDE.md <<'MD'
# 本流（upstream）への Issue・PR

本流 tksugimoto/pocket-ssh-agent への Issue・PR・コメントは、コネクタ「GitHub relay」のツールで行う。
どのツールを呼ぶときも、引数 upstream_key に、セッションの開始時に示された値を渡す。
fork へのコードの変更は、通常どおり git push で行う。
MD
