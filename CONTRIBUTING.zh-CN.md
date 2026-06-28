# 为 DFT AutoPilot 做贡献

[English](CONTRIBUTING.md) | **简体中文**

感谢你的关注！本文介绍项目的架构与约定。

## 仓库结构

```
dft-autopilot/
├── server/                      # MCP 服务器（以 dft-autopilot-mcp 之名发布到 npm）
│   ├── src/
│   │   ├── mcp-server.ts        # 入口（stdio MCP 服务器）
│   │   ├── config.ts            # 所有配置均来自环境变量
│   │   ├── compute/             # ComputeProvider 抽象层（BYO-HPC）
│   │   │   ├── provider.ts      #   接口 + 共享类型
│   │   │   ├── scnet-provider.ts
│   │   │   ├── slurm-ssh-provider.ts
│   │   │   ├── local-provider.ts
│   │   │   └── index.ts         #   getComputeProvider() 工厂
│   │   ├── infra/scnet-manager.ts
│   │   └── tools/               # MCP 工具（每个工具一个类，继承 DFTTool）
│   ├── knowledge/               # 随包内置的参考数据（SSSP、参数、教程）
│   ├── templates/               # QE 输入模板（.in.j2）
│   ├── server.json              # 官方 MCP Registry 元数据
│   └── manifest.json            # MCPB（Claude Desktop）打包清单
├── plugins/dft-autopilot/       # Claude Code 插件（技能 + 服务器）
│   ├── .claude-plugin/plugin.json
│   ├── .mcp.json
│   └── skills/dft-compute/SKILL.md
└── .claude-plugin/marketplace.json
```

## 构建与运行

```bash
cd server
npm install
npm run build      # tsc -> dist/
npm run typecheck  # tsc --noEmit
npm run dev        # tsx src/mcp-server.ts（本地开发）
```

## 新增算力后端

实现 `ComputeProvider` 接口（`server/src/compute/provider.ts`），并在 `getComputeProvider()` 工厂中注册。该接口的 10 个方法覆盖 提交 / 状态 / 下载 / 预览 / 列目录 / 取消——作业类工具只调用这个接口，绝不直接依赖某个具体后端。`slurm-ssh-provider.ts`（用系统 `ssh`/`scp` + `sbatch`/`squeue`/`sacct`/`scancel`）是很好的参考模板。

## 工具约定

- 每个工具都是继承 `DFTTool` 的类，需提供 `name`、`description`、`inputSchema` 和 `execute()`。工具保持单一职责。
- **`_reasons` 审计（重要）：** `create_qe_input` / `create_vasp_input` / `create_gaussian_input` 要求传入一个 `_reasons` 映射，为每个物理参数（截断能、U 值、展宽、磁性……）说明依据。这是核心设计原则——每个参数选择都必须可追溯到来源。**请勿削弱或绕过它。**
- stdout **只**承载 JSON-RPC；所有日志一律走 stderr（`mcp-server.ts` 劫持了 `console.log`）。请保持这一约定。

## 代码约定

- TypeScript `strict`；ESM（`"type": "module"`，import 用 `.js` 后缀）。
- 提交的代码中**不得**包含任何密钥、账号、IP 或个人路径——一切敏感信息都来自环境变量。CI / 评审应拒绝硬编码的凭据。
- 注释风格与密度与周围代码保持一致。

## Pull Request

- 提交前先跑 `npm run typecheck`。
- 说明你改了什么、怎么测的（哪个后端、哪个引擎）。
- 提交贡献即表示你同意你的贡献以 Apache-2.0 许可。
