/**
 * SCNetManager — 国家超算互联网 OpenAPI 管理器
 *
 * 核心职责：
 * 1. HMAC-SHA256 认证，动态获取集群 Token
 * 2. EFile API：文件上传/下载/目录操作
 * 3. HPC API：作业提交/查询/控制
 * 4. 智能并行策略：根据体系特征自动选核数
 *
 * 设计决策：
 * - 集群与凭证全部来自环境变量，不硬编码任何账号或节点
 * - 所有 API 地址通过 center 接口动态获取，不硬编码
 * - GAP_CMD_FILE 使用「上传脚本 + bash 执行」模式，避免 \n 转义问题
 */

import { createHmac } from "crypto";
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from "fs";
import { join, basename, dirname } from "path";
import https from "https";
import { URL } from "url";
import { appConfig } from "../config.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** SCNet 集群配置 */
export interface SCNetClusterConfig {
  /** 集群 ID */
  clusterId: string;
  /** 集群名称 */
  clusterName: string;
  /** HPC API 地址 */
  hpcUrl: string;
  /** EFile API 地址 */
  efileUrl: string;
  /** 用户主目录 */
  homePath: string;
  /** 队列名称 */
  queue: string;
  /** 调度器 ID */
  schedulerId: string;
  /** QE pw.x 绝对路径 */
  qePath: string;
  /** QE 环境初始化脚本路径 */
  qeEnvScript: string;
  /** 赝势目录 */
  pseudoDir: string;
  /** 每节点最大核数 */
  maxCoresPerNode: number;
  /** 单作业最大核数（> maxCoresPerNode 时自动跨节点 MPI） */
  maxCoresPerJob: number;
}

/** SCNet 认证凭据 */
export interface SCNetCredentials {
  user: string;
  accessKey: string;
  secretKey: string;
}

/** SCNet 作业状态 */
export interface SCNetJobStatus {
  jobId: string;
  status: string;
  /** statC=完成, statR=运行中, statPD=排队 */
  isCompleted: boolean;
  isRunning: boolean;
  /** 作业名称 */
  jobName?: string;
  /** 队列名称 */
  queue?: string;
  /** 使用的 CPU 核数 */
  cores?: number;
  /** 使用的节点名 */
  node?: string;
  /** 作业启动时间（如 "2026-05-21 17:00:00"） */
  startTime?: string;
  /** 已运行时长（如 "01:23:45" 或 "2-00:00:58"） */
  runTime?: string;
  /** 远程工作目录 */
  workDir?: string;
  /** 排队/失败原因 */
  reason?: string;
}

/** SCNet 远程任务 */
export interface SCNetTask {
  taskId: string;
  jobId: string;
  remoteDir: string;
  localDir: string;
  command: string;
  coresUsed: number;
  startedAt: number;
  outputFile?: string;
  scriptPath?: string;
}

/** QE 输入文件解析结果 */
interface QeInputInfo {
  nat: number;
  nk: number;
  calculation: string;
}

// ---------------------------------------------------------------------------
// SCNetManager 实现
// ---------------------------------------------------------------------------

class SCNetManager {
  private credentials: SCNetCredentials | null = null;
  private cluster: SCNetClusterConfig | null = null;
  private token: string | null = null;
  private tokenExpiry = 0;
  private activeTasks = new Map<string, SCNetTask>();

  // ---- 初始化 ----

  /**
   * 配置 SCNet 凭据和集群信息
   */
  configure(credentials: SCNetCredentials, cluster: SCNetClusterConfig): void {
    this.credentials = credentials;
    this.cluster = cluster;
    console.log(
      `[SCNet] 🌐 集群配置: ${cluster.clusterName} (${cluster.clusterId}) | ` +
      `队列: ${cluster.queue} | 最大 ${cluster.maxCoresPerNode} 核/节点`,
    );
  }

  isConfigured(): boolean {
    return this.credentials !== null && this.cluster !== null;
  }

  getCluster(): SCNetClusterConfig | null {
    return this.cluster;
  }

  // ---- 认证 ----

