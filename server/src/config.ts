/**
 * DFT AutoPilot — 全局配置
 *
 * 所有配置通过环境变量提供（开发时可放 .env）。本仓库不内置任何超算账号、
 * 密钥或集群默认值 —— BYO-HPC：用户用自己的算力后端配置（见 .env.example）。
 */

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 开发时从包内 .env 读取；生产部署用真实环境变量
config({ path: resolve(__dirname, "../.env") });

export interface AppConfig {
  appEnv: string;

  // LLM 配置（OpenAI 兼容格式，供需要 LLM 的工具使用）
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  llmMaxTokens: number;
  llmTemperature: number;

  // 路径配置
  pseudoDir: string;
  workspaceDir: string;
  knowledgeDir: string;
  templatesDir: string;

  // QE 本地执行配置
  qeCondaEnv: string;
  qeCondaInit: string;
  qeTimeoutSeconds: number;
  qeNumCores: number;

  /** 计算后端：scnet（国家超算互联网）| slurm（通用 Slurm over SSH）| local（本机） */
  computeProvider: "scnet" | "slurm" | "local";

  // --- SCNet 国家超算互联网（用自己的 SCNet 账号填写）---
  scnetUser: string;
  scnetAccessKey: string;
  scnetSecretKey: string;
  scnetClusterName: string;
  scnetClusterId: string;
  scnetHpcUrl: string;
  scnetEfileUrl: string;
  scnetHomePath: string;
  scnetQueue: string;
  scnetSchedulerId: string;
  scnetQePath: string;
  scnetQeEnvScript: string;
  scnetPseudoDir: string;
  scnetVaspEnvScript: string;
  scnetPotcarDir: string;
  scnetGaussianEnvScript: string;
  /** 跨作业共享 scratch 目录（分步计算 outdir 共享） */
  scnetScratchDir: string;
  scnetMaxCores: number;
  /** 单作业最大核数（>每节点核数时自动跨节点 MPI） */
  scnetMaxCoresPerJob: number;

  // --- Slurm over SSH（通用 HPC 集群，自带账号 + 免密 SSH）---
  /** SSH 目标，如 "user@login.cluster.edu" 或 ~/.ssh/config 中的别名 */
  slurmHost: string;
  /** 远程用户名（用于 squeue -u；留空则用远程 $USER） */
  slurmUser: string;
  /** 远程作业根目录，如 "/scratch/$USER/dft-autopilot" */
  slurmRemoteBaseDir: string;
  /** Slurm 分区/队列 */
  slurmPartition: string;
  /** 可选 --account */
  slurmAccount: string;
  /** 加载引擎环境的 shell 命令，分号或换行分隔，如 "module load quantum-espresso/7.4" */
  slurmModules: string;
  /** 远程赝势目录（用于 QE 输入文件 pseudo_dir 重写；留空则不重写） */
  slurmPseudoDir: string;
  /** 远程 QE 可执行文件目录（留空则假定已在 PATH 中） */
  slurmQeBinDir: string;
  slurmMaxCoresPerNode: number;
  slurmWallTime: string;
  /** 透传给 ssh/scp 的附加选项（空格分隔，如 "-p 2222 -i ~/.ssh/hpc_key"） */
  slurmSshOpts: string;

  // 外部 API Key（学术文献 + 材料数据库）
  semanticScholarApiKey: string;
  mpApiKey: string;
  /** MP API 代理 URL（可选，绕过部分网络环境的访问限制） */
  mpProxyUrl: string;
}

// 包根目录（dist/ 或 src/ 的上一级）—— knowledge/ 与 templates/ 随包分发
const BACKEND_DIR = resolve(__dirname, "..");

