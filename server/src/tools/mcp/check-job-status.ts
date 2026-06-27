/**
 * check_job_status — 查询算力后端作业状态
 *
 * 支持通过 task_id 或 job_id 查询。后端无关（scnet / slurm / local）。
 *
 * 状态含义：
 * - statPD: 排队中（等待调度）
 * - statR: 运行中
 * - statC: 已完成
 * - statE: 错误/失败
 */

import { DFTTool, type ToolResult } from "../base.js";
import { getComputeProvider } from "../../compute/index.js";

export class CheckJobStatusTool extends DFTTool {
  readonly name = "check_job_status";

  readonly description =
    "查询算力后端作业的运行状态。\n" +
    "支持通过 task_id（submit 返回）或 job_id 查询。\n" +
    "也可以不传参数，列出最近的作业。\n\n" +
    "返回状态：\n" +
    "- statPD: 排队中\n" +
    "- statR: 运行中\n" +
    "- statC: 已完成 → 下一步调用 download_job_results\n" +
    "- statE: 错误\n\n" +
    "⚠️ 此工具只返回调度状态，不含 DFT 计算数据。\n" +
    "要查看能量、收敛、力等计算进度，请配合 preview_remote_file 读取输出文件：\n" +
    "- VASP: preview_remote_file(task_id='xxx', filename='OSZICAR')\n" +
    "- QE: preview_remote_file(task_id='xxx', filename='scf.out')\n\n" +
    "示例：check_job_status(task_id='a1b2c3d4')";

  readonly inputSchema = {
    type: "object",
    properties: {
      task_id: {
        type: "string",
        description: "任务 ID（submit_compute_job 返回的 task_id）",
      },
      job_id: {
        type: "string",
        description: "作业 ID（submit_compute_job 返回的 job_id）",
      },
      list_recent: {
        type: "boolean",
        description: "列出最近的作业（默认 false）。设为 true 时忽略 task_id/job_id",
      },
      limit: {
        type: "integer",
        description: "列出作业的数量限制（默认 10）",
      },
    },
    required: [],
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const provider = getComputeProvider();
    if (!provider.isConfigured()) {
      return {
        success: false,
        error: "算力后端未配置。请按 .env.example 配置 COMPUTE_PROVIDER 对应的后端。",
      };
    }

    const taskId = args.task_id as string | undefined;
    const jobId = args.job_id as string | undefined;
    const listRecent = args.list_recent as boolean | undefined;
    const limit = (args.limit as number) ?? 10;

    // 列出最近作业
    if (listRecent || (!taskId && !jobId)) {
      try {
        const jobs = await provider.listJobs(limit);
        return {
          success: true,
          data: {
            jobs,
            total: jobs.length,
          },
          display: `📋 最近 ${jobs.length} 个作业:\n` +
            jobs.map((j) =>
              `  ${j.jobId} | ${j.status} | ${j.jobName}`
            ).join("\n"),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `查询作业列表失败: ${msg}` };
      }
    }

    // 通过 task_id 获取 job_id
    let targetJobId = jobId;
    if (taskId && !targetJobId) {
      const task = provider.getTask(taskId);
      if (task) {
        targetJobId = task.jobId;
      } else {
        return {
          success: false,
          error: `未找到 task_id=${taskId} 对应的作业。可能是服务重启后丢失，请使用 job_id 查询。`,
        };
      }
    }

    if (!targetJobId) {
      return {
        success: false,
        error: "请提供 task_id 或 job_id。",
      };
    }

    try {
      const status = await provider.getJobStatus(targetJobId);
      const task = taskId ? provider.getTask(taskId) : null;
      const elapsed = task
        ? Math.round((Date.now() - task.startedAt) / 1000)
        : null;

      // 构建状态描述
      let statusDesc: string;
      if (status.isCompleted) statusDesc = "已完成";
      else if (status.isRunning) statusDesc = "运行中";
      else if (status.status === "statPD" || status.status === "statQ") statusDesc = "排队中";
      else if (status.status === "statE" || status.status === "statF") statusDesc = "错误/失败";
      else if (status.status === "statCG") statusDesc = "正在完成（completing）";
      else if (status.status === "unknown") statusDesc = "未知（可能已完成但记录已清理，尝试 download_job_results 下载）";
      else statusDesc = `未知状态码: ${status.status}`;

      const result: Record<string, unknown> = {
        job_id: targetJobId,
        task_id: taskId ?? null,
        status: status.status,
        status_description: statusDesc,
        is_completed: status.isCompleted,
        is_running: status.isRunning,
      };

      // 调度详情
      if (status.queue) result.queue = status.queue;
      if (status.cores) result.cores = status.cores;
      if (status.node) result.node = status.node;
      if (status.startTime) result.start_time = status.startTime;
      if (status.runTime) result.run_time = status.runTime;
      if (status.workDir) result.work_dir = status.workDir;
      if (status.reason) result.reason = status.reason;

      if (elapsed !== null) {
        result.elapsed_seconds = elapsed;
        result.elapsed_human = elapsed < 60
          ? `${elapsed}s`
          : elapsed < 3600
            ? `${Math.round(elapsed / 60)}min`
            : `${(elapsed / 3600).toFixed(1)}h`;
      }

      if (status.isCompleted && taskId) {
        result.next_step =
          `作业已完成！请调用 download_job_results(task_id='${taskId}') 下载结果。`;
      }

      // 构建 display
      const parts = [statusDesc, `jobId=${targetJobId}`];
      if (status.queue) parts.push(`队列=${status.queue}`);
      if (status.cores) parts.push(`${status.cores}核`);
      if (status.runTime) parts.push(`运行${status.runTime}`);
      if (status.node) parts.push(`节点=${status.node}`);
      if (elapsed !== null) parts.push(`本地计时${result.elapsed_human}`);

      // 运行中时提示读取输出文件
      if (status.isRunning && taskId) {
        result.tip = "此工具仅返回调度状态。要查看 DFT 计算进度（能量/收敛/力），" +
          `请调用 preview_remote_file(task_id='${taskId}', filename='OSZICAR') 或对应的输出文件。`;
      }

      return {
        success: true,
        data: result,
        display: parts.join(" | "),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `查询作业状态失败: ${msg}` };
    }
  }
}
