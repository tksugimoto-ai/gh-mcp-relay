# cloud 環境のセットアップスクリプトの例（pocket-ssh-agent 用の環境）。
# 環境変数 UPSTREAM_KEY を環境の設定に入れておくこと。
mkdir -p ~/.claude

# 中継を通らない GitHub のコネクタがあれば見えなくする（任意。名前は /mcp か ListConnectors で確認する）。
# 表示名だけだと、UUID 名の同じコネクタがすり抜けるので、両方を書く。
cat > ~/.claude/settings.json <<'JSON'
{"deniedMcpServers":[
  {"serverName":"claude.ai <そのコネクタの表示名>"},
  {"serverName":"<そのコネクタの UUID 名>"}
]}
JSON

# key の値をメモリに直接書く。Claude が Bash で環境変数を読まずに済むようにするため。
cat > ~/.claude/CLAUDE.md <<MD
# 本流（upstream）への Issue・PR

本流 tksugimoto/pocket-ssh-agent への Issue・PR・コメントは、コネクタ「GitHub relay」のツールで行う。
どのツールを呼ぶときも、引数 upstream_key に次の値を渡す: ${UPSTREAM_KEY}
fork へのコードの変更は、通常どおり git push で行う。
MD