function getConfig(): AppConfig {
  return {
    appEnv: process.env.APP_ENV ?? "production",

    llmApiKey: process.env.LLM_API_KEY ?? "",
    llmBaseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    llmModel: process.env.LLM_MODEL_NAME ?? "gpt-4o",
    llmMaxTokens: parseInt(process.env.LLM_MAX_TOKENS ?? "4096", 10),
    llmTemperature: parseFloat(process.env.LLM_TEMPERATURE ?? "0.1"),

    // 工作区/赝势默认落在当前工作目录下，可用环境变量覆盖
    pseudoDir: process.env.QE_PSEUDO_DIR ?? resolve(process.cwd(), "pseudo"),
    workspaceDir: process.env.QE_WORK_DIR ?? resolve(process.cwd(), "workspace"),
    knowledgeDir: resolve(BACKEND_DIR, "knowledge"),
    templatesDir: resolve(BACKEND_DIR, "templates"),

    qeCondaEnv: process.env.QE_CONDA_ENV ?? "qe",
    qeCondaInit: process.env.QE_CONDA_INIT ?? "~/miniforge3/etc/profile.d/conda.sh",
    qeTimeoutSeconds: parseInt(process.env.QE_TIMEOUT_SECONDS ?? "86400", 10),
    qeNumCores: parseInt(process.env.QE_NUM_CORES ?? "16", 10),

    computeProvider: (process.env.COMPUTE_PROVIDER as "scnet" | "slurm" | "local") ?? "scnet",

    // SCNet（无内置默认值，全部来自用户自己的账号）
    scnetUser: process.env.SCNET_USER ?? "",
    scnetAccessKey: process.env.SCNET_ACCESS_KEY ?? "",
    scnetSecretKey: process.env.SCNET_SECRET_KEY ?? "",
    scnetClusterName: process.env.SCNET_CLUSTER_NAME ?? "",
    scnetClusterId: process.env.SCNET_CLUSTER_ID ?? "",
    scnetHpcUrl: process.env.SCNET_HPC_URL ?? "",
    scnetEfileUrl: process.env.SCNET_EFILE_URL ?? "",
    scnetHomePath: process.env.SCNET_HOME_PATH ?? "",
    scnetQueue: process.env.SCNET_QUEUE ?? "",
    scnetSchedulerId: process.env.SCNET_SCHEDULER_ID ?? "",
    scnetQePath: process.env.SCNET_QE_PATH ?? "",
    scnetQeEnvScript: process.env.SCNET_QE_ENV_SCRIPT ?? "",
    scnetPseudoDir: process.env.SCNET_PSEUDO_DIR ?? "",
    scnetVaspEnvScript: process.env.SCNET_VASP_ENV_SCRIPT ?? "",
    scnetPotcarDir: process.env.SCNET_POTCAR_DIR ?? "",
    scnetGaussianEnvScript: process.env.SCNET_GAUSSIAN_ENV_SCRIPT ?? "",
    scnetScratchDir: process.env.SCNET_SCRATCH_DIR ?? "",
    scnetMaxCores: parseInt(process.env.SCNET_MAX_CORES ?? "64", 10),
    scnetMaxCoresPerJob: parseInt(process.env.SCNET_MAX_CORES_PER_JOB ?? "256", 10),

    // Slurm over SSH
    slurmHost: process.env.SLURM_HOST ?? "",
    slurmUser: process.env.SLURM_USER ?? "",
    slurmRemoteBaseDir: process.env.SLURM_REMOTE_BASE_DIR ?? "",
    slurmPartition: process.env.SLURM_PARTITION ?? "",
    slurmAccount: process.env.SLURM_ACCOUNT ?? "",
    slurmModules: process.env.SLURM_MODULES ?? "",
    slurmPseudoDir: process.env.SLURM_PSEUDO_DIR ?? "",
    slurmQeBinDir: process.env.SLURM_QE_BIN_DIR ?? "",
    slurmMaxCoresPerNode: parseInt(process.env.SLURM_MAX_CORES_PER_NODE ?? "64", 10),
    slurmWallTime: process.env.SLURM_WALL_TIME ?? "24:00:00",
    slurmSshOpts: process.env.SLURM_SSH_OPTS ?? "",

    semanticScholarApiKey: process.env.SEMANTIC_SCHOLAR_API_KEY ?? "",
    mpApiKey: process.env.MP_API_KEY ?? "",
    mpProxyUrl: process.env.MP_PROXY_URL ?? "",
  };
}

/** 全局配置单例 */
export const appConfig = getConfig();
