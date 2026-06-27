/**
 * 计算后端工厂
 *
 * 根据 COMPUTE_PROVIDER 环境变量返回对应的 ComputeProvider 单例。
 *   scnet → 国家超算互联网（SCNet OpenAPI）
 *   slurm → 通用 Slurm 集群（SSH）
 *   local → 本地机器
 *
 * 工具层统一通过 getComputeProvider() 获取后端，不直接依赖任何具体实现。
 */

import { appConfig } from "../config.js";
import type { ComputeProvider } from "./provider.js";
import { ScnetProvider } from "./scnet-provider.js";
import { SlurmSshProvider } from "./slurm-ssh-provider.js";
import { LocalProvider } from "./local-provider.js";

let _provider: ComputeProvider | null = null;

/** 获取（并缓存）当前配置的计算后端 */
export function getComputeProvider(): ComputeProvider {
  if (_provider) return _provider;

  switch (appConfig.computeProvider) {
    case "slurm":
      _provider = new SlurmSshProvider();
      break;
    case "local":
      _provider = new LocalProvider();
      break;
    case "scnet":
    default:
      _provider = new ScnetProvider();
      break;
  }
  return _provider;
}

export type { ComputeProvider } from "./provider.js";
export type {
  ComputeJobParams,
  ComputeTask,
  ComputeJobStatus,
  ComputeJobBrief,
  RemoteDirEntry,
  PreviewResult,
} from "./provider.js";
