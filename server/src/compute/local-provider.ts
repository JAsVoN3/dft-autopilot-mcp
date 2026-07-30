/**
 * LocalProvider — 本地机器适配器
 *
 * 在运行 MCP server 的同一台机器上直接执行 DFT 命令（无需超算/SSH）。
 * 适合：小体系测试、自带工作站、CI 烟雾测试，或在已 SSH 进登录节点的环境里直接跑。
 *
 * 前提：本机已安装对应引擎（pw.x / vasp_std / g16）并在 PATH 中（或命令里写绝对路径），
 * 且通过 bash 执行（Linux / macOS / WSL）。本 provider 不做远程传输——
 * remoteDir 即 localDir，downloadResults 仅收集本地已产出的文件。
 *
 * PATCH: 任务注册表持久化到 DFT_JOBS_DB（默认 ~/.dft-autopilot/jobs.json），
 *        服务重启后仍可 check_job_status / download_job_results（修复 in-memory map 丢失）。
 */

import { spawn, type ChildProcess } from "child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  openSync,
  closeSync,
  mkdirSync,
  writeFileSync,
} from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type {
  ComputeProvider,
  ComputeJobParams,
  ComputeTask,
  ComputeJobStatus,
  ComputeJobBrief,
  RemoteDirEntry,
  PreviewResult,
} from "./provider.js";

/** 本地作业运行记录 */
interface LocalJob {
  task: ComputeTask;
  child: ChildProcess | null;
  done: boolean;
  exitCode: number | null;
}

/** 预览分页每次最多返回的字节数 */
const PREVIEW_CHUNK = 1_000_000;

/** 计算产出文件匹配（与 SCNet 下载规则保持一致的简化版） */
const OUTPUT_EXTENSIONS = [
  ".out", ".dat", ".gnu", ".gp", ".dos", ".dyn", ".freq", ".fc",
  ".modes", ".cube", ".xml", ".log", ".chk", ".fchk",
];
const VASP_OUTPUTS = new Set([
  "OUTCAR", "OSZICAR", "CONTCAR", "EIGENVAL", "DOSCAR",
  "PROCAR", "CHGCAR", "vasprun.xml", "XDATCAR",
]);

