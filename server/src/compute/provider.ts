/**
 * ComputeProvider — 计算后端抽象层
 *
 * DFT AutoPilot 的作业提交/查询/下载逻辑通过此接口与具体的算力后端解耦，
 * 使工具层（submit_compute_job / check_job_status / ...）无需关心底层是
 * 国家超算互联网（SCNet）、通用 Slurm 集群（SSH）还是本地机器。
 *
 * BYO-HPC（Bring Your Own HPC）：用户通过 COMPUTE_PROVIDER 环境变量选择后端，
 * 并提供各自后端所需的连接配置（见 .env.example）。本仓库不绑定任何特定超算账号。
 *
 * 实现该接口的适配器：
 *   - ScnetProvider      （src/compute/scnet-provider.ts）  国家超算互联网 OpenAPI
 *   - SlurmSshProvider   （src/compute/slurm-ssh-provider.ts）通用 Slurm over SSH
 *   - LocalProvider      （src/compute/local-provider.ts）   本地机器直接运行
 */

// ---------------------------------------------------------------------------
// 共享类型（与后端无关的统一形态）
// ---------------------------------------------------------------------------

/** 作业提交参数 */
export interface ComputeJobParams {
  /** 本地工作目录（含输入文件） */
  localDir: string;
  /** 主输入文件名（QE: scf.in / VASP: INCAR / Gaussian: *.gjf） */
  inputFile: string;
  /** 可执行文件（pw.x / vasp_std / g16 等） */
  executable: string;
  /** 本地任务 ID（8 位 hex） */
  taskId: string;
  /** Agent 指定的并行核数（优先于自动计算） */
  nproc?: number;
  /** Agent 原始命令字符串，支持多命令链（&& / ;） */
  rawCommand?: string;
  /** 会话 ID，同一会话内的作业共享 outdir（分步计算支持） */
  sessionId?: string;
}

/** 已提交的计算任务 */
export interface ComputeTask {
  /** 本地任务 ID */
  taskId: string;
  /** 后端作业 ID（SCNet jobId / Slurm jobid / 本地 pid） */
  jobId: string;
  /** 远程（或本地）工作目录 */
  remoteDir: string;
  /** 本地工作目录 */
  localDir: string;
  /** 执行的命令 */
  command: string;
  /** 使用的核数 */
  coresUsed: number;
  /** 提交时间戳（ms） */
  startedAt: number;
  /** 主输出文件名 */
  outputFile?: string;
  /** 远程作业脚本路径 */
  scriptPath?: string;
}

/** 作业状态 */
export interface ComputeJobStatus {
  jobId: string;
  /** 后端原始状态码（statR / statC / RUNNING / COMPLETED 等） */
  status: string;
  isCompleted: boolean;
  isRunning: boolean;
  jobName?: string;
  queue?: string;
  cores?: number;
  node?: string;
  startTime?: string;
  runTime?: string;
  workDir?: string;
  reason?: string;
}

/** 作业列表条目 */
export interface ComputeJobBrief {
  jobId: string;
  status: string;
  jobName: string;
  queue?: string;
}

/** 远程目录条目 */
export interface RemoteDirEntry {
  name: string;
  size: number;
  lastModifiedTime: string;
  isDirectory: boolean;
}

/** 文件预览分页结果 */
export interface PreviewResult {
  content: string;
  /** 已读到的字节偏移（下一页起点） */
  endIndex: number;
  /** 是否还有后续内容 */
  hasNext: boolean;
}

// ---------------------------------------------------------------------------
// ComputeProvider 接口
// ---------------------------------------------------------------------------

export interface ComputeProvider {
  /** 后端标识：scnet | slurm | local */
  readonly name: string;

  /**
   * 从配置初始化后端连接。
   * @returns 是否成功配置（凭据/连接信息齐全）。未配置时作业提交类工具应给出友好提示而非崩溃。
   */
  configure(): boolean;

  /** 是否已就绪可提交作业 */
  isConfigured(): boolean;

  /** 人类可读的集群/后端名称（用于展示） */
  getClusterName(): string;

  /** 取本地记录的任务（MCP 重启后可能丢失，返回 undefined） */
  getTask(taskId: string): ComputeTask | undefined;

  /** 提交计算作业 */
  submitJob(params: ComputeJobParams): Promise<ComputeTask>;

  /** 列出最近作业 */
  listJobs(limit: number): Promise<ComputeJobBrief[]>;

  /** 查询单个作业状态 */
  getJobStatus(jobId: string): Promise<ComputeJobStatus>;

  /** 下载（或收集）计算产出到本地工作目录，返回文件名列表 */
  downloadResults(
    task: ComputeTask,
    onProgress?: (msg: string) => void,
    opts?: { includeSubdirs?: boolean },
  ): Promise<string[]>;

  /** 分页预览远程（或本地）文件，startIndex 为字节偏移 */
  previewFile(remotePath: string, startIndex: number): Promise<PreviewResult>;

  /** 列出远程（或本地）目录 */
  listRemoteDir(remotePath: string): Promise<RemoteDirEntry[]>;

  /** 取消作业 */
  cancelJob(jobId: string): Promise<{ success: boolean; message: string }>;
}
