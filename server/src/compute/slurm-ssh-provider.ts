/**
 * SlurmSshProvider — 通用 Slurm 集群适配器（over SSH）
 *
 * 通过系统 ssh / scp 把作业提交到任意运行 Slurm 调度器的 HPC 集群：
 *   - 提交：scp 上传输入 → 生成 sbatch 脚本 → ssh "sbatch"
 *   - 查询：ssh "squeue" / "sacct"
 *   - 下载：ssh "find" 列目录 → scp 回传产出
 *   - 预览：ssh "tail -c / head -c"（支持运行中作业 tail -f 式查看）
 *   - 取消：ssh "scancel"
 *
 * 前提（用户自备 = BYO-HPC）：
 *   1. 本机已装 ssh / scp，且对目标登录节点配置了**免密**（公钥已加入 authorized_keys，
 *      或在 ~/.ssh/config 配好别名）。本 provider 以 BatchMode 运行，不会交互输入密码。
 *   2. 远程集群使用 Slurm（sbatch/squeue/sacct/scancel）。
 *   3. 通过 SLURM_MODULES 提供加载 QE/VASP 等引擎的 shell 命令（如 module load）。
 *
 * 注意：本实现覆盖标准 Slurm + GNU coreutils 行为；不同站点的队列/模块/路径差异较大，
 * 首次使用请用一个小算例（如 Si scf）验证后再跑生产作业。
 */

import { execFile } from "child_process";
import { promisify } from "util";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { join, basename, dirname } from "path";
import { tmpdir } from "os";
import { appConfig } from "../config.js";
import type {
  ComputeProvider,
  ComputeJobParams,
  ComputeTask,
  ComputeJobStatus,
  ComputeJobBrief,
  RemoteDirEntry,
  PreviewResult,
} from "./provider.js";

const execFileAsync = promisify(execFile);

/** 单次预览返回的字节上限 */
const PREVIEW_CHUNK = 1_000_000;

/** Slurm 状态码 → 统一状态码映射 */
function mapSlurmState(state: string): { status: string; isCompleted: boolean; isRunning: boolean } {
  const s = state.toUpperCase().replace(/\+$/, "");
  if (s === "RUNNING") return { status: "statR", isCompleted: false, isRunning: true };
  if (s === "PENDING" || s === "CONFIGURING") return { status: "statPD", isCompleted: false, isRunning: false };
  if (s === "COMPLETING") return { status: "statCG", isCompleted: false, isRunning: true };
  if (s === "COMPLETED") return { status: "statC", isCompleted: true, isRunning: false };
  if (["FAILED", "TIMEOUT", "CANCELLED", "NODE_FAIL", "OUT_OF_MEMORY", "BOOT_FAIL", "DEADLINE", "PREEMPTED"].includes(s)) {
    return { status: "statE", isCompleted: false, isRunning: false };
  }
  return { status: s.toLowerCase() || "unknown", isCompleted: false, isRunning: false };
}

/** 计算产出文件匹配 */
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

export class SlurmSshProvider implements ComputeProvider {
  readonly name = "slurm";

  private host = "";
  private baseDir = "";
  private tasks = new Map<string, ComputeTask>();

  configure(): boolean {
    this.host = appConfig.slurmHost;
    this.baseDir = appConfig.slurmRemoteBaseDir;
    return Boolean(this.host && this.baseDir);
  }

  isConfigured(): boolean {
    return Boolean(appConfig.slurmHost && appConfig.slurmRemoteBaseDir);
  }

  getClusterName(): string {
    return appConfig.slurmHost ? `slurm:${appConfig.slurmHost}` : "slurm";
  }

  getTask(taskId: string): ComputeTask | undefined {
    return this.tasks.get(taskId);
  }

