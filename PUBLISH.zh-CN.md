# 发布清单

[English](PUBLISH.md) | **简体中文**

本仓库已在本地组装并提交，但**尚未发布**。等你准备好时，按以下步骤操作（或者直接让 Claude 帮你跑——只有*认证*相关的步骤需要你本人完成）。

> 下文所有出现 `<USER>` 的地方都替换成你的 GitHub 用户名，并确定一个最终的 npm 包名（默认 `dft-autopilot-mcp`；或带 scope 的 `@<scope>/dft-autopilot-mcp`）。

## 0. 填好占位符

> 本仓库已填为 `The66user`。下面的步骤保留供你 fork 或改用户名时参考。

仓库里带着 `YOUR_GITHUB_USERNAME` 占位符，需全部替换。检测用 `grep -r`（不要用
`git grep`——新建的未跟踪文件如 `README.zh-CN.md` 用 `git grep` 搜不到）；`sed` 里
显式列出待替换文件，避免误伤本文档(PUBLISH)里的占位符说明：

```bash
cd /path/to/dft-autopilot-oss
files="server/package.json server/server.json server/manifest.json \
  plugins/dft-autopilot/.claude-plugin/plugin.json .claude-plugin/marketplace.json \
  README.md README.zh-CN.md"
sed -i 's/YOUR_GITHUB_USERNAME/<USER>/g' $files
# 复核（grep -r 才能扫到未跟踪文件）：除本文档说明外应无残留
grep -rl YOUR_GITHUB_USERNAME . --exclude-dir=node_modules --exclude-dir=.git
```

涉及文件：`server/package.json`、`server/server.json`、`server/manifest.json`、
`plugins/dft-autopilot/.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、
`README.md`、`README.zh-CN.md`。如果你选用带 scope 的 npm 包名，还要同步更新
`server/package.json` 里的 `name`、`server/server.json` 里的 `identifier`，以及
`plugins/dft-autopilot/.mcp.json` 里的 `npx` 参数。

## 1. GitHub CLI 认证（你本人做，一次即可）

```powershell
winget install --id GitHub.cli -e        # 若未安装 gh
gh auth login                            # 浏览器 / 设备码——只能你本人完成
```

## 2. 创建仓库（建议先建私有）

```bash
cd /path/to/dft-autopilot-oss
gh repo create dft-autopilot-mcp --private --source=. --remote=origin --push
```

到 github.com 上检查一遍（README、LICENSE、没有多余文件）。满意后：

```bash
gh repo edit <USER>/dft-autopilot-mcp --visibility public
```

## 3. npm 包（其它一切都指向它，是地基）

```bash
npm login                                # 你本人认证
cd server
npm install
npm run build
npm publish --access public              # 带 scope 的包名需要 --access public
```

验证：https://www.npmjs.com/package/dft-autopilot-mcp

## 4. Claude Code 插件 / marketplace（已在仓库内）

仓库公开后，用户即可这样安装：

```
/plugin marketplace add <USER>/dft-autopilot-mcp
/plugin install dft-autopilot@dft-autopilot-marketplace
```

## 5. MCPB 一键安装包（Claude Desktop）

```bash
npm install -g @anthropic-ai/mcpb
cd server
npm install --production                 # 把 node_modules 一并打进包里
npm run build
mcpb validate manifest.json
mcpb pack .                              # -> dft-autopilot.mcpb
```

把 `dft-autopilot.mcpb` 作为 GitHub Release 资产附上。（提醒：该安装包只含 Node 服务器——
pymatgen/ASE 和 DFT 引擎必须事先装在用户机器上。）

## 6. 官方 MCP Registry（便于被发现）

```bash
# 安装 mcp-publisher（见 https://modelcontextprotocol.io/registry/quickstart）
cd server
mcp-publisher login github                # GitHub 设备码；授权 io.github.<USER>/*
mcp-publisher publish                      # 读取 ./server.json
```

`server.json` 的 `name` 必须与 `package.json` 的 `mcpName` 一致（`io.github.<USER>/dft-autopilot-mcp`），
且在 GitHub 认证下必须以 `io.github.<USER>/` 开头。

## 7. 可选的曝光渠道

- 给 `punkpeye/awesome-mcp-servers` 提 PR（按字母序加一行）。
- 在 Glama / PulseMCP / Smithery 上认领条目（它们会抓取官方 registry）。

---

**只有第 1 步（`gh auth login`）、第 3 步（`npm login`）、第 6 步（`mcp-publisher login`）需要你本人**——
它们都是认证环节。其余都可以代你执行。
