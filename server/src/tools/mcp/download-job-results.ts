/**
 * download_job_results — 从 SCNet 超算下载计算结果
 *
 * 在 check_job_status 确认作业完成后调用。
 * 自动下载所有计算产出文件（.out / .dat / .gnu / pdos / OUTCAR 等）到本地工作目录。
 *
 * NOTE: Bug #16 修复 — NEB 等多目录作业会递归下载 image 子目录（00/ 01/ ... 0N/）。
 * NOTE: Bug #2 修复 — 支持 remote_dir 参数，MCP 重启后 task_id 映射丢失时仍可下载。
 */

import { mkdirSync } from "fs";
import { basename, isAbsolute, join, resolve } from "path";
import { DFTTool, type ToolResult } from "../base.js";
import { getComputeProvider } from "../../compute/index.js";
import type { ComputeTask } from "../../compute/provider.js";

export class DownloadJobResultsTool extends DFTTool {
  readonly name = "download_job_results";

  readonly description =
    "从 SCNet 超算下载已完成作业的计算结果到本地。\n" +
    "在 check_job_status 确认作业状态为 statC（已完成）后调用。\n" +
    "自动下载所有计算产出文件（.out, .dat, .gnu, pdos, OUTCAR 等）。\n\n" +
    "**NEB / 多目录作业**：自动递归下载 image 子目录（00/ 01/ ... 0N/）的 " +
    "OUTCAR/OSZICAR/CONTCAR/POSCAR/vasprun.xml。其他作业如需下子目录，设 include_subdirs=true。\n\n" +
    "**MCP 重启后**：若 task_id 已丢失，可改用 remote_dir 直接指定远程目录（配合 local_dir 指定落地位置）。\n\n" +
    "示例：\n" +
    "download_job_results(task_id='a1b2c3d4')\n" +
    "download_job_results(remote_dir='/work/home/xxx/jobs/a1b2c3d4', local_dir='HMF_DMF_catalysis/05_neb')";

  readonly inputSchema = {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description: "任务 ID（submit_compute_job 返回的 task_id）。与 remote_dir 二选一。",
      },
      remote_dir: {
        type: "string",
        description:
          "远程作业目录绝对路径（如 '/work/home/xxx/jobs/a1b2c3d4'）。" +
          "task_id 在 MCP 重启后丢失时使用，与 task_id 二选一。",
      },
      local_dir: {
        type: "string",
        description:
          "本地落地目录（仅 remote_dir 模式需要）。支持绝对路径或相对于 workspace 的相对路径。" +
          "省略时默认落到 workspace/<远程目录名>。",
      },
      include_subdirs: {
        type: "boolean",
        description:
          "是否递归下载所有非 tmp 子目录（默认 false）。" +
          "NEB image 子目录（两位数字命名）无论此参数为何都会下载。",
      },
    },
    required: [],
  };

  validateInput(args: Record<string, unknown>): string | null {
    if (!args.task_id && !args.remote_dir) return "必须提供 task_id 或 remote_dir";
    return null;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const taskId = args.task_id as string | undefined;
    const remoteDirArg = args.remote_dir as string | undefined;
    const includeSubdirs = (args.include_subdirs as boolean) ?? false;

    if (!getComputeProvider().isConfigured()) {
      return {
        success: false,
        error: "SCNet 超算未配置。",
      };
    }

    // NOTE: 优先用 task_id 取已记录的任务；取不到则用 remote_dir 重建一个临时任务（Bug #2）
    let task = taskId ? getComputeProvider().getTask(taskId) : undefined;

    if (!task) {
      if (!remoteDirArg) {
        return {
          success: false,
          error:
            `未找到 task_id=${taskId} 对应的作业信息（可能 MCP 重启后丢失）。\n` +
            "请改用 remote_dir 参数直接指定远程作业目录，可选配 local_dir 指定落地位置。",
        };
      }
      task = this.buildTaskFromRemoteDir(remoteDirArg, args.local_dir as string | undefined);
      // 确保本地落地目录存在（已记录的任务由 submit 阶段创建过）
      mkdirSync(task.localDir, { recursive: true });
    }

    try {
      const downloadedFiles = await getComputeProvider().downloadResults(
        task,
        this.notifyProgress,
        { includeSubdirs },
      );

      if (downloadedFiles.length === 0) {
        return {
          success: false,
          error:
            "未下载到任何计算产出文件。可能作业执行出错，请检查 stdout/stderr 文件。",
          data: {
            task_id: task.taskId,
            remote_dir: task.remoteDir,
            local_dir: task.localDir,
          },
        };
      }

      // NOTE: 统计下载到的 image 子目录（带 '/' 前缀的相对路径），便于确认 NEB 数据拿全（Bug #16）
      const subdirSet = new Set<string>();
      for (const f of downloadedFiles) {
        const slash = f.indexOf("/");
        if (slash > 0) subdirSet.add(f.slice(0, slash));
      }
      const subdirs = [...subdirSet].sort();

      return {
        success: true,
        data: {
          task_id: task.taskId,
          downloaded_files: downloadedFiles,
          file_count: downloadedFiles.length,
          subdir_count: subdirs.length,
          subdirs,
          local_dir: task.localDir,
          remote_dir: task.remoteDir,
          next_step:
            "结果已下载到 " + task.localDir + "。\n" +
            (subdirs.length > 0
              ? `含 ${subdirs.length} 个子目录（${subdirs.join(", ")}）。NEB 用 extract_vasp_results(file_path='${task.localDir}', result_type='neb')。\n`
              : "") +
            "请使用 extract_dft_results / extract_vasp_results 解析计算结果。",
        },
        display:
          `📥 已下载 ${downloadedFiles.length} 个文件到 ${task.localDir}` +
          (subdirs.length > 0 ? `（含子目录 ${subdirs.join(", ")}）` : "") +
          "\n" +
          downloadedFiles.map((f) => `  - ${f}`).join("\n"),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `下载结果失败: ${msg}`,
        data: {
          task_id: task.taskId,
          remote_dir: task.remoteDir,
          local_dir: task.localDir,
        },
      };
    }
  }

  /**
   * 从 remote_dir 重建一个临时任务（Bug #2）
   *
   * NOTE: jobId 留空 → downloadResults 跳过 stdout/stderr 下载。
   * local_dir 缺省时落到 workspace/<远程目录名>。
   */
  private buildTaskFromRemoteDir(remoteDir: string, localDirArg?: string): ComputeTask {
    const normalizedRemote = remoteDir.replace(/\/+$/, "");
    const remoteName = basename(normalizedRemote) || "download";

    let localDir: string;
    if (localDirArg) {
      localDir =
        isAbsolute(localDirArg) || /^[A-Za-z]:[\\/]/.test(localDirArg)
          ? localDirArg
          : this.workspaceDir
            ? resolve(this.workspaceDir, localDirArg)
            : resolve(localDirArg);
    } else {
      localDir = this.workspaceDir
        ? join(this.workspaceDir, remoteName)
        : resolve(remoteName);
    }

    return {
      taskId: remoteName,
      jobId: "",
      remoteDir: normalizedRemote,
      localDir,
      command: "",
      coresUsed: 0,
      startedAt: Date.now(),
    };
  }
}
