#!/usr/bin/env node
/**
 * DFT AutoPilot — MCP Server 入口
 *
 * 将 DFT 计算工具链（QE / VASP / Gaussian 输入生成、结果解析、作业提交、
 * 文献/材料检索、绘图与报告）暴露为 MCP (Model Context Protocol) Server，
 * 供 Claude Desktop / Claude Code 等客户端通过 stdio 调用。
 *
 * 算力后端通过 COMPUTE_PROVIDER 选择：scnet | slurm | local（BYO-HPC）。
 */

// MCP 协议要求 stdout 只能传输 JSON-RPC 消息。
// 劫持 console.log → stderr，防止被导入模块的 console.log 污染 stdout。
console.log = (...args: unknown[]) => console.error(...args);

import { appConfig } from "./config.js";
import { getComputeProvider } from "./compute/index.js";
import { createDFTMcpServer, startStdioTransport } from "./mcp-tools-adapter.js";
import type { DFTTool } from "./tools/base.js";

// DFT 核心工具
import { CreateQEInputTool } from "./tools/create-qe-input.js";
import { ExtractDFTResultsTool } from "./tools/extract-dft-results.js";
import { LookupPseudopotentialTool } from "./tools/lookup-pseudopotential.js";
import { LookupHubbardUTool } from "./tools/lookup-hubbard-u.js";
import { ImportStructureTool } from "./tools/import-structure.js";

// VASP 工具
import { CreateVaspInputTool } from "./tools/create-vasp-input.js";
import { ExtractVaspResultsTool } from "./tools/extract-vasp-results.js";

// Gaussian 工具
import { CreateGaussianInputTool } from "./tools/create-gaussian-input.js";
import { ExtractGaussianResultsTool } from "./tools/extract-gaussian-results.js";

// 辅助工具
import { RunPymatgenTool } from "./tools/run-pymatgen.js";
import { PlotChartTool } from "./tools/plot-chart.js";
import { WriteReportTool } from "./tools/write-report.js";
import { SearchLiteratureTool } from "./tools/search-literature.js";
import { SearchMaterialsTool } from "./tools/search-materials.js";

// 作业管理（计算后端无关）
import { SubmitComputeJobTool } from "./tools/mcp/submit-compute-job.js";
import { CheckJobStatusTool } from "./tools/mcp/check-job-status.js";
import { DownloadJobResultsTool } from "./tools/mcp/download-job-results.js";
import { PreviewRemoteFileTool } from "./tools/mcp/preview-remote-file.js";
import { CancelJobTool } from "./tools/mcp/cancel-job.js";

async function main() {
  console.error("━".repeat(50));
  console.error("  DFT AutoPilot — MCP Server");
  console.error("━".repeat(50));
  console.error(`  计算后端: ${appConfig.computeProvider}`);
  console.error(`  工作目录: ${appConfig.workspaceDir}`);

  // 初始化计算后端（scnet / slurm / local）
  const provider = getComputeProvider();
  const ok = provider.configure();
  if (ok && provider.isConfigured()) {
    console.error(`  ✅ 算力后端就绪: ${provider.getClusterName()}`);
  } else {
    console.error(
      `  ⚠️ 算力后端 "${appConfig.computeProvider}" 未配置，作业提交类工具不可用` +
      `（输入生成 / 结果解析 / 检索仍可用）。请按 .env.example 填写对应后端的连接信息。`,
    );
  }

  console.error("━".repeat(50));

  const workspaceDir = appConfig.workspaceDir;

  const tools: DFTTool[] = [
    new CreateQEInputTool(),
    new ExtractDFTResultsTool(),
    new LookupPseudopotentialTool(),
    new LookupHubbardUTool(),
    new ImportStructureTool(),

    new CreateVaspInputTool(),
    new ExtractVaspResultsTool(),

    new CreateGaussianInputTool(),
    new ExtractGaussianResultsTool(),

    new RunPymatgenTool(),
    new PlotChartTool(),
    new WriteReportTool(),
    new SearchLiteratureTool(),
    new SearchMaterialsTool(),

    new SubmitComputeJobTool(),
    new CheckJobStatusTool(),
    new DownloadJobResultsTool(),
    new PreviewRemoteFileTool(),
    new CancelJobTool(),
  ];

  // 注入工作目录和审计目录
  for (const tool of tools) {
    tool.workspaceDir = workspaceDir;
    tool.auditDir = `${workspaceDir}/.audit`;
  }

  const server = createDFTMcpServer(tools);

  console.error(`\n  已注册 ${tools.length} 个工具`);
  console.error(`  工具列表: ${tools.map((t) => t.name).join(", ")}\n`);

  await startStdioTransport(server);
}

main().catch((err) => {
  console.error("❌ MCP Server 启动失败:", err);
  process.exit(1);
});
