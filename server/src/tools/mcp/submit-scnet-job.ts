/**
 * submit_compute_job — 提交 DFT 计算作业到已配置的算力后端
 *
 * 后端无关（scnet / slurm / local）：解析命令 → 上传输入 → 提交作业，
 * 返回 task_id + job_id，供 check_job_status 查询、download_job_results 下载。
 */

import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { resolve, isAbsolute } from "path";
import { DFTTool, type ToolResult } from "../base.js";
import { getComputeProvider } from "../../compute/index.js";
import { detectEngineFromCommand } from "../../engine-profile.js";

export class SubmitScnetJobTool extends DFTTool {
  readonly name = "submit_compute_job";

  readonly description =
    "将 DFT 计算作业提交到已配置的算力后端（COMPUTE_PROVIDER: scnet / slurm / local）。\n" +
    "支持 QE (pw.x, ph.x 等)、VASP (vasp_std 等)、Gaussian (g16) 三种引擎。\n" +
    "提交后返回 task_id 和 job_id，通过 check_job_status 查询进度，\n" +
    "完成后通过 download_job_results 下载结果。\n\n" +
    "示例：\n" +
    "submit_compute_job(command='mpirun -np 16 pw.x -i scf.in > scf.out', cwd='my_project/03_mol_H2')\n\n" +
    "⚠️ **cwd 必须设为存放输入文件的那个叶子目录**（与 create_*_input 的 output_dir 完全一致）。" +
    "支持绝对路径或相对于 workspace 的相对路径。\n" +
    "⚠️ **不要在 command 里写 `cd 子目录 && ...` 来切换工作目录**：系统已在 cwd 中运行，" +
    "且会剥除命令开头的 `cd X &&` 前缀；若用它指向子目录，mpirun 会在 cwd 根目录跑、找不到输入文件。" +
    "正确做法是把 cwd 直接设到该子目录，command 里只写计算命令（如 `mpirun -np 32 vasp_std`）。\n" +
    "⚠️ 提交前必须确保输入文件已通过 create_qe_input / create_vasp_input 生成。";