  async submitJob(params: ComputeJobParams): Promise<ComputeTask> {
    if (!this.isConfigured()) throw new Error("Slurm 后端未配置（需 SLURM_HOST / SLURM_REMOTE_BASE_DIR）");
    this.host = appConfig.slurmHost;
    this.baseDir = appConfig.slurmRemoteBaseDir;

    const { localDir, inputFile, executable, taskId } = params;
    const remoteDir = `${this.baseDir}/jobs/${taskId}`;

    const isVasp = ["vasp_std", "vasp_gam", "vasp_ncl"].some((v) => executable.includes(v));
    const isGaussian = inputFile.endsWith(".gjf") || inputFile.endsWith(".com");
    const outputFile = isVasp
      ? "OUTCAR"
      : isGaussian
        ? inputFile.replace(/\.(gjf|com)$/i, ".log")
        : inputFile.replace(/\.in$/i, ".out");

    // 核数 / 节点数
    const nprocMatch = params.rawCommand ? /-np\s+(\d+)/.exec(params.rawCommand) : null;
    const coresPerNode = appConfig.slurmMaxCoresPerNode;
    const nproc = params.nproc ?? (nprocMatch ? parseInt(nprocMatch[1], 10) : Math.min(16, coresPerNode));
    const nnode = Math.max(1, Math.ceil(nproc / coresPerNode));

    // 1. 远程建目录
    await this.ssh(`mkdir -p '${remoteDir}'`);

    // 2. 上传输入文件（QE .in 重写 pseudo_dir）
    const files = this.collectInputFiles(localDir, inputFile);
    const stage = join(tmpdir(), `dftap_${taskId}`);
    mkdirSync(stage, { recursive: true });
    for (const rel of files) {
      const localFile = join(localDir, rel);
      if (!existsSync(localFile)) continue;
      // 子目录（NEB image）
      if (rel.includes("/") || rel.includes("\\")) {
        await this.ssh(`mkdir -p '${remoteDir}/${dirname(rel).replace(/\\/g, "/")}'`);
      }
      if (rel.endsWith(".in") && appConfig.slurmPseudoDir) {
        let content = readFileSync(localFile, "utf-8");
        content = content.replace(
          /pseudo_dir\s*=\s*['"][^'"]*['"]/i,
          `pseudo_dir = '${appConfig.slurmPseudoDir}'`,
        );
        const tmp = join(stage, basename(rel));
        writeFileSync(tmp, content, "utf-8");
        await this.scpUp(tmp, `${remoteDir}/${rel.replace(/\\/g, "/")}`);
      } else {
        await this.scpUp(localFile, `${remoteDir}/${rel.replace(/\\/g, "/")}`);
      }
    }

    // 3. 生成并上传 sbatch 脚本
    const script = this.buildSbatch({ remoteDir, taskId, nproc, nnode, outputFile, executable, rawCommand: params.rawCommand, inputFile, isVasp, isGaussian });
    const scriptLocal = join(stage, `run_${taskId}.sh`);
    writeFileSync(scriptLocal, script, "utf-8");
    const scriptRemote = `${remoteDir}/run_${taskId}.sh`;
    await this.scpUp(scriptLocal, scriptRemote);

    // 4. 提交
    const { stdout } = await this.ssh(`cd '${remoteDir}' && sbatch '${scriptRemote}'`);
    const m = /Submitted batch job\s+(\d+)/.exec(stdout);
    if (!m) throw new Error(`sbatch 未返回作业号: ${stdout.slice(0, 300)}`);
    const jobId = m[1];

    const task: ComputeTask = {
      taskId,
      jobId,
      remoteDir,
      localDir,
      command: params.rawCommand ?? `${executable} -i ${inputFile}`,
      coresUsed: nproc,
      startedAt: Date.now(),
      outputFile,
      scriptPath: scriptRemote,
    };
    this.tasks.set(taskId, task);
    return task;
  }

