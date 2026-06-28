# DFT AutoPilot

[English](README.md) | **简体中文**

> 在对话客户端里运行第一性原理 DFT 计算（Quantum ESPRESSO · VASP · Gaussian）——跑在**你自己的** HPC 上。一个 MCP 服务器 + 一个 Claude 技能，把*"算一下 NiO 加 Hubbard U 的态密度"*变成完整的 **建模 → 计算 → 分析 → 报告** 工作流。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-orange.svg)](https://modelcontextprotocol.io)

---

## ⚠️ 免责声明与责任（请务必阅读）

DFT AutoPilot 只会用**你自己提供的凭据和算力额度**来编排计算。使用本工具即表示你理解并同意：

- **作业跑在你自己的账号 / HPC 额度上，费用与风险由你自行承担。** 一切算力费用、资源占用、作业行为以及产生的数据，均由你独自负责。
- **你需自行遵守算力提供方的服务条款**（如你所在的超算中心、SCNet 或机构集群），以及你所用 DFT 引擎的许可协议（Quantum ESPRESSO 为 GPL；**VASP 和 Gaussian 为商业软件，需你自备有效 license**）。
- 本软件按 Apache-2.0 许可，以 **"现状"（AS IS）提供，不附带任何形式的担保**。对于算力费用、额度浪费、数据丢失、计算失败或结果错误，以及由使用本软件引发的任何损害，作者**概不负责**（见 LICENSE 第 7–8 条）。
- 维护者**不运营任何托管服务**，也**无法访问**你的任何账号或数据。本项目**与 SCNet、Quantum ESPRESSO 项目、VASP、Gaussian 均无隶属关系，亦未获其背书**。

科学结果必须由具备资质的研究者复核。自动化 Agent 也会犯物理错误——请务必审查方案和数据。

---

## 功能特性

- **三种引擎**：Quantum ESPRESSO、VASP、Gaussian 16 —— 每种都覆盖输入生成、作业提交与结果解析。
- **BYO-HPC 后端**：`local`（本机）· `slurm`（任意 Slurm 集群，经 SSH）· `scnet`（国家超算互联网，用你自己的账号）。
- **19 个 MCP 工具**，覆盖完整流水线（见下表）。
- **`dft-compute` 技能**：一个自治"计算化学家"工作流，强制"先方案后计算"的审查环节，并对每个参数做 `_reasons` 审计。
- **内置知识库**：SSSP 截断能推荐、DFT+U 指南、QE/VASP 参数手册、排错笔记。

### 工具一览

| 分组 | 工具 |
|------|------|
| QE | `create_qe_input`、`extract_dft_results`、`lookup_pseudopotential`、`lookup_hubbard_u`、`import_structure` |
| VASP | `create_vasp_input`、`extract_vasp_results` |
| Gaussian | `create_gaussian_input`、`extract_gaussian_results` |
| 作业（后端无关） | `submit_compute_job`、`check_job_status`、`download_job_results`、`preview_remote_file`、`cancel_job` |
| 辅助 | `run_pymatgen`、`plot_chart`、`write_report`、`search_literature`、`search_materials` |

---

## 前置条件

- **Node.js ≥ 18**（MCP 服务器基于 Node/TypeScript）。
- 使用 `run_pymatgen`、`import_structure` 及结构处理功能时：需 **Python 3** 并安装 `pymatgen` 与 `ase`，且在 `PATH` 中可用。
- 你所选后端上的 **DFT 引擎本身**（QE / VASP / Gaussian —— 由你自行获取并授权）。
- 使用 `slurm` 时：到集群登录节点的**免密 SSH**。使用 `scnet` 时：你自己的 **SCNet 账号**（AccessKey/SecretKey）。

> MCP 安装过程**不会**帮你安装 Python、引擎或赝势——这些都需你自备。

---

## 安装

### A. Claude Code 插件（推荐——技能 + 服务器一体）

```
/plugin marketplace add The66user/dft-autopilot-mcp
/plugin install dft-autopilot@dft-autopilot-marketplace
```

安装时会提示你做配置（算力后端、API 密钥）；密钥保存在你操作系统的钥匙串（keychain）中。

### B. 通过 npm 接入任意 MCP 客户端（如 Claude Code CLI）

```bash
claude mcp add --env COMPUTE_PROVIDER=local --env MP_API_KEY=YOUR_KEY \
  dft-autopilot -- npx -y dft-autopilot-mcp
```

### C. Claude Desktop（`claude_desktop_config.json`）

```jsonc
{
  "mcpServers": {
    "dft-autopilot": {
      "command": "npx",
      "args": ["-y", "dft-autopilot-mcp"],
      "env": {
        "COMPUTE_PROVIDER": "local",
        "MP_API_KEY": "YOUR_MATERIALS_PROJECT_KEY"
      }
    }
  }
}
```

GitHub Releases 上还附带一个一键 **`.mcpb`** 安装包（Claude Desktop → 设置 → Extensions）。注意：`.mcpb` 只打包了 Node 服务器——Python/pymatgen 和 DFT 引擎仍需事先装在你机器上。

---

## 配置算力后端

设置 `COMPUTE_PROVIDER` 及对应的变量（完整列表见 [`server/.env.example`](server/.env.example)）。

### `local`
在本机运行，需要本地已安装相应引擎。
```
COMPUTE_PROVIDER=local
```

### `slurm` —— 任意 Slurm 集群（经 SSH）
```
COMPUTE_PROVIDER=slurm
SLURM_HOST=you@login.cluster.edu        # 或 ~/.ssh/config 中的别名；需免密 SSH
SLURM_REMOTE_BASE_DIR=/scratch/you/dft-autopilot
SLURM_PARTITION=cpu
SLURM_MODULES=module load quantum-espresso/7.4
SLURM_PSEUDO_DIR=/scratch/you/pseudo    # 可选：重写 QE 的 pseudo_dir
```

### `scnet` —— 国家超算互联网（用你自己的账号）
```
COMPUTE_PROVIDER=scnet
SCNET_USER=...
SCNET_ACCESS_KEY=...
SCNET_SECRET_KEY=...
SCNET_CLUSTER_ID=...
SCNET_HPC_URL=...
SCNET_EFILE_URL=...
# ……完整变量集见 .env.example
```

> **本仓库不内置任何凭据。** 无论选哪个后端，都跑在*你自己*的账号下。

---

## 使用

向你的客户端提需求，例如：

> "用 Quantum ESPRESSO 弛豫体相 Si，然后算它的能带结构和态密度，最后写一份简短报告。"

`dft-compute` 技能会先调研参数（SSSP 截断能、Hubbard U、文献），把方案交你审批，然后再生成输入、提交到你的后端、监控、下载、分析并出报告。

---

## 许可

Apache-2.0 —— 见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE.zh-CN)。第三方数据/引擎的归属说明（SSSP、QE/VASP/Gaussian）见 NOTICE。

个人与学术用途免费。如需商业支持、托管/端到端的 DFT 服务，或希望合作，请见仓库主页中的联系方式。

## 贡献与安全

见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md) 与 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。安装任何插件都意味着运行会用你的凭据连接你 HPC 的代码——请审查源码，只配置你信任的后端。