  /**
   * 获取集群访问 Token（带缓存，过期自动刷新）
   * NOTE: Token 有效期约 2 小时，提前 5 分钟刷新
   */
  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry - 300_000) {
      return this.token;
    }

    if (!this.credentials || !this.cluster) {
      throw new Error("SCNet 未配置");
    }

    const { user, accessKey, secretKey } = this.credentials;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signBody = JSON.stringify({ accessKey, timestamp, user });
    const signature = createHmac("sha256", secretKey)
      .update(signBody)
      .digest("hex")
      .toLowerCase();

    const result = await this.httpRequest<{
      code: string;
      data: Array<{ clusterId: string; token: string }>;
    }>("https://api.scnet.cn/api/user/v3/tokens", {
      method: "POST",
      headers: {
        user,
        accessKey,
        timestamp,
        signature,
        "Content-Type": "application/json",
      },
      body: signBody,
    });

    const clusterToken = result.data?.find(
      (t) => t.clusterId === this.cluster!.clusterId,
    );
    if (!clusterToken?.token) {
      throw new Error(`未找到集群 ${this.cluster.clusterId} 的 Token`);
    }

    this.token = clusterToken.token;
    this.tokenExpiry = Date.now() + 2 * 60 * 60 * 1000;
    return this.token;
  }

  // ---- 文件操作 (EFile API) ----

  /**
   * 上传文本文件到远程目录
   */
  async uploadText(
    remoteDir: string,
    filename: string,
    content: string,
  ): Promise<void> {
    const token = await this.getToken();
    const boundary = `----Boundary${Date.now()}`;

    const bodyParts: Buffer[] = [];
    // path 字段
    bodyParts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${remoteDir}\r\n`,
    ));
    // file 字段
    bodyParts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    ));
    bodyParts.push(Buffer.from(content));
    bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(bodyParts);
    const url = `${this.cluster!.efileUrl}/openapi/v2/file/upload`;

    // NOTE: 必须检查 EFile API 返回值，否则 Token 过期等错误会被静默吐掉
    const result = await this.httpRequest<{ code: string; msg: string; data: unknown }>(url, {
      method: "POST",
      headers: {
        token,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      rawBody: body,
    });
    if (result.code !== "0") {
      console.error(`[SCNet] ❌ 文件上传失败: ${filename} → ${remoteDir} | code=${result.code} msg=${result.msg}`);
      throw new Error(`EFile 上传失败 (${filename}): code=${result.code}, msg=${result.msg}`);
    }
  }

  /**
   * 上传二进制文件到远程目录
   */
  async uploadBinary(
    localPath: string,
    remoteDir: string,
  ): Promise<void> {
    const token = await this.getToken();
    const filename = basename(localPath);
    const fileData = readFileSync(localPath);
    const boundary = `----Boundary${Date.now()}`;

    const bodyParts: Buffer[] = [];
    bodyParts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${remoteDir}\r\n`,
    ));
    bodyParts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    ));
    bodyParts.push(fileData);
    bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(bodyParts);
    const url = `${this.cluster!.efileUrl}/openapi/v2/file/upload`;

    // NOTE: 必须检查 EFile API 返回值
    const result = await this.httpRequest<{ code: string; msg: string; data: unknown }>(url, {
      method: "POST",
      headers: {
        token,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      rawBody: body,
    });
    if (result.code !== "0") {
      console.error(`[SCNet] ❌ 文件上传失败: ${filename} → ${remoteDir} | code=${result.code} msg=${result.msg}`);
      throw new Error(`EFile 上传失败 (${filename}): code=${result.code}, msg=${result.msg}`);
    }
  }

  /**
   * 下载远程文件内容
   */
  async downloadFile(remotePath: string): Promise<string> {
    const token = await this.getToken();
    const url =
      `${this.cluster!.efileUrl}/openapi/v2/file/download?path=${encodeURIComponent(remotePath)}`;

    return await this.httpRequestRaw(url, {
      method: "GET",
      headers: { token },
    });
  }

  /**
   * 列出远程目录中的文件名
   *
   * NOTE: 用于 downloadResults 扫描所有 .out 文件
   * API 文档参考: docs/scnet-openapi/file/list.md
   * 响应格式: { code: "0", data: { fileList: [{ name, isDirectory, ... }] } }
   */
  async listRemoteDir(remotePath: string): Promise<Array<{ name: string; size: number; lastModifiedTime: string; isDirectory: boolean }>> {
    const token = await this.getToken();
    // NOTE: limit 和 start 是必填参数，limit=200 足以覆盖计算目录中的所有文件
    const url =
      `${this.cluster!.efileUrl}/openapi/v2/file/list` +
      `?path=${encodeURIComponent(remotePath)}&limit=200&start=0`;

    const result = await this.httpRequest<{
      code: string;
      data: {
        fileList: Array<{ name: string; isDirectory: boolean; size: number; lastModifiedTime: string }>;
        total: number;
      };
    }>(url, {
      method: "GET",
      headers: { token },
    });

    if (!result.data?.fileList || !Array.isArray(result.data.fileList)) return [];
    // NOTE: 不再过滤目录 — NEB 等多目录作业需要识别 00/ 01/ ... 子目录（Bug #16）
    // 调用方负责按 isDirectory 区分文件与目录
    return result.data.fileList
      .map(item => ({
        name: item.name,
        size: item.size,
        lastModifiedTime: item.lastModifiedTime,
        isDirectory: !!item.isDirectory,
      }));
  }

  /**
   * 预览远程文本文件内容（支持运行中的作业输出文件）
   *
   * NOTE: 通过 EFile preview API 读取文件内容，支持 startIndex 分页
   * 可用于实时监控计算输出（相当于 tail -f）
   * API 文档参考: docs/scnet-openapi/file/preview-file.md
   */
  async previewFile(
    remotePath: string,
    startIndex: number = 0,
  ): Promise<{ content: string; endIndex: number; hasNext: boolean }> {
    const token = await this.getToken();
    const url = `${this.cluster!.efileUrl}/openapi/v2/file/preview`;

    const body = new URLSearchParams({
      path: remotePath,
      force: "force",
      startIndex: String(startIndex),
    }).toString();

    const result = await this.httpRequest<{
      code: string;
      data: {
        content: string;
        endIndex: number;
        hasNext: boolean;
        path: string;
        startIndex: string;
      };
    }>(url, {
      method: "POST",
      headers: {
        token,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      rawBody: Buffer.from(body),
    });

    return {
      content: result.data?.content ?? "",
      endIndex: result.data?.endIndex ?? 0,
      hasNext: result.data?.hasNext ?? false,
    };
  }

  /**
   * 通过 EFile API 创建远程目录
   * NOTE: 使用 createParents=true 自动创建父目录，替代之前提交 SLURM 作业的方式
   */
  async createRemoteDir(remotePath: string): Promise<void> {
    const token = await this.getToken();
    const url =
      `${this.cluster!.efileUrl}/openapi/v2/file/mkdir?path=${encodeURIComponent(remotePath)}&createParents=true`;

    // NOTE: httpRequest 对非 0 code 不会 reject，必须手动检查返回值
    const result = await this.httpRequest<{ code: string; msg: string; data: unknown }>(url, {
      method: "POST",
      headers: {
        token,
        "Content-Type": "application/json",
      },
    });

    if (result.code === "0") {
      console.log(`[SCNet] 📁 远程目录已创建: ${remotePath}`);
    } else if (result.code === "911021") {
      // 目录已存在不算错误
      console.log(`[SCNet] 📁 远程目录已存在: ${remotePath}`);
    } else {
      console.error(`[SCNet] ❌ 创建远程目录失败: ${remotePath} | code=${result.code} msg=${result.msg}`);
      throw new Error(`创建远程目录失败 (${remotePath}): code=${result.code}, msg=${result.msg}`);
    }
  }

  // ---- 作业管理 (HPC API) ----

  /**
   * 提交 QE 计算作业
   *
   * 流程：
   * 1. 在远程创建工作目录（通过快速作业）
   * 2. 上传输入文件和作业脚本
   * 3. 提交计算作业
   */
  async submitQeJob(params: {
    localDir: string;
    inputFile: string;
    executable: string;
    taskId: string;
    /** Agent 指定的核数（来自 mpirun -np X），优先于自动计算 */
    nproc?: number;
    /** Agent 的原始命令字符串，支持多命令链（&& / ;） */
    rawCommand?: string;
    /** 会话 ID，同一会话内的作业共享 outdir（跨作业 tmp/ 共享） */
    sessionId?: string;
  }): Promise<SCNetTask> {
    if (!this.cluster) throw new Error("SCNet 未配置");

    const { localDir, inputFile, executable, taskId } = params;
    const remoteDir = `${this.cluster.homePath}/jobs/${taskId}`;

    // 1. 确定核数：Agent 指定 > 自动计算
    const isVaspJob = ["vasp_std", "vasp_gam", "vasp_ncl"].some((v) => executable.includes(v));
    const inputPath = join(localDir, inputFile);
    const inputInfo = (!isVaspJob && existsSync(inputPath))
      ? this.parseQeInput(readFileSync(inputPath, "utf-8"))
      : null;
    const coresPerNode = this.cluster?.maxCoresPerNode ?? 64;
    const maxJobCores = this.cluster?.maxCoresPerJob ?? coresPerNode;
    // Agent 指定核数 > 自动计算。指定值可超过单节点核数（自动跨节点 MPI），上限为 maxJobCores
    const nproc = params.nproc
      ? Math.min(params.nproc, maxJobCores)
      : this.selectCoreCount(inputInfo);   // 兜底：自动计算（≤ 单节点核数）
    // 跨节点：所需节点数 = ceil(总核数 / 每节点核数)。SLURM 分配多节点后，
    // mpirun -np <总核数> 由 Intel MPI 自动跨节点分发（已用 2 节点/128 核测试作业验证）
    const nnode = Math.max(1, Math.ceil(nproc / coresPerNode));

    // 2. 创建远程目录（通过 EFile mkdir API，不再提交 SLURM 作业）
    await this.createRemoteDir(remoteDir);
    await this.createRemoteDir(`${remoteDir}/tmp`);

    // 3. 上传输入文件
    // NOTE: 主输入文件需要替换 pseudo_dir 为 SCNet 集群的赝势目录路径，
    // 否则 QE 会找不到赝势文件（本地路径在超算上不存在）
    const filesToUpload = this.collectInputFiles(localDir, inputFile);

    // NOTE: 如果有多命令链，提取所有涉及的 .in 文件并上传
    if (params.rawCommand) {
      const extraInputs = [...params.rawCommand.matchAll(/(?:-i|-in)\s+(\S+\.in)/g)]
        .map(m => m[1]);
      for (const extra of extraInputs) {
        if (!filesToUpload.includes(extra) && existsSync(join(localDir, extra))) {
          filesToUpload.push(extra);
        }
      }
    }

    for (const file of filesToUpload) {
      const localFile = join(localDir, file);
      if (!existsSync(localFile)) continue;

      // NOTE: NEB 子目录文件（如 00/POSCAR）需要在远程创建对应子目录
      if (file.includes("/") || file.includes("\\")) {
        const subDir = dirname(file).replace(/\\/g, "/");
        await this.createRemoteDir(`${remoteDir}/${subDir}`);
      }

      // NOTE: 所有 .in 文件都替换 pseudo_dir（多命令链中可能有多个输入文件）
      if (file.endsWith(".in") && this.cluster!.pseudoDir) {
        let content = readFileSync(localFile, "utf-8");
        content = content.replace(
          /pseudo_dir\s*=\s*['"][^'"]*['"]/i,
          `pseudo_dir = '${this.cluster!.pseudoDir}'`,
        );
        // NOTE: Bug #14 修复 — 将 outdir 替换为共享 scratch 路径，
        // 使分步提交的 SCF/NSCF 作业能通过共享目录找到前序计算的 tmp/
        // 使用 sessionId 而非 taskId，确保同一对话内所有作业共享同一个 outdir
        const scratchDir = appConfig.scnetScratchDir;
        const scratchKey = params.sessionId || taskId; // 有 sessionId 用 sessionId，没有回退 taskId
        if (scratchDir) {
          const sharedOutdir = `${scratchDir}/${scratchKey}/tmp`;
          // NOTE: 必须预先创建 scratch 目录，否则 QE 启动时找不到 outdir 会直接报错
          await this.createRemoteDir(`${scratchDir}/${scratchKey}`);
          await this.createRemoteDir(sharedOutdir);
          content = content.replace(
            /outdir\s*=\s*['"][^'"]*['"]/i,
            `outdir = '${sharedOutdir}'`,
          );
        }
        await this.uploadText(remoteDir, file, content);
        console.log(
          `[SCNet] 📝 ${file} 已替换 pseudo_dir → ${this.cluster!.pseudoDir}` +
          (scratchDir ? ` | outdir → ${scratchDir}/${scratchKey}/tmp` : ""),
        );
      } else {
        // NOTE: NEB 子目录文件（如 00/POSCAR）必须上传到对应的远程子目录，
        // 否则多个同名文件（POSCAR）会在根目录冲突报 "File already exists"
        const uploadDir = (file.includes("/") || file.includes("\\"))
          ? `${remoteDir}/${dirname(file).replace(/\\/g, "/")}`
          : remoteDir;
        await this.uploadBinary(localFile, uploadDir);
      }
    }

    // 4. 生成并上传作业脚本
    // NOTE: outputFile 推导按引擎区分：
    //   VASP    → OUTCAR
    //   Gaussian → .gjf / .com → .log
    //   QE      → .in → .out
    // 旧实现 `inputFile.replace(".in", ".out")` 对 .gjf 输入是 no-op，
    // 导致 `g16 < scan.gjf > scan.gjf 2>&1` 直接截断输入文件。
    const isGaussianInput = inputFile.endsWith(".gjf") || inputFile.endsWith(".com");
    const outputFile = isVaspJob
      ? "OUTCAR"
      : isGaussianInput
        ? inputFile.replace(/\.(gjf|com)$/i, ".log")
        : inputFile.replace(/\.in$/i, ".out");

    // NOTE: VASP 需要读取 .potcar_meta.json 获取变体列表，直接硬编码到脚本中
    // 避免在超算上运行时依赖 python3 解析 JSON
    let potcarVariants: string[] | undefined;
    if (isVaspJob) {
      const metaPath = join(localDir, ".potcar_meta.json");
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
          potcarVariants = meta.variants as string[];
        } catch {
          console.warn("[SCNet] ⚠️ .potcar_meta.json 解析失败，POTCAR 拼接将跳过");
        }
      }
    }

    const jobScript = this.buildJobScript({
      remoteDir,
      inputFile,
      outputFile,
      executable,
      nproc,
      rawCommand: params.rawCommand,
      potcarVariants,
    });
    await this.uploadText(remoteDir, `run_${taskId}.sh`, jobScript);

    // 5. 提交计算作业
    const result = await this.submitRawJob({
      name: taskId,
      cmd: `bash ${remoteDir}/run_${taskId}.sh`,
      nproc,
      nnode,
      wallTime: "24:00:00",
      workDir: remoteDir,
      stdoutFile: `${remoteDir}/stdout.%j`,
      stderrFile: `${remoteDir}/stderr.%j`,
    });

    // NOTE: 必须检查提交结果，否则 Token 过期等错误会导致空 jobId
    if (result.code !== "0" || !result.data) {
      const msg = `作业提交 API 返回错误: code=${result.code}, data=${JSON.stringify(result.data)}`;
      console.error(`[SCNet] ❌ ${msg}`);
      throw new Error(msg);
    }

    const jobId = result.data as string;
    console.log(
      `[SCNet] 🚀 作业已提交: jobId=${jobId} | ${nproc} 核 (${nnode} 节点) | ${remoteDir}`,
    );

    const task: SCNetTask = {
      taskId,
      jobId,
      remoteDir,
      localDir,
      command: params.rawCommand ?? `${executable} -i ${inputFile}`,
      coresUsed: nproc,
      startedAt: Date.now(),
      outputFile,
      scriptPath: `${remoteDir}/run_${taskId}.sh`,
    };

    this.activeTasks.set(taskId, task);
    return task;
  }

  /**
   * 取消正在运行或排队的作业
   *
   * NOTE: 通过 SCNet HPC API DELETE /jobs 实现
   * API 文档参考: docs/scnet-openapi/job/control-job.md
   * 参数格式: jobMethod=5, strJobInfoMap=调度器ID,用户名:作业号:
   */
  async cancelJob(jobId: string): Promise<{ success: boolean; message: string }> {
    if (!this.cluster) throw new Error("SCNet 未配置");
    const token = await this.getToken();
    const cluster = this.cluster;

    // NOTE: strJobInfoMap 格式为 "调度器ID,用户名:作业号:"
    const strJobInfoMap = `${cluster.schedulerId},${this.credentials!.user}:${jobId}:`;

    // NOTE: Spring Boot 不解析 DELETE 请求的 body，参数必须放 query string
    const url =
      `${cluster.hpcUrl}/hpc/openapi/v2/jobs` +
      `?jobMethod=5&strJobInfoMap=${encodeURIComponent(strJobInfoMap)}`;

    try {
      const result = await this.httpRequest<{
        code: string;
        msg: string;
        data: Record<string, string>;
      }>(url, {
        method: "DELETE",
        headers: {
          token,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      console.log(`[SCNet] 🛑 作业 ${jobId} 取消请求已发送: ${JSON.stringify(result.data)}`);

      // 从活跃任务中移除
      for (const [taskId, task] of this.activeTasks) {
        if (task.jobId === jobId) {
          this.activeTasks.delete(taskId);
          break;
        }
      }

      return {
        success: result.code === "0",
        message: result.data?.[cluster.schedulerId] ?? result.msg ?? "未知响应",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, message: `取消失败: ${msg}` };
    }
  }

  /**
   * 提交原始作业（内部使用）
   */
  private async submitRawJob(params: {
    name: string;
    cmd: string;
    nproc: number;
    /** 节点数（默认 1；> 1 时为跨节点 MPI 作业） */
    nnode?: number;
    wallTime: string;
    workDir?: string;
    stdoutFile?: string;
    stderrFile?: string;
  }): Promise<{ code: string; data: unknown }> {
    const token = await this.getToken();
    const cluster = this.cluster!;

    const payload = {
      strJobManagerID: cluster.schedulerId,
      mapAppJobInfo: {
        GAP_CMD_FILE: params.cmd,
        GAP_NNODE: String(params.nnode ?? 1),
        GAP_NODE_STRING: "",
        GAP_SUBMIT_TYPE: "cmd",
        GAP_JOB_NAME: params.name,
        GAP_WORK_DIR: params.workDir ?? cluster.homePath,
        GAP_QUEUE: cluster.queue,
        GAP_NPROC: String(params.nproc),
        GAP_PPN: "",
        GAP_NGPU: "",
        GAP_NDCU: "",
        GAP_WALL_TIME: params.wallTime,
        GAP_EXCLUSIVE: "",
        GAP_APPNAME: "BASE",
        GAP_MULTI_SUB: "",
        GAP_STD_OUT_FILE: params.stdoutFile ?? `${cluster.homePath}/stdout.%j`,
        GAP_STD_ERR_FILE: params.stderrFile ?? `${cluster.homePath}/stderr.%j`,
      },
    };

    const url = `${cluster.hpcUrl}/hpc/openapi/v2/apptemplates/BASIC/BASE/job`;
    return await this.httpRequest(url, {
      method: "POST",
      headers: {
        token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }

  /**
   * 查询作业状态
   *
   * NOTE: SCNet API 使用 query 参数而非路径参数查询。
   * 先查实时作业列表（5 分钟内完成的也在里面），
   * 查不到再查历史作业列表（已归档的）。
   */
  async getJobStatus(jobId: string): Promise<SCNetJobStatus> {
    const token = await this.getToken();
    const schedulerId = this.cluster!.schedulerId;

    // 1. 查实时作业（运行中 / 排队中 / 最近 5 分钟完成的）
    try {
      const url =
        `${this.cluster!.hpcUrl}/hpc/openapi/v2/jobs` +
        `?strClusterIDList=${schedulerId}&strJobId=${jobId}`;
      const result = await this.httpRequest<{
        code: string;
        data: {
          total: number;
          list: Array<{
            jobId: string; jobStatus: string; jobName?: string;
            queue?: string; procNumUsed?: number; nodeUsed?: string;
            jobStartTime?: string; jobRunTime?: string;
            workDir?: string; reason?: string;
          }>;
        };
      }>(url, {
        method: "GET",
        headers: { token },
      });

      if (result.code === "0" && result.data?.list?.length > 0) {
        const job = result.data.list[0];
        const status = job.jobStatus ?? "unknown";
        return {
          jobId,
          status,
          isCompleted: status === "statC",
          isRunning: status === "statR",
          jobName: job.jobName,
          queue: job.queue,
          cores: job.procNumUsed,
          node: job.nodeUsed,
          startTime: job.jobStartTime,
          runTime: job.jobRunTime,
          workDir: job.workDir,
          reason: job.reason ?? undefined,
        };
      }
    } catch (e) {
      console.warn(`[SCNet] 实时作业查询异常: jobId=${jobId} | ${e instanceof Error ? e.message : e}`);
    }

    // 2. 查历史作业（已归档，超过 5 分钟的已完成作业）
    try {
      const now = new Date();
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const fmt = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
      const url =
        `${this.cluster!.hpcUrl}/hpc/openapi/v2/historyjobs` +
        `?strClusterIDList=${schedulerId}` +
        `&jobId=${jobId}` +
        `&timeType=CUSTOM` +
        `&startTime=${encodeURIComponent(fmt(monthAgo))}` +
        `&endTime=${encodeURIComponent(fmt(now))}` +
        `&start=0&limit=1&isQueryByQueueTime=false`;
      const result = await this.httpRequest<{
        code: string;
        data: {
          total: number;
          list: Array<{
            jobId: string; jobState: string; jobName?: string;
            queue?: string; procNumUsed?: number; nodeUsed?: string;
            jobStartTime?: string; jobRunTime?: string;
            workDir?: string; reason?: string;
          }>;
        };
      }>(url, {
        method: "GET",
        headers: { token },
      });

      if (result.code === "0" && result.data?.list?.length > 0) {
        const job = result.data.list[0];
        const status = job.jobState ?? "unknown";
        return {
          jobId,
          status,
          isCompleted: status === "statC",
          isRunning: status === "statR",
          jobName: job.jobName,
          queue: job.queue,
          cores: job.procNumUsed,
          node: job.nodeUsed,
          startTime: job.jobStartTime,
          runTime: job.jobRunTime,
          workDir: job.workDir,
          reason: job.reason ?? undefined,
        };
      }
    } catch (e) {
      console.warn(`[SCNet] 历史作业查询异常: jobId=${jobId} | ${e instanceof Error ? e.message : e}`);
    }

    // 3. 都查不到
    return {
      jobId,
      status: "unknown",
      isCompleted: false,
      isRunning: false,
    };
  }

  /**
   * 查询作业列表（实时 + 历史）
   *
   * @param limit 最大返回条数
   * @returns 作业列表，按时间倒序
   */
  async listJobs(limit: number = 10): Promise<Array<{ jobId: string; status: string; jobName: string; queue?: string }>> {
    const token = await this.getToken();
    const schedulerId = this.cluster!.schedulerId;
    const jobs: Array<{ jobId: string; status: string; jobName: string; queue?: string }> = [];

    // 1. 实时作业
    try {
      const url =
        `${this.cluster!.hpcUrl}/hpc/openapi/v2/jobs` +
        `?strClusterIDList=${schedulerId}&start=0&limit=${limit}`;
      const result = await this.httpRequest<{
        code: string;
        data: { list: Array<{ jobId: string; jobStatus: string; jobName: string; queue: string }> };
      }>(url, {
        method: "GET",
        headers: { token },
      });

      if (result.code === "0" && result.data?.list) {
        for (const j of result.data.list) {
          jobs.push({ jobId: j.jobId, status: j.jobStatus, jobName: j.jobName, queue: j.queue });
        }
      }
    } catch (e) {
      console.warn(`[SCNet] 实时作业列表查询失败: ${e instanceof Error ? e.message : e}`);
    }

    // 2. 补充历史作业（如果实时不够）
    if (jobs.length < limit) {
      try {
        const now = new Date();
        const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const fmt = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
        const url =
          `${this.cluster!.hpcUrl}/hpc/openapi/v2/historyjobs` +
          `?strClusterIDList=${schedulerId}` +
          `&timeType=CUSTOM` +
          `&startTime=${encodeURIComponent(fmt(monthAgo))}` +
          `&endTime=${encodeURIComponent(fmt(now))}` +
          `&start=0&limit=${limit - jobs.length}` +
          `&isQueryByQueueTime=false&sort=DESC&orderBy=jobId`;
        const result = await this.httpRequest<{
          code: string;
          data: { list: Array<{ jobId: string; jobState: string; jobName: string; queue: string }> };
        }>(url, {
          method: "GET",
          headers: { token },
        });

        if (result.code === "0" && result.data?.list) {
          const existingIds = new Set(jobs.map(j => j.jobId));
          for (const j of result.data.list) {
            if (!existingIds.has(j.jobId)) {
              jobs.push({ jobId: j.jobId, status: j.jobState, jobName: j.jobName, queue: j.queue });
            }
          }
        }
      } catch (e) {
        console.warn(`[SCNet] 历史作业列表查询失败: ${e instanceof Error ? e.message : e}`);
      }
    }

    return jobs;
  }

  /**
   * 下载计算结果到本地
   *
   * NOTE: 扫描远程目录中所有计算产出文件并下载，不仅限 .out
   * 下载规则：排除 tmp/ 目录、作业脚本（run_*.sh）、stdout/stderr 管理文件
   * 包含：.out / .dat / .gnu / pdos* / ACF.dat / .freq / .xml 等
   */
  async downloadResults(
    task: SCNetTask,
    onProgress?: (msg: string) => void,
    opts?: { includeSubdirs?: boolean },
  ): Promise<string[]> {
    const downloaded: string[] = [];

    // NOTE: 覆盖 QE 全系列后处理程序的产出文件
    const DOWNLOAD_EXTENSIONS = new Set([
      // ----- QE 文件 -----
      // pw.x 主输出
      ".out",
      // 数据文件（dos.dat / bands.dat / charge.dat 等）
      ".dat",
      // gnuplot 格式（bands.x 产出）
      ".gnu", ".gp",
      // dos.x 态密度
      ".dos",
      // ph.x 声子：动力学矩阵 + 频率
      ".dyn", ".freq",
      // q2r.x 力常数
      ".fc",
      // matdyn.x 声子色散
      ".modes",
      // pp.x 后处理：Gaussian cube 格式（电荷密度、波函数可视化）
      ".cube",
      // QE XML 输出（data-file-schema.xml）
      ".xml",
      // hp.x Hubbard 参数
      ".Hubbard",
      // projwfc.x Löwdin 分析
      ".lowdin",
      // neb.x 过渡态
      ".path", ".axsf", ".crd",

      // ----- Gaussian 文件 -----
      ".log", ".chk", ".fchk",
    ]);

    // NOTE: 基于文件名的额外匹配规则（无固定扩展名的产出）
    const shouldDownload = (filename: string): boolean => {
      // 按扩展名匹配
      for (const ext of DOWNLOAD_EXTENSIONS) {
        if (filename.endsWith(ext)) return true;
      }
      // ----- VASP 输出（按文件名匹配，无扩展名） -----
      const VASP_OUTPUT_FILES = new Set([
        "OUTCAR", "OSZICAR", "CONTCAR", "EIGENVAL", "DOSCAR",
        "PROCAR", "CHGCAR", "WAVECAR", "vasprun.xml",
        "XDATCAR",  // MD 轨迹
      ]);
      if (VASP_OUTPUT_FILES.has(filename)) return true;

      // pdos 文件没有固定扩展名（如 prefix.pdos_atm#1(C)_wfc#1(s)）
      if (filename.includes("pdos")) return true;
      // Bader 分析产出
      if (filename === "ACF.dat" || filename === "BCF.dat" || filename === "AVF.dat") return true;
      // ph.x 电声耦合（elph.inp.* / elph_dir/）
      if (filename.startsWith("elph")) return true;
      // epsilon.x 介电函数（epsi_*.dat / epsr_*.dat）
      if (filename.startsWith("epsi") || filename.startsWith("epsr")) return true;
      // turbo_lanczos.x TDDFT 响应（plot_chi.*）
      if (filename.startsWith("plot_chi")) return true;
      // ph.x 动力学矩阵编号文件（如 prefix.dyn1, prefix.dyn2, ...）
      if (/\.dyn\d+$/.test(filename)) return true;
      return false;
    };

    // NOTE: 需要排除的文件（作业管理相关，不是计算产出）
    const shouldExclude = (filename: string): boolean => {
      if (filename.startsWith("run_") && filename.endsWith(".sh")) return true;
      if (filename.startsWith("stdout.") || filename.startsWith("stderr.")) return true;
      return false;
    };

    // NOTE: NEB 等多目录作业的 image 子目录还需要 POSCAR（初始几何），
    // shouldDownload 默认不含 POSCAR（属输入文件），子目录单独放行（Bug #16）
    const shouldDownloadInSubdir = (filename: string): boolean =>
      shouldDownload(filename) || filename === "POSCAR";

    const formatSize = (bytes: number) => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    };

    let nSubdirs = 0;

    try {
      const remoteEntries = await this.listRemoteDir(task.remoteDir);
      const remoteFileInfos = remoteEntries.filter(e => !e.isDirectory);
      const remoteFiles = remoteFileInfos.map(f => f.name);
      const targetFiles = remoteFiles.filter(f =>
        shouldDownload(f) && !shouldExclude(f),
      );

      // NOTE: 利用远程文件列表中的 size 字段估算总下载量
      const sizeMap = new Map(remoteFileInfos.map(f => [f.name, f.size]));
      const totalBytes = targetFiles.reduce((s, f) => s + (sizeMap.get(f) ?? 0), 0);

      console.log(
        `[SCNet] 📋 远程根目录共 ${remoteFiles.length} 个文件，匹配下载 ${targetFiles.length} 个 (${formatSize(totalBytes)})`,
      );

      let downloadedBytes = 0;
      for (let idx = 0; idx < targetFiles.length; idx++) {
        const file = targetFiles[idx];
        const fileSize = sizeMap.get(file) ?? 0;
        try {
          const progressMsg = `⬇️ [${idx + 1}/${targetFiles.length}] ${file} (${formatSize(fileSize)})...`;
          console.log(`[SCNet] ${progressMsg}`);
          onProgress?.(progressMsg);

          const content = await this.downloadFile(
            `${task.remoteDir}/${file}`,
          );
          const localPath = join(task.localDir, file);
          writeFileSync(localPath, content, "utf-8");
          downloadedBytes += fileSize;
          downloaded.push(file);

          const pct = totalBytes > 0 ? Math.round(downloadedBytes / totalBytes * 100) : 100;
          const doneMsg = `✅ [${idx + 1}/${targetFiles.length}] ${file} | ${formatSize(downloadedBytes)}/${formatSize(totalBytes)} (${pct}%)`;
          console.log(`[SCNet] ${doneMsg}`);
          onProgress?.(doneMsg);
        } catch (err) {
          console.error(`[SCNet] ❌  [${idx + 1}/${targetFiles.length}] ${file} 失败:`, err);
        }
      }

      // NOTE: Bug #16 修复 — 递归下载子目录的计算产出。
      // 默认只下 NEB image 子目录（两位数字命名，如 00/ 01/ ... 0N/，VASP NEB 约定），
      // includeSubdirs=true 时下载所有非 tmp 子目录。
      // 之前只下根目录日志，NEB 的能量/结构/力全在 image 子目录里 → 静默数据缺失。
      const subdirs = remoteEntries.filter(e =>
        e.isDirectory &&
        e.name !== "tmp" && e.name !== "." && e.name !== ".." &&
        (opts?.includeSubdirs === true || /^\d{2,3}$/.test(e.name)),
      );

      for (const sub of subdirs) {
        const subRemote = `${task.remoteDir}/${sub.name}`;
        const subLocal = join(task.localDir, sub.name);
        try {
          const subEntries = await this.listRemoteDir(subRemote);
          const subTargets = subEntries.filter(e =>
            !e.isDirectory && shouldDownloadInSubdir(e.name) && !shouldExclude(e.name),
          );
          if (subTargets.length === 0) continue;

          mkdirSync(subLocal, { recursive: true });
          const subMsg = `📁 子目录 ${sub.name}/ : 下载 ${subTargets.length} 个文件`;
          console.log(`[SCNet] ${subMsg}`);
          onProgress?.(subMsg);

          for (const e of subTargets) {
            try {
              const content = await this.downloadFile(`${subRemote}/${e.name}`);
              writeFileSync(join(subLocal, e.name), content, "utf-8");
              downloaded.push(`${sub.name}/${e.name}`);
            } catch (err) {
              console.error(`[SCNet] ❌ ${sub.name}/${e.name} 失败:`, err);
            }
          }
          nSubdirs++;
        } catch (err) {
          console.error(`[SCNet] ❌ 列出子目录 ${sub.name}/ 失败:`, err);
        }
      }

      if (nSubdirs > 0) {
        const msg = `📦 已递归下载 ${nSubdirs} 个子目录（NEB image / 多目录作业）`;
        console.log(`[SCNet] ${msg}`);
        onProgress?.(msg);
      }
    } catch {
      // 列目录失败，回退到下载主输出文件
      if (task.outputFile) {
        try {
          const content = await this.downloadFile(
            `${task.remoteDir}/${task.outputFile}`,
          );
          const localPath = join(task.localDir, task.outputFile);
          writeFileSync(localPath, content, "utf-8");
          downloaded.push(task.outputFile);
        } catch (err) {
          console.error(`[SCNet] 下载 ${task.outputFile} 失败:`, err);
        }
      }
    }

    // 下载 stdout/stderr（作业管理文件，用于调试）
    // NOTE: jobId 为空时（如仅凭 remote_dir 重建的任务）跳过，避免无意义的 404
    if (task.jobId) {
      for (const suffix of ["stdout", "stderr"]) {
        try {
          const content = await this.downloadFile(
            `${task.remoteDir}/${suffix}.${task.jobId}`,
          );
          writeFileSync(
            join(task.localDir, `${suffix}.${task.jobId}`),
            content,
            "utf-8",
          );
          downloaded.push(`${suffix}.${task.jobId}`);
        } catch {
          // 可能不存在
        }
      }
    }

    console.log(
      `[SCNet] 📥 下载完成: ${downloaded.length} 个文件${nSubdirs > 0 ? `（含 ${nSubdirs} 个子目录）` : ""} → ${task.localDir}`,
    );
    return downloaded;
  }

  // ---- 并行策略 ----

  /**
   * 根据体系大小智能选择核数
   *
   * 基于约 64 核/节点的常见配置优化
   */
  selectCoreCount(inputInfo: QeInputInfo | null): number {
    if (!inputInfo) return 8;

    const { nat, nk } = inputInfo;
    const maxCores = this.cluster?.maxCoresPerNode ?? 64;

    // NOTE: 小体系多核通信开销大于收益
    if (nat <= 10) return Math.min(8, maxCores);
    if (nat <= 30) return Math.min(16, maxCores);
    if (nat <= 60) return Math.min(32, maxCores);
    // 大体系，如果 k 点够多可以用满节点
    if (nk >= 16) return Math.min(64, maxCores);
    return Math.min(32, maxCores);
  }

  // ---- 作业脚本生成 ----

  /**
   * 生成 SLURM 作业脚本
   *
   * NOTE: 使用上传脚本 + bash 执行的模式，
   * 因为 GAP_CMD_FILE 中的 \n 换行不可靠
   *
   * 支持两种模式：
   * 1. 单命令模式：根据 executable/inputFile 生成标准 mpirun 命令
   * 2. 原始命令透传：支持 Agent 传入的多命令链（&& / ; 等）
   */
  private buildJobScript(params: {
    remoteDir: string;
    inputFile: string;
    outputFile: string;
    executable: string;
    nproc: number;
    /** Agent 的原始命令字符串，包含多命令链时使用 */
    rawCommand?: string;
    /** VASP POTCAR 变体列表，直接硬编码到脚本中避免运行时 JSON 解析 */
    potcarVariants?: string[];
  }): string {
    const { remoteDir, inputFile, outputFile, executable, nproc, rawCommand } = params;
    const cluster = this.cluster!;

    // NOTE: 根据可执行文件检测引擎类型，加载对应环境
    const cmd = rawCommand ?? executable;
    const isVasp = ["vasp_std", "vasp_gam", "vasp_ncl"].some((v) => cmd.includes(v));
    const isGaussian = ["g16", "formchk", "cubegen"].some((v) => cmd.includes(v));
    // 默认 QE
    const qeBinDir = cluster.qePath.replace(/\/pw\.x$/, "");

    // 选择环境脚本
    let envScript: string;
    let envLabel: string;
    if (isVasp) {
      envScript = appConfig.scnetVaspEnvScript;
      envLabel = "VASP";
    } else if (isGaussian) {
      envScript = appConfig.scnetGaussianEnvScript;
      envLabel = "Gaussian";
    } else {
      envScript = cluster.qeEnvScript;
      envLabel = "QE";
    }

    // 公共头部：环境初始化
    const header = [
      "#!/bin/bash",
      `# DFT AutoPilot — SCNet 自动生成作业脚本 (${envLabel})`,
      `# 生成时间: ${new Date().toISOString()}`,
      "",
      `# 加载 ${envLabel} 环境`,
      "module use /public/software/modules/base /public/software/modules/apps",
      `source ${envScript}`,
      "",
      `cd ${remoteDir}`,
      "",
      `echo "=== 开始时间: $(date) ==="`,
      `echo "=== 主机: $(hostname) ==="`,
      `echo "=== 核数: ${nproc} ==="`,
      "",
    ];

    // VASP 特殊处理：从 POTCAR 库拼接 POTCAR
    // NOTE: 不再依赖 python3 解析 JSON，直接将变体列表硬编码到脚本中
    if (isVasp && params.potcarVariants && params.potcarVariants.length > 0) {
      const potcarDir = appConfig.scnetPotcarDir;
      header.push(
        "# 拼接 POTCAR",
        `POTCAR_DIR="${potcarDir}"`,
        `> ${remoteDir}/POTCAR`,
        ...params.potcarVariants.map((v) =>
          `cat "$POTCAR_DIR/${v}/POTCAR" >> ${remoteDir}/POTCAR`
        ),
        `echo "POTCAR 拼接完成: $(wc -l < ${remoteDir}/POTCAR) 行 (元素: ${params.potcarVariants.join(" + ")})"`,
        "",
      );
    }

    let commandLines: string[];

    if (rawCommand && (rawCommand.includes("&&") || rawCommand.includes(";"))) {
      // NOTE: 多命令链模式 — 透传 Agent 原始命令
      let remoteCmd = rawCommand;

      // Bug 修复：去掉命令中的 cd /本地路径 前缀
      // NOTE: Agent 常用 `cd /www/wwwroot/.../workdir && mpirun ...` 格式，
      // 但该路径是本地服务器路径，在超算上不存在。
      // 脚本头部已有 `cd ${remoteDir}`，所以命令中的 cd 前缀多余且有害。
      remoteCmd = remoteCmd.replace(/^cd\s+\S+\s*(?:&&|;)\s*/, "");

      if (isVasp) {
        // VASP 不需要路径替换，vasp_std 从 env.sh 加载后在 PATH 中
        commandLines = [
          `# 执行 ${envLabel} 计算（多命令链）`,
          remoteCmd,
        ];
      } else if (isGaussian) {
        // Gaussian 的输入/输出文件路径替换
        remoteCmd = remoteCmd.replace(
          /(\S+\.gjf)/g,
          `${remoteDir}/$1`,
        );
        remoteCmd = remoteCmd.replace(
          /> *(\S+\.log)/g,
          `> ${remoteDir}/$1`,
        );
        commandLines = [
          `# 执行 ${envLabel} 计算（多命令链）`,
          remoteCmd,
        ];
      } else {
        // QE：替换可执行文件为全路径
        for (const exe of ["pw.x", "ph.x", "pp.x", "dos.x", "bands.x", "projwfc.x", "hp.x", "neb.x", "matdyn.x", "q2r.x", "dynmat.x", "epsilon.x"]) {
          const escaped = exe.replace(".", "\\.");
          remoteCmd = remoteCmd.replace(
            new RegExp(`(?<![/\\\\w])${escaped}`, "g"),
            `${qeBinDir}/${exe}`,
          );
        }
        remoteCmd = remoteCmd.replace(
          /(-i|-in)\s+(\S+\.in)/g,
          (_, flag, file) => `${flag} ${remoteDir}/${file}`,
        );
        remoteCmd = remoteCmd.replace(
          />\s*(\S+\.out)/g,
          (_, file) => `> ${remoteDir}/${file}`,
        );
        commandLines = [
          `# 执行 ${envLabel} 计算（多命令链）`,
          remoteCmd,
        ];
      }

      console.log(`[SCNet] 🔗 ${envLabel} 多命令链作业脚本: ${remoteCmd.slice(0, 200)}`);
    } else {
      // 单命令模式
      if (isVasp) {
        commandLines = [
          `# 执行 ${envLabel} 计算`,
          `mpirun -np ${nproc} ${executable}`,
        ];
      } else if (isGaussian) {
        commandLines = [
          `# 执行 ${envLabel} 计算`,
          `${executable} < ${remoteDir}/${inputFile} > ${remoteDir}/${outputFile} 2>&1`,
        ];
      } else {
        commandLines = [
          `# 执行 ${envLabel} 计算`,
          `mpirun -np ${nproc} ${qeBinDir}/${executable} \\`,
          `  -i ${remoteDir}/${inputFile} \\`,
          `  > ${remoteDir}/${outputFile} 2>&1`,
        ];
      }
    }

    const footer = [
      "",
      `echo "=== 结束时间: $(date) ==="`,
      `echo "=== 退出码: $? ==="`,
    ];

    return [...header, ...commandLines, ...footer].join("\n");
  }

  // ---- 输入文件解析 ----

  parseQeInput(content: string): QeInputInfo {
    const getVal = (key: string): string | undefined => {
      const match = new RegExp(`${key}\\s*=\\s*([^,\\n]+)`, "i").exec(content);
      return match?.[1]?.trim().replace(/['"]/g, "");
    };

    const nat = parseInt(getVal("nat") ?? "0", 10);
    const calculation = getVal("calculation") ?? "scf";

    let nk = 1;
    const autoMatch =
      /K_POINTS\s*(?:\{?\s*automatic\s*\}?)?\s*\n\s*(\d+)\s+(\d+)\s+(\d+)/i.exec(
        content,
      );
    if (autoMatch) {
      nk = Math.ceil(
        (parseInt(autoMatch[1]) *
          parseInt(autoMatch[2]) *
          parseInt(autoMatch[3])) /
          2,
      );
    }

    return { nat, nk, calculation };
  }

  /** 收集需要上传的输入文件 */
  private collectInputFiles(localDir: string, mainInput: string): string[] {
    const files: string[] = [mainInput];
    try {
      for (const f of readdirSync(localDir)) {
        if (
          !files.includes(f) &&
          (
            // QE 文件
            f.endsWith(".in") || f.endsWith(".Hubbard") || f === "hubbard.dat" ||
            // VASP 文件
            f === "INCAR" || f === "POSCAR" || f === "KPOINTS" || f === ".potcar_meta.json" ||
            // Gaussian 文件
            f.endsWith(".gjf") || f.endsWith(".com")
          )
        ) {
          files.push(f);
        }

        // NOTE: NEB 多目录结构 — 扫描 00/ 01/ ... 子目录中的 POSCAR
        const subPath = join(localDir, f);
        if (/^\d{2}$/.test(f) && statSync(subPath).isDirectory()) {
          const poscarPath = join(subPath, "POSCAR");
          if (existsSync(poscarPath)) {
            // 使用相对路径，保留目录结构
            files.push(`${f}/POSCAR`);
          }
        }
      }
    } catch {
      // 目录读取失败
    }
    return files;
  }

  // ---- 状态查询 ----

  getTask(taskId: string): SCNetTask | undefined {
    return this.activeTasks.get(taskId);
  }

  getActiveTasks(): SCNetTask[] {
    return Array.from(this.activeTasks.values());
  }

  releaseTask(taskId: string): void {
    this.activeTasks.delete(taskId);
  }

  // ---- HTTP 工具 ----

  // ---- 瞬时网络错误重试（Bug #3） ----

  /**
   * 仅"请求肯定未发出"的错误 — 重试绝对安全（不会重复执行非幂等操作如作业提交）
   * 文档 #3 的 "socket disconnected before secure TLS connection" 即属此类（握手前断开）
   */
  private isPreSendError(msg: string): boolean {
    return /socket disconnected before secure TLS connection|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg);
  }

  /** 更宽泛的瞬时错误 — 仅对幂等请求（GET）重试，避免 POST 重复提交 */
  private isTransientError(msg: string): boolean {
    return this.isPreSendError(msg) || /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|超时|timeout|\bTLS\b/i.test(msg);
  }

  /**
   * 带指数退避的重试包装。
   *
   * - 预发送错误（握手前断开/拒连/DNS）：任何方法都重试，因为请求确定没到服务端。
   * - 其他瞬时错误（连接重置/超时等）：仅幂等请求（GET）重试，POST/DELETE 不重试，
   *   防止作业被重复提交、文件被重复创建。
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    label: string,
    idempotent: boolean,
    maxAttempts = 3,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        const retriable = this.isPreSendError(msg) || (idempotent && this.isTransientError(msg));
        if (!retriable || attempt === maxAttempts) {
          if (this.isTransientError(msg)) {
            throw new Error(
              `${label} 网络连接失败（已重试 ${attempt} 次）：${msg}。` +
              "若持续出现，可能是 MCP 到 SCNet 的连接池失效，建议重启 MCP 服务。",
            );
          }
          throw e;
        }
        const backoff = 500 * 2 ** (attempt - 1); // 500ms → 1s → 2s
        console.warn(`[SCNet] ⚠️ ${label} 第 ${attempt} 次失败（${msg}），${backoff}ms 后重试...`);
        await this.sleep(backoff);
      }
    }
    throw lastErr;
  }

  private httpRequest<T = { code: string; data: unknown; msg: string }>(
    urlStr: string,
    opts: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      rawBody?: Buffer;
    },
  ): Promise<T> {
    // NOTE: GET 视为幂等可重试；POST/DELETE 仅在预发送错误时重试（Bug #3）
    return this.withRetry(
      () => this.httpRequestOnce<T>(urlStr, opts),
      `${opts.method} ${new URL(urlStr).pathname}`,
      opts.method.toUpperCase() === "GET",
    );
  }

  private httpRequestOnce<T = { code: string; data: unknown; msg: string }>(
    urlStr: string,
    opts: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      rawBody?: Buffer;
    },
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: opts.method,
        headers: opts.headers,
        rejectUnauthorized: false,
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data) as T;
            resolve(parsed);
          } catch {
            reject(new Error(`JSON 解析失败: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on("error", reject);
      req.setTimeout(30_000, () => {
        req.destroy();
        reject(new Error("请求超时"));
      });

      if (opts.rawBody) {
        req.write(opts.rawBody);
      } else if (opts.body) {
        req.write(opts.body);
      }
      req.end();
    });
  }

  private httpRequestRaw(
    urlStr: string,
    opts: { method: string; headers: Record<string, string> },
  ): Promise<string> {
    return this.withRetry(
      () => this.httpRequestRawOnce(urlStr, opts),
      `${opts.method} ${new URL(urlStr).pathname}`,
      opts.method.toUpperCase() === "GET",
    );
  }

  private httpRequestRawOnce(
    urlStr: string,
    opts: { method: string; headers: Record<string, string> },
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: opts.method,
        headers: opts.headers,
        rejectUnauthorized: false,
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => resolve(data));
      });

      req.on("error", reject);
      req.setTimeout(30_000, () => {
        req.destroy();
        reject(new Error("下载超时"));
      });
      req.end();
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---- 运行时巡检 API（Watchdog + RuntimeDecision 使用） ----

  /**
   * 读取远程文件内容（支持运行中作业）
   *
   * NOTE: 使用 HPC read-file-context API，不依赖作业完成状态。
   * 这是 Watchdog 实时解析的核心 —— 在作业运行中读取 .out 文件尾部，
   * 提取 SCF/force/energy 趋势数据供 Agent 巡检判断。
   *
   * @param remotePath 远程文件绝对路径（如 /work/home/.../jobs/taskId/scf.out）
   * @param triggerNum 分页页码（每页 1000 行），第一次传 1
   * @param rollDirection UP = 从文件尾部向上读（推荐，读最新数据），DOWN = 从头部向下读
   * @returns 文件内容字符串，失败返回 null
   */
  async readFileContent(
    remotePath: string,
    triggerNum: number = 1,
    rollDirection: "UP" | "DOWN" = "UP",
  ): Promise<{ content: string; totalLines: number } | null> {
    const token = await this.getToken();
    const url = `${this.cluster!.hpcUrl}/hpc/openapi/v2/file/content`;

    try {
      const result = await this.httpRequest<{
        code: string;
        data: {
          data: string;
          allLineTotal: number;
          success: string;
          totalTriggerTimes: number;
          errmsg: string;
        };
      }>(url, {
        method: "POST",
        headers: {
          token,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body:
          `dirPath=${encodeURIComponent(remotePath)}` +
          `&triggerNum=${triggerNum}` +
          `&rollDirection=${rollDirection}`,
      });

      if (result.data?.success === "true" && result.data.data) {
        return {
          content: result.data.data,
          totalLines: result.data.allLineTotal ?? 0,
        };
      }
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[SCNet] 远程文件读取失败: ${remotePath} | ${msg}`);
      return null;
    }
  }

  /**
   * 终止运行中的作业
   *
   * NOTE: 使用 HPC DELETE /jobs API（jobMethod=5）。
   * RuntimeDecision 的 STOP_AND_REPORT / KILL_AND_RESTART / FINAL_SCF_NOW
   * 等动作会调用此方法终止不值得继续的计算。
   *
   * @param jobId SCNet 作业 ID
   * @returns 是否成功终止
   */
  async killJob(jobId: string): Promise<boolean> {
    if (!this.cluster || !this.credentials) {
      console.error("[SCNet] 未配置，无法终止作业");
      return false;
    }

    const token = await this.getToken();
    const schedulerId = this.cluster.schedulerId;
    const user = this.credentials.user;
    // NOTE: 格式参照 SCNet OpenAPI control-job.md
    // 单作业：调度器ID,用户名:作业号:
    // 多作业用分号分隔：调度器ID,用户名:作业号1:;调度器ID,用户名:作业号2:
    const strJobInfoMap = `${schedulerId},${user}:${jobId}:`;

    try {
      // NOTE: Spring Boot 不解析 DELETE 请求的 body，参数必须放 query string
      const url =
        `${this.cluster.hpcUrl}/hpc/openapi/v2/jobs` +
        `?jobMethod=5&strJobInfoMap=${encodeURIComponent(strJobInfoMap)}`;
      console.log(`[SCNet] 发送终止请求: jobId=${jobId} | strJobInfoMap=${strJobInfoMap}`);

      const result = await this.httpRequest<{ code: string; msg: string; data: unknown }>(url, {
        method: "DELETE",
        headers: {
          token,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      // NOTE: 必须检查 API 响应，code==="0" 才是真正成功
      console.log(`[SCNet] 终止作业响应: jobId=${jobId} | code=${result.code} | msg=${result.msg} | data=${JSON.stringify(result.data)}`);

      if (result.code === "0") {
        console.log(`[SCNet] 🛑 作业已终止: jobId=${jobId}`);
        return true;
      } else {
        console.error(`[SCNet] 终止作业失败: jobId=${jobId} | API 返回 code=${result.code}, msg=${result.msg}`);
        return false;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SCNet] 终止作业异常: jobId=${jobId} | ${msg}`);
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// 全局单例
// ---------------------------------------------------------------------------

/** 全局 SCNet 管理器实例 */
export const scnetManager = new SCNetManager();