  async listJobs(limit: number): Promise<ComputeJobBrief[]> {
    const user = appConfig.slurmUser || "$USER";
    const { stdout } = await this.ssh(
      `squeue -u ${user} -h -o '%i|%T|%j|%P' 2>/dev/null | head -n ${limit}`,
    );
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [jobId, state, jobName, queue] = line.split("|");
        return { jobId, status: mapSlurmState(state).status, jobName: jobName || jobId, queue };
      });
  }

  async getJobStatus(jobId: string): Promise<ComputeJobStatus> {
    // 1. squeue（运行中/排队中）
    try {
      const { stdout } = await this.ssh(
        `squeue -j ${jobId} -h -o '%T|%j|%P|%C|%R|%M' 2>/dev/null`,
      );
      const line = stdout.split("\n").map((l) => l.trim()).find(Boolean);
      if (line) {
        const [state, jobName, queue, cores, node, runTime] = line.split("|");
        const mapped = mapSlurmState(state);
        return {
          jobId, ...mapped, jobName, queue,
          cores: cores ? parseInt(cores, 10) : undefined,
          node: node && node !== "(null)" ? node : undefined,
          runTime: runTime || undefined,
          reason: mapped.status === "statPD" ? node : undefined,
        };
      }
    } catch { /* 落到 sacct */ }

    // 2. sacct（已结束/归档）
    try {
      const { stdout } = await this.ssh(
        `sacct -j ${jobId} -n -P -X -o State,JobName,Partition,AllocCPUS,Elapsed 2>/dev/null`,
      );
      const line = stdout.split("\n").map((l) => l.trim()).find(Boolean);
      if (line) {
        const [state, jobName, queue, cores, elapsed] = line.split("|");
        const mapped = mapSlurmState(state);
        return {
          jobId, ...mapped, jobName, queue,
          cores: cores ? parseInt(cores, 10) : undefined,
          runTime: elapsed || undefined,
        };
      }
    } catch { /* 都查不到 */ }

    return { jobId, status: "unknown", isCompleted: false, isRunning: false };
  }

  async downloadResults(
    task: ComputeTask,
    onProgress?: (msg: string) => void,
    opts?: { includeSubdirs?: boolean },
  ): Promise<string[]> {
    const downloaded: string[] = [];
    const entries = await this.listRemoteDir(task.remoteDir);

    // 根目录产出
    const targets = entries.filter((e) => !e.isDirectory && isOutputFile(e.name));
    for (let i = 0; i < targets.length; i++) {
      const f = targets[i];
      onProgress?.(`⬇️ [${i + 1}/${targets.length}] ${f.name}`);
      try {
        await this.scpDown(`${task.remoteDir}/${f.name}`, join(task.localDir, f.name));
        downloaded.push(f.name);
      } catch (e) {
        onProgress?.(`❌ ${f.name}: ${e instanceof Error ? e.message : e}`);
      }
    }

    // 子目录（NEB image：两位数字命名；或 includeSubdirs=true 时全部）
    const subdirs = entries.filter(
      (e) => e.isDirectory && e.name !== "tmp" && (opts?.includeSubdirs === true || /^\d{2,3}$/.test(e.name)),
    );
    for (const sub of subdirs) {
      const subEntries = await this.listRemoteDir(`${task.remoteDir}/${sub.name}`);
      const subTargets = subEntries.filter((e) => !e.isDirectory && (isOutputFile(e.name) || e.name === "POSCAR"));
      if (subTargets.length === 0) continue;
      mkdirSync(join(task.localDir, sub.name), { recursive: true });
      for (const e of subTargets) {
        try {
          await this.scpDown(`${task.remoteDir}/${sub.name}/${e.name}`, join(task.localDir, sub.name, e.name));
          downloaded.push(`${sub.name}/${e.name}`);
        } catch { /* 跳过单个失败 */ }
      }
    }

    // Slurm 标准输出日志
    try {
      const log = `slurm-${task.jobId}.out`;
      if (entries.some((e) => e.name === log)) {
        await this.scpDown(`${task.remoteDir}/${log}`, join(task.localDir, log));
        downloaded.push(log);
      }
    } catch { /* 可选 */ }

    onProgress?.(`📥 下载完成: ${downloaded.length} 个文件 → ${task.localDir}`);
    return downloaded;
  }

  async previewFile(remotePath: string, startIndex: number): Promise<PreviewResult> {
    // 文件大小
    let size = 0;
    try {
      const { stdout } = await this.ssh(`stat -c %s '${remotePath}' 2>/dev/null`);
      size = parseInt(stdout.trim(), 10) || 0;
    } catch { size = 0; }
    if (size === 0 || startIndex >= size) {
      return { content: "", endIndex: startIndex, hasNext: false };
    }
    // 从 startIndex 起读 PREVIEW_CHUNK 字节（tail -c +N 为 1-indexed）
    const { stdout } = await this.ssh(
      `tail -c +${startIndex + 1} '${remotePath}' 2>/dev/null | head -c ${PREVIEW_CHUNK}`,
    );
    const bytes = Buffer.byteLength(stdout, "utf-8");
    const endIndex = startIndex + bytes;
    return { content: stdout, endIndex, hasNext: endIndex < size };
  }

  async listRemoteDir(remotePath: string): Promise<RemoteDirEntry[]> {
    try {
      // GNU find：name \t size \t "YYYY-mm-dd HH:MM:SS" \t type(d/f)
      const { stdout } = await this.ssh(
        `find '${remotePath}' -maxdepth 1 -mindepth 1 -printf '%f\\t%s\\t%TY-%Tm-%Td %TH:%TM:%TS\\t%y\\n' 2>/dev/null`,
      );
      return stdout
        .split("\n")
        .map((l) => l.replace(/\r$/, ""))
        .filter(Boolean)
        .map((line) => {
          const [name, size, mtime, type] = line.split("\t");
          return {
            name,
            size: parseInt(size, 10) || 0,
            lastModifiedTime: (mtime || "").split(".")[0],
            isDirectory: type === "d",
          };
        });
    } catch {
      return [];
    }
  }

  async cancelJob(jobId: string): Promise<{ success: boolean; message: string }> {
    try {
      await this.ssh(`scancel ${jobId}`);
      for (const [tid, t] of this.tasks) {
        if (t.jobId === jobId) { this.tasks.delete(tid); break; }
      }
      return { success: true, message: `scancel ${jobId} 已发送` };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  // ---- 内部辅助 ----

  /** 生成 sbatch 脚本 */
  private buildSbatch(p: {
    remoteDir: string; taskId: string; nproc: number; nnode: number;
    outputFile: string; executable: string; rawCommand?: string;
    inputFile: string; isVasp: boolean; isGaussian: boolean;
  }): string {
    const lines: string[] = [
      "#!/bin/bash",
      `#SBATCH --job-name=${p.taskId}`,
      `#SBATCH --partition=${appConfig.slurmPartition}`,
      `#SBATCH --nodes=${p.nnode}`,
      `#SBATCH --ntasks=${p.nproc}`,
      `#SBATCH --time=${appConfig.slurmWallTime}`,
      `#SBATCH --output=${p.remoteDir}/slurm-%j.out`,
    ];
    if (appConfig.slurmAccount) lines.push(`#SBATCH --account=${appConfig.slurmAccount}`);
    lines.push("");
    // 环境（module load 等）
    for (const l of appConfig.slurmModules.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
      lines.push(l);
    }
    if (appConfig.slurmQeBinDir) lines.push(`export PATH="${appConfig.slurmQeBinDir}:$PATH"`);
    lines.push("", `cd '${p.remoteDir}'`, "");

    // 命令：优先透传 Agent 原始命令（去掉本地 cd 前缀）
    let cmd = p.rawCommand;
    if (cmd) {
      cmd = cmd.replace(/^cd\s+\S+\s*(?:&&|;)\s*/, "");
    } else if (p.isVasp) {
      cmd = `mpirun -np ${p.nproc} ${p.executable}`;
    } else if (p.isGaussian) {
      cmd = `${p.executable} < ${p.inputFile} > ${p.outputFile} 2>&1`;
    } else {
      cmd = `mpirun -np ${p.nproc} ${p.executable} -i ${p.inputFile} > ${p.outputFile} 2>&1`;
    }
    lines.push(`echo "=== start: $(date) on $(hostname) ==="`, cmd, `echo "=== end: $(date) exit=$? ==="`, "");
    return lines.join("\n");
  }

  /** 收集需上传的输入文件（含 NEB 子目录 POSCAR） */
  private collectInputFiles(localDir: string, mainInput: string): string[] {
    const files = new Set<string>([mainInput]);
    try {
      for (const f of readdirSync(localDir)) {
        const full = join(localDir, f);
        const isDir = statSync(full).isDirectory();
        if (!isDir && (
          f.endsWith(".in") || f.endsWith(".Hubbard") || f === "hubbard.dat" ||
          f === "INCAR" || f === "POSCAR" || f === "KPOINTS" || f === "POTCAR" ||
          f.endsWith(".gjf") || f.endsWith(".com")
        )) {
          files.add(f);
        }
        if (isDir && /^\d{2}$/.test(f)) {
          const poscar = join(full, "POSCAR");
          if (existsSync(poscar)) files.add(`${f}/POSCAR`);
        }
      }
    } catch { /* 目录读取失败 */ }
    return [...files];
  }

  /** ssh 执行远程命令 */
  private async ssh(remoteCmd: string): Promise<{ stdout: string; stderr: string }> {
    const args = [...this.sshOpts(), appConfig.slurmHost, remoteCmd];
    const { stdout, stderr } = await execFileAsync("ssh", args, { maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr };
  }

  /** scp 上传 */
  private async scpUp(localPath: string, remotePath: string): Promise<void> {
    await execFileAsync("scp", [...this.sshOpts(), localPath, `${appConfig.slurmHost}:${remotePath}`], {
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  /** scp 下载 */
  private async scpDown(remotePath: string, localPath: string): Promise<void> {
    await execFileAsync("scp", [...this.sshOpts(), `${appConfig.slurmHost}:${remotePath}`, localPath], {
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  /** 公共 ssh/scp 选项（BatchMode 免交互 + 用户附加项） */
  private sshOpts(): string[] {
    const base = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"];
    const extra = appConfig.slurmSshOpts.trim();
    return extra ? [...base, ...extra.split(/\s+/)] : base;
  }
}
