/**
 * EngineProfile — DFT 引擎配置抽象
 *
 * 每种 DFT 软件（QE/VASP/Gaussian）有独立的配置实例：
 * - 显示名称和标识
 * - 可执行文件列表（用于 run_command 路由）
 * - 环境脚本路径
 * - 系统提示词构建器
 *
 * NOTE: 为什么不直接在 registry 里 switch？
 * 因为引擎配置被多个模块引用（run_command 路由、scnet 作业脚本、agent 提示词），
 * 集中定义避免散落在各处。
 */

import { appConfig } from "./config.js";

/** 支持的引擎标识 */
export type EngineId = "qe" | "vasp" | "gaussian";

export interface EngineProfile {
  /** 引擎标识 */
  id: EngineId;

  /** 显示名称（前端展示用） */
  displayName: string;

  /** 可执行文件列表（用于 run_command 检测命令是否属于该引擎） */
  executables: string[];

  /** SCNet 环境脚本路径 */
  envScript: string;

  /** SCNet 作业脚本中需要的额外环境变量 */
  envExports: string[];
}

// ---------------------------------------------------------------------------
// 三个引擎的配置实例
// ---------------------------------------------------------------------------

const QE_PROFILE: EngineProfile = {
  id: "qe",
  displayName: "Quantum ESPRESSO",
  executables: [
    "pw.x", "ph.x", "pp.x", "dos.x", "bands.x", "projwfc.x",
    "matdyn.x", "q2r.x", "dynmat.x", "plotband.x", "epsilon.x",
    "hp.x", "turbo_lanczos.x", "neb.x", "cp.x",
  ],
  envScript: appConfig.scnetQeEnvScript,
  envExports: [
    "export OMP_NUM_THREADS=1",
    "export MKL_NUM_THREADS=1",
  ],
};

const VASP_PROFILE: EngineProfile = {
  id: "vasp",
  displayName: "VASP",
  executables: ["vasp_std", "vasp_gam", "vasp_ncl"],
  envScript: appConfig.scnetVaspEnvScript,
  envExports: [
    "export MKL_DEBUG_CPU_TYPE=5",
    "export MKL_CBWR=AVX2",
    "export I_MPI_PIN_DOMAIN=numa",
    "export UCX_IB_ADDR_TYPE=ib_global",
  ],
};

const GAUSSIAN_PROFILE: EngineProfile = {
  id: "gaussian",
  displayName: "Gaussian 16",
  executables: ["g16", "formchk", "cubegen", "newzmat"],
  envScript: appConfig.scnetGaussianEnvScript,
  envExports: [
    "export PGI_FASTMATH_CPU=sandybridge",
  ],
};

/** 引擎配置注册表 */
const ENGINE_PROFILES: Record<EngineId, EngineProfile> = {
  qe: QE_PROFILE,
  vasp: VASP_PROFILE,
  gaussian: GAUSSIAN_PROFILE,
};

/**
 * 获取引擎配置
 *
 * @param engineId 引擎标识，默认为 "qe"
 */
export function getEngineProfile(engineId: EngineId = "qe"): EngineProfile {
  return ENGINE_PROFILES[engineId] ?? QE_PROFILE;
}

/**
 * 根据命令内容检测所属引擎
 *
 * NOTE: run_command 在 async 模式下使用此函数判断命令应该路由到哪个引擎。
 * 如果没有匹配到任何引擎，返回 null（作为普通 shell 命令处理）。
 */
export function detectEngineFromCommand(command: string): EngineId | null {
  for (const [engineId, profile] of Object.entries(ENGINE_PROFILES) as [EngineId, EngineProfile][]) {
    if (profile.executables.some((exe) => command.includes(exe))) {
      return engineId;
    }
  }
  return null;
}

/**
 * 获取所有引擎的可执行文件列表（扁平化）
 *
 * NOTE: 用于 run_command 判断命令是否是"DFT 计算命令"需要路由到超算。
 */
export function getAllDftExecutables(): string[] {
  return Object.values(ENGINE_PROFILES).flatMap((p) => p.executables);
}

/**
 * 根据引擎标识返回对应的结果提取工具名
 *
 * NOTE: 心跳完成通知、check_command 提示、runtime-supervisor 等模块
 * 需要动态引用正确的工具名，而非硬编码 extract_dft_results。
 */
const EXTRACT_TOOL_MAP: Record<EngineId, string> = {
  qe: "extract_dft_results",
  vasp: "extract_vasp_results",
  gaussian: "extract_gaussian_results",
};

export function getExtractToolName(engineId: EngineId = "qe"): string {
  return EXTRACT_TOOL_MAP[engineId] ?? "extract_dft_results";
}
