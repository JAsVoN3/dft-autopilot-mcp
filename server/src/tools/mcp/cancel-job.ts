/**
 * cancel-job.ts — 取消算力后端上正在运行或排队的作业
 *
 * 支持通过 job_id 或 task_id 取消。后端无关（scnet / slurm / local）。
 */
import { DFTTool, type ToolResult } from "../base.js";
import { getComputeProvider } from "../../compute/index.js";

export class CancelJobTool extends DFTTool {
  name = "cancel_job";
  description =
    "取消算力后端上正在运行或排队的作业。" +
    "支持通过 job_id 直接取消，或通过 task_id 查找对应的 job_id 后取消。";
  inputSchema = {
    type: "object" as const,
    properties: {
      job_id: {
        type: "string",
        description: "后端作业 ID（如 Slurm jobid '6301439'）。与 task_id 二选一。",
      },
      task_id: {
        type: "string",
        description: "本地 task_id（8 位 hex）。会自动查找对应的 job_id。与 job_id 二选一。",
      },
    },
    required: [],
  };

  validateInput(args: Record<string, unknown>): string | null {
    if (!args.job_id && !args.task_id) return "必须提供 job_id 或 task_id";
    return null;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const provider = getComputeProvider();
    let jobId = args.job_id as string | undefined;
    const taskId = args.task_id as string | undefined;

    // 通过 task_id 查找 job_id
    if (!jobId && taskId) {
      const task = provider.getTask(taskId);
      if (task) {
        jobId = task.jobId;
      } else {
        return {
          success: false,
          error: `找不到 task_id=${taskId} 的记录（可能 MCP 重启后丢失）。请直接提供 job_id。`,
        };
      }
    }

    if (!jobId) {
      return { success: false, error: "无法确定 job_id" };
    }

    try {
      const result = await provider.cancelJob(jobId);
      return {
        success: result.success,
        data: {
          job_id: jobId,
          task_id: taskId,
          cancelled: result.success,
          message: result.message,
        },
        display: result.success
          ? `🛑 作业 ${jobId} 已取消`
          : `⚠️ 取消失败: ${result.message}`,
        error: result.success ? undefined : result.message,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: `取消作业失败: ${msg}` };
    }
  }
}