function isOutputFile(name: string): boolean {
  if (VASP_OUTPUTS.has(name)) return true;
  if (name.includes("pdos")) return true;
  if (name === "ACF.dat") return true;
  return OUTPUT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export class LocalProvider implements ComputeProvider {
  readonly name = "local";

  private jobs = new Map<string, LocalJob>();

  /** 持久化任务注册表路径（可用 DFT_JOBS_DB 覆盖） */
  private jobsFile = process.env.DFT_JOBS_DB ?? join(homedir(), ".dft-autopilot", "jobs.json");

  constructor() {
    this.restore();
  }

  configure(): boolean {
    // 本地后端无需凭据，始终可用
    return true;
  }

  isConfigured(): boolean {
    return true;
  }

  getClusterName(): string {
    return "local";
  }

  getTask(taskId: string): ComputeTask | undefined {
    return this.jobs.get(taskId)?.task;
  }

  async submitJob(params: ComputeJobParams): Promise<ComputeTask> {
    const { localDir, inputFile, executable, taskId } = params;
    if (!existsSync(localDir)) {
      throw new Error(`本地工作目录不存在: ${localDir}`);
    }

    // 推导输出文件名（与 SCNet 一致：VASP→OUTCAR，Gaussian→.log，QE→.out）
    const isVasp = ["vasp_std", "vasp_gam", "vasp_ncl"].some((v) =>
      executable.includes(v),
    );
    const isGaussian = inputFile.endsWith(".gjf") || inputFile.endsWith(".com");
    const outputFile = isVasp
      ? "OUTCAR"
      : isGaussian
        ? inputFile.replace(/\.(gjf|com)$/i, ".log")
        : inputFile.replace(/\.in$/i, ".out");

    // 构造命令：优先用 Agent 原始命令，否则按引擎拼一条标准命令
    let cmd = params.rawCommand;
    if (!cmd) {
      const nproc = params.nproc ?? 4;
      if (isVasp) {
        cmd = `mpirun -np ${nproc} ${executable}`;
      } else if (isGaussian) {
        cmd = `${executable} < ${inputFile} > ${outputFile} 2>&1`;
      } else {
        cmd = `mpirun -np ${nproc} ${executable} -i ${inputFile} > ${outputFile} 2>&1`;
      }
    }
    // 去掉命令开头的 `cd X &&` 前缀（已在 localDir 中运行）
    cmd = cmd.replace(/^cd\s+\S+\s*(?:&&|;)\s*/, "");

    const nprocMatch = /-np\s+(\d+)/.exec(cmd);
    const coresUsed = params.nproc ?? (nprocMatch ? parseInt(nprocMatch[1], 10) : 1);

    // 输出重定向到日志文件，便于事后查看
    const logPath = join(localDir, `local_run_${taskId}.log`);
    const logFd = openSync(logPath, "a");

    const child = spawn("bash", ["-lc", cmd], {
      cwd: localDir,
      stdio: ["ignore", logFd, logFd],
    });
    // spawn 接管 fd 后即可关闭本地句柄
    child.on("spawn", () => {
      try { closeSync(logFd); } catch { /* 已被子进程持有 */ }
    });

    const task: ComputeTask = {
      taskId,
      jobId: String(child.pid ?? taskId),
      remoteDir: localDir, // 本地：remoteDir 即 localDir
      localDir,
      command: cmd,
      coresUsed,
      startedAt: Date.now(),
      outputFile,
      scriptPath: logPath,
    };

    const record: LocalJob = { task, child, done: false, exitCode: null };
    child.on("exit", (code) => {
      record.done = true;
      record.exitCode = code;
      this.persist();
    });
    child.on("error", () => {
      record.done = true;
      record.exitCode = record.exitCode ?? 1;
      this.persist();
    });

    this.jobs.set(taskId, record);
    this.persist();
    return task;
  }

  async listJobs(limit: number): Promise<ComputeJobBrief[]> {
    return Array.from(this.jobs.values())
      .slice(-limit)
      .reverse()
      .map((j) => ({
        jobId: j.task.jobId,
        status: this.statusCode(j),
        jobName: j.task.taskId,
      }));
  }

  async getJobStatus(jobId: string): Promise<ComputeJobStatus> {
    const job = this.findByJobId(jobId);
    if (!job) {
      return { jobId, status: "unknown", isCompleted: false, isRunning: false };
    }
    // PATCH: 无状态客户端(如 mcp-caller)每次调用后即销毁 server, 子进程 exit
    // 事件可能未触发, jobs.json 残留 done=false → 误报 statR(运行中)。
    // 此处对"无 child 句柄且未完成"的作业做存活探测与状态对账。
    this.reconcileJob(job);
    const status = this.statusCode(job);
    return {
      jobId,
      status,
      isCompleted: status === "statC",
      isRunning: status === "statR",
      jobName: job.task.taskId,
      cores: job.task.coresUsed,
      reason: status === "statE"
        ? (job.exitCode === null ? "进程已结束(退出码未知)" : `退出码 ${job.exitCode}`)
        : undefined,
    };
  }

  /** 对账: 若作业无 live child 句柄且未标记完成, 探测 PID 是否存活;
   *  PID 已死则从输出文件推断退出码并标记完成, 修复 statR 残留。 */
  private reconcileJob(job: LocalJob): void {
    if (job.done) return;
    if (job.child) return; // 仍有句柄: exit 事件会更新 done, 无需对账
    const pid = parseInt(job.task?.jobId, 10);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // 不发信号, 仅探测存活
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) return; // 进程确实仍在运行
    // PID 已死: 从输出文件推断退出码
    let exitCode: number | null = null;
    try {
      const outName = job.task.outputFile ?? "scf.out";
      const outPath = join(job.task.localDir, outName);
      if (existsSync(outPath)) {
        const txt = readFileSync(outPath, "utf-8");
        if (/JOB DONE\./i.test(txt)) {
          exitCode = 0;
        } else if (/exited on signal|MPI_ABORT|Error in routine|buffer overflow|stopping \.\.\.|SIGABRT|Segmentation fault|forrtl: error/i.test(txt)) {
          exitCode = 1;
        }
      }
    } catch { /* best-effort */ }
    job.done = true;
    job.exitCode = exitCode; // null → 未知, statusCode 视为 statE
    this.persist();
  }

  async downloadResults(
    task: ComputeTask,
    onProgress?: (msg: string) => void,
  ): Promise<string[]> {
    // 本地：文件已在 localDir，仅收集产出文件清单
    const collected: string[] = [];
    try {
      for (const name of readdirSync(task.localDir)) {
        const full = join(task.localDir, name);
        if (statSync(full).isFile() && isOutputFile(name)) {
          collected.push(name);
        }
      }
    } catch {
      if (task.outputFile && existsSync(join(task.localDir, task.outputFile))) {
        collected.push(task.outputFile);
      }
    }
    onProgress?.(`📥 本地产出 ${collected.length} 个文件（无需下载）`);
    return collected;
  }

  async previewFile(remotePath: string, startIndex: number): Promise<PreviewResult> {
    if (!existsSync(remotePath)) {
      return { content: "", endIndex: startIndex, hasNext: false };
    }
    const buf = readFileSync(remotePath);
    const start = Math.max(0, Math.min(startIndex, buf.length));
    const end = Math.min(buf.length, start + PREVIEW_CHUNK);
    return {
      content: buf.subarray(start, end).toString("utf-8"),
      endIndex: end,
      hasNext: end < buf.length,
    };
  }

  async listRemoteDir(remotePath: string): Promise<RemoteDirEntry[]> {
    if (!existsSync(remotePath)) return [];
    return readdirSync(remotePath).map((name) => {
      const st = statSync(join(remotePath, name));
      return {
        name,
        size: st.size,
        lastModifiedTime: st.mtime.toISOString().replace("T", " ").slice(0, 19),
        isDirectory: st.isDirectory(),
      };
    });
  }

  async cancelJob(jobId: string): Promise<{ success: boolean; message: string }> {
    const job = this.findByJobId(jobId);
    if (!job) return { success: false, message: `未找到本地作业 ${jobId}` };
    if (job.done) return { success: true, message: "作业已结束" };
    if (!job.child) {
      return { success: false, message: `作业句柄已丢失（服务重启后无法终止，请手动 kill pid=${jobId}）` };
    }
    try {
      job.child.kill("SIGTERM");
      return { success: true, message: `已发送终止信号给 pid=${jobId}` };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  // ---- 内部辅助 ----

  private statusCode(job: LocalJob): string {
    if (!job.done) return "statR";
    return job.exitCode === 0 ? "statC" : "statE";
  }

  private findByJobId(jobId: string): LocalJob | undefined {
    for (const job of this.jobs.values()) {
      if (job.task.jobId === jobId) return job;
    }
    return undefined;
  }

  /** 将任务注册表快照写入磁盘（best-effort） */
  private persist(): void {
    try {
      const snapshot = Array.from(this.jobs.entries()).map(([id, j]) => ({
        taskId: id,
        task: j.task,
        done: j.done,
        exitCode: j.exitCode,
      }));
      mkdirSync(dirname(this.jobsFile), { recursive: true });
      writeFileSync(this.jobsFile, JSON.stringify(snapshot, null, 2));
    } catch { /* best-effort：持久化失败不影响作业运行 */ }
  }

  /** 启动时从磁盘恢复任务注册表（重启后 task_id 仍可查询/下载） */
  private restore(): void {
    try {
      if (!existsSync(this.jobsFile)) return;
      const arr = JSON.parse(readFileSync(this.jobsFile, "utf-8")) as Array<{
        taskId: string;
        task: ComputeTask;
        done?: boolean;
        exitCode?: number | null;
      }>;
      for (const e of arr) {
        // 重启后丢失子进程句柄；child 置 null，cancelJob 会安全拒绝
        this.jobs.set(e.taskId, {
          task: e.task,
          child: null,
          done: e.done ?? true,
          exitCode: e.exitCode ?? 0,
        });
      }
    } catch { /* best-effort：恢复失败不阻断启动 */ }
  }
}