  readonly inputSchema = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "DFT 计算命令。格式：mpirun -np <核数> <可执行文件> -i <输入文件> > <输出文件>\n" +
          "支持 cd /path && 命令 格式指定工作目录",
      },
      cwd: {
        type: "string",
        description:
          "工作目录（包含输入文件）。支持绝对路径或相对于 workspace 的相对路径。\n" +
          "示例: 'my_project/03_mol_H2'（相对 workspace）或一个绝对路径",
      },
      nproc: {
        type: "integer",
        description:
          "并行核数（可选）。不指定则按体系大小自动选择或从命令中的 -np 解析。",
      },
      session_id: {
        type: "string",
        description:
          "会话 ID（可选）。同一会话内的作业共享 outdir，支持分步计算（SCF → NSCF → DOS）。",
      },
    },
    required: ["command", "cwd"],
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const provider = getComputeProvider();
    const command = args.command as string;
    const rawCwd = args.cwd as string;
    const nproc = args.nproc as number | undefined;
    const sessionId = args.session_id as string | undefined;

    // --- 路径解析：相对路径锚定到 workspaceDir，绝对路径直接使用 ---
    let cwd: string;
    if (isAbsolute(rawCwd) || /^[A-Z]:\\/i.test(rawCwd)) {
      cwd = rawCwd;
    } else if (this.workspaceDir) {
      cwd = resolve(this.workspaceDir, rawCwd);
    } else {
      console.warn(`[SubmitComputeJob] workspaceDir 未设置，cwd 将相对于进程工作目录解析: ${rawCwd}`);
      cwd = resolve(rawCwd);
    }

    // 目录存在性校验 — 防止静默失败
    if (!existsSync(cwd)) {
      return {
        success: false,
        error:
          `工作目录不存在: ${cwd}\n` +
          `原始路径: ${rawCwd}\n` +
          (this.workspaceDir
            ? `workspace: ${this.workspaceDir}\n`
            : "⚠️ workspaceDir 未设置\n") +
          "请检查路径是否正确，或确保 create_vasp_input / create_qe_input 已成功生成输入文件。",
      };
    }

    // 校验算力后端是否已配置
    if (!provider.isConfigured()) {
      return {
        success: false,
        error:
          `算力后端 "${provider.name}" 未配置。请按 .env.example 配置 COMPUTE_PROVIDER ` +
          "对应的连接信息（scnet: SCNET_*；slurm: SLURM_HOST/SLURM_REMOTE_BASE_DIR；local 无需配置）。",
      };
    }

    // 检测引擎类型
    const detectedEngine = detectEngineFromCommand(command);
    if (!detectedEngine) {
      return {
        success: false,
        error:
          "无法从命令中检测到 DFT 引擎。" +
          "支持的可执行文件：pw.x, ph.x, dos.x, bands.x, projwfc.x, vasp_std, vasp_gam, g16 等。",
      };
    }

    // 解析可执行文件和输入文件
    const executable = this.extractExecutable(command);
    const inputFile = this.extractInputFile(command);

    // VASP 不使用 -i 参数，从当前目录读取 INCAR/POSCAR/KPOINTS
    if (!inputFile && detectedEngine !== "vasp") {
      return {
        success: false,
        error: "无法从命令中提取输入文件名。请使用 -i filename.in 格式。",
      };
    }

    // 从命令中提取实际工作目录（处理 cd /path && 模式）
    const cdMatch = /^cd\s+(\S+)\s*(?:&&|;)/.exec(command);
    const actualCwd = cdMatch ? cdMatch[1] : cwd;

    // 从命令中提取核数
    const nprocMatch = /-np\s+(\d+)/.exec(command);
    const requestedNproc = nproc ?? (nprocMatch ? parseInt(nprocMatch[1], 10) : undefined);

    const taskId = randomUUID().slice(0, 8);

    try {
      const task = await provider.submitJob({
        localDir: actualCwd,
        inputFile: inputFile ?? "INCAR",
        executable,
        taskId,
        nproc: requestedNproc,
        rawCommand: command,
        sessionId,
      });

      return {
        success: true,
        data: {
          task_id: taskId,
          job_id: task.jobId,
          remote_dir: task.remoteDir,
          cores_used: task.coresUsed,
          provider: provider.name,
          cluster: provider.getClusterName(),
          engine: detectedEngine,
          command: command.slice(0, 200),
          next_step:
            "作业已提交。请使用 check_job_status(task_id='" + taskId + "') 查询进度。" +
            "计算完成后使用 download_job_results(task_id='" + taskId + "') 下载结果。",
        },
        display:
          `🚀 作业已提交 | ${provider.getClusterName()} | jobId=${task.jobId} | ` +
          `${task.coresUsed} 核 | task_id=${taskId}`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `作业提交失败: ${msg}`,
      };
    }
  }

  /** 从命令中提取 DFT 可执行文件名 */
  private extractExecutable(command: string): string {
    const qeMatch =
      /\b(pw|ph|pp|dos|bands|projwfc|hp|neb|cp|matdyn|q2r|dynmat|epsilon)\.x\b/.exec(
        command,
      );
    if (qeMatch) return qeMatch[0];
    const vaspMatch = /\b(vasp_std|vasp_gam|vasp_ncl)\b/.exec(command);
    if (vaspMatch) return vaspMatch[0];
    const gaussMatch = /\b(g16|formchk|cubegen)\b/.exec(command);
    if (gaussMatch) return gaussMatch[0];
    return "pw.x";
  }

  /** 从命令中提取输入文件名 */
  private extractInputFile(command: string): string | null {
    const inMatch = /(?:-i|-in)\s+(\S+\.in)/i.exec(command);
    if (inMatch) return inMatch[1];
    const stdinMatch = /<\s*(\S+\.in)/i.exec(command);
    if (stdinMatch) return stdinMatch[1];
    const gjfMatch = /<\s*(\S+\.gjf)/i.exec(command);
    if (gjfMatch) return gjfMatch[1];
    return null;
  }
}
