# Dev Container

[tksugimoto/my-devcontainer](https://github.com/tksugimoto/my-devcontainer) を git submodule
(`.devcontainer/my-devcontainer`) として取り込み、その Feature を使っています。

- Node.js 24 / GitHub CLI / Claude Code
- my-devcontainer のカスタム Feature: `claude-code-bell`, `claude-code-statusline`,
  `claude-config-volume`, `node-modules-volume`, `gh-auth-volume`

### ボリューム名

my-devcontainer の Feature が宣言するボリューム名は、`devcontainer.json` の `mounts` で同じ `target` を指定して
このプロジェクト用の名前に上書きしています (`mounts` は `target` ごとに後勝ちで、`devcontainer.json` は Feature より後に適用されます)。

| target | Feature の既定 | このプロジェクト |
|---|---|---|
| `/home/vscode/.claude` | `claude-config-${devcontainerId}` | `gh-mcp-relay-claude-config-${devcontainerId}` |
| `/home/vscode/.config/gh` | `my-devcontainer-gh-auth` | `gh-mcp-relay-gh-auth` |

`gh-auth-volume` の既定名のままだと、my-devcontainer を使う他のプロジェクトと gh のトークンを共有してしまうためです。
`gh-mcp-relay-gh-auth` は固定名なので、このリポジトリの worktree 同士では共有します。

## 使い方

submodule を含めて取得してから、VS Code で「Dev Containers: Reopen in Container」を実行します。

```bash
git clone --recurse-submodules https://github.com/tksugimoto-ai/gh-mcp-relay.git
# 既に clone 済みの場合
git submodule update --init
```

初回のみ、別のターミナルで `gh auth login` と `gh auth setup-git` を実行してください。

## my-devcontainer の更新

```bash
git submodule update --remote .devcontainer/my-devcontainer
```

`devcontainer-lock.json` は Dev Container のビルド (VS Code の Rebuild や `devcontainer up`) のたびに
`devcontainer.json` に合わせて書き直されます。Feature を足す・外すとエントリも自動で増減するので、
再作成後に差分が出ていればそのままコミットしてください。

ロック済みの Feature のバージョンは再作成しても上がりません。上げるときは次を実行してコミットします。

```bash
npx @devcontainers/cli upgrade --workspace-folder .
```
