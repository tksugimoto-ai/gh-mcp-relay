# cloud 環境のセットアップスクリプトの例（pocket-ssh-agent 用の環境）。
# 環境変数 UPSTREAM_KEY を環境の設定に入れておくこと。
mkdir -p ~/.claude

# ほかの環境用のコネクタを見えなくする（任意。名前は /mcp か ListConnectors で確認する）。
cat > ~/.claude/settings.json <<'JSON'
{"deniedMcpServers":[
  {"serverName":"claude.ai GitHub booking-app"},
  {"serverName":"fd72c50c-ef3b-4309-9d3c-1c2fc8a1d2f7"}
]}
JSON

# key の値をメモリに直接書く。Claude が Bash で環境変数を読まずに済むようにするため。
cat > ~/.claude/CLAUDE.md <<MD
# 本流（upstream）への Issue・PR

本流 tksugimoto/pocket-ssh-agent への Issue・PR・コメントは、コネクタ「GitHub pocket」のツールで行う。
どのツールを呼ぶときも、引数 upstream_key に次の値を渡す: ${UPSTREAM_KEY}
fork へのコードの変更は、通常どおり git push で行う。
MD
