/**
 * ScnetProvider — 国家超算互联网（SCNet）适配器
 *
 * 包装既有的 SCNetManager（HMAC 认证 + EFile 文件 API + HPC 作业 API），
 * 使其符合 ComputeProvider 接口。所有 SCNet 专属逻辑仍在 infra/scnet-manager.ts。
 *
 * 配置来自环境变量（见 .env.example）：
 *   SCNET_USER / SCNET_ACCESS_KEY / SCNET_SECRET_KEY
 *   SCNET_CLUSTER_ID / SCNET_HPC_URL / SCNET_EFILE_URL / SCNET_HOME_PATH / ...
 *
 * 注意：本仓库不附带任何 SCNet 账号或集群默认值。用户须用自己的 SCNet 账号配置。
 */

import { appConfig } from "../config.js";
import { scnetManager } from "../infra/scnet-manager.js";
import type {
  ComputeProvider,
  ComputeJobParams,
  ComputeTask,
  ComputeJobStatus,
  ComputeJobBrief,
  RemoteDirEntry,
  PreviewResult,
} from "./provider.js";

export class ScnetProvider implements ComputeProvider {
  readonly name = "scnet";

  configure(): boolean {
    if (!appConfig.scnetUser || !appConfig.scnetAccessKey) {
      return false;
    }
    scnetManager.configure(
      {
        user: appConfig.scnetUser,
        accessKey: appConfig.scnetAccessKey,
        secretKey: appConfig.scnetSecretKey,
      },
      {
        clusterId: appConfig.scnetClusterId,
        clusterName: appConfig.scnetClusterName || "SCNet",
        hpcUrl: appConfig.scnetHpcUrl,
        efileUrl: appConfig.scnetEfileUrl,
        homePath: appConfig.scnetHomePath,
        queue: appConfig.scnetQueue,
        schedulerId: appConfig.scnetSchedulerId,
        qePath: appConfig.scnetQePath,
        qeEnvScript: appConfig.scnetQeEnvScript,
        pseudoDir: appConfig.scnetPseudoDir,
        maxCoresPerNode: appConfig.scnetMaxCores,
        maxCoresPerJob: appConfig.scnetMaxCoresPerJob,
      },
    );
    return true;
  }

  isConfigured(): boolean {
    return scnetManager.isConfigured();
  }

  getClusterName(): string {
    return scnetManager.getCluster()?.clusterName ?? "SCNet";
  }

  getTask(taskId: string): ComputeTask | undefined {
    return scnetManager.getTask(taskId);
  }

  submitJob(params: ComputeJobParams): Promise<ComputeTask> {
    return scnetManager.submitQeJob(params);
  }

  listJobs(limit: number): Promise<ComputeJobBrief[]> {
    return scnetManager.listJobs(limit);
  }

  getJobStatus(jobId: string): Promise<ComputeJobStatus> {
    return scnetManager.getJobStatus(jobId);
  }

  downloadResults(
    task: ComputeTask,
    onProgress?: (msg: string) => void,
    opts?: { includeSubdirs?: boolean },
  ): Promise<string[]> {
    return scnetManager.downloadResults(task, onProgress, opts);
  }

  previewFile(remotePath: string, startIndex: number): Promise<PreviewResult> {
    return scnetManager.previewFile(remotePath, startIndex);
  }

  listRemoteDir(remotePath: string): Promise<RemoteDirEntry[]> {
    return scnetManager.listRemoteDir(remotePath);
  }

  cancelJob(jobId: string): Promise<{ success: boolean; message: string }> {
    return scnetManager.cancelJob(jobId);
  }
}
