/**
 * DFT AutoPilot — 工具基类与统一返回值定义
 *
 * 设计原则：
 * - 每个工具是独立的单职责单元
 * - 统一的 ToolResult 返回格式，含 display 字段供前端渲染
 * - 内建审计日志：每次 call 自动记录输入参数
 * - validate_input 提前拦截不合法参数
 */

import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// ToolResult — 统一返回值
// ---------------------------------------------------------------------------

export interface ToolResult {
  /** 是否成功 */
  success: boolean;
  /** 工具输出的结构化数据（Agent 消费） */
  data?: unknown;
  /** 失败时的错误信息 */
  error?: string;
  /** 面向前端的审计卡内容，Markdown 格式 */
  display?: string;
  /** 审计元数据，记录参数来源与理由 */
  audit?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// OpenAI Function Calling 格式
// ---------------------------------------------------------------------------

export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// DFTTool — 工具抽象基类
// ---------------------------------------------------------------------------

export abstract class DFTTool {
  /**
   * 审计日志根目录，由上层注入
   * 默认 workspace/.audit/
   */
  auditDir?: string;

  /** 工作区根目录，由上层注入 */
  workspaceDir?: string;

  /**
   * 进度通知回调，由 MCP 适配器层注入
   *
   * NOTE: 用于长时间运行的工具（如下载），向客户端推送实时进度。
   * 工具内部调用 this.notifyProgress?.("进度信息") 即可。
   */
  notifyProgress?: (message: string) => void;

  // ------- 子类必须实现 -------

  /** 工具名称，LLM 通过此名称调用 */
  abstract readonly name: string;

  /** 工具功能描述，用于 LLM 判断何时调用 */
  abstract readonly description: string;

  /** JSON Schema 格式的参数定义 */
  abstract readonly inputSchema: Record<string, unknown>;

  /** 执行核心业务逻辑 */
  abstract execute(args: Record<string, unknown>): Promise<ToolResult>;

  // ------- 可选覆写 -------

  /** 参数校验。返回 null 表示通过，否则返回错误信息 */
  validateInput(_args: Record<string, unknown>): string | null {
    return null;
  }

  /** 是否只读操作 */
  get isReadOnly(): boolean {
    return false;
  }

  // ------- 公共接口 -------

  /**
   * 工具调用入口（Template Method）
   *
   * 执行流程：validate → execute → audit
   */
  async call(args: Record<string, unknown>): Promise<ToolResult> {
    const startTime = performance.now();

    // NOTE: 未知参数检测 — 防止 Agent 用错参数名导致静默失败
    // 例如传了 file_path 而不是 filename，工具不会报错但功能不符预期
    const unknownParams = this.detectUnknownParams(args);

    // 参数校验
    const validationError = this.validateInput(args);
    if (validationError) {
      const result: ToolResult = {
        success: false,
        error: `参数校验失败: ${validationError}`,
      };
      await this.recordAudit(args, result, startTime);
      return result;
    }

    // 执行
    let result: ToolResult;
    try {
      result = await this.execute(args);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[${this.name}] 执行异常: ${errMsg}`);
      result = {
        success: false,
        error: `工具执行异常: ${errMsg}`,
      };
    }

    // 将未知参数警告附加到结果中
    // NOTE: 对近似参数名（如 potcar vs potcar_variants）直接报错中断，
    // 防止因参数名拼错导致使用默认值而产生错误结果（Bug: POTCAR 选错变体）
    if (unknownParams.length > 0) {
      const knownParams = this.getKnownParams();
      const suggestions = unknownParams.map(unknown => {
        const match = this.findClosestParam(unknown, knownParams);
        return match ? `${unknown} → 是否想用 "${match}"?` : unknown;
      });

      // 如果有高度相似的参数，说明用户可能拼错了 → 报错中断
      const hasSimilar = unknownParams.some(
        u => this.findClosestParam(u, knownParams) !== null,
      );
      if (hasSimilar) {
        const result: ToolResult = {
          success: false,
          error:
            `参数名错误: ${suggestions.join("; ")}。` +
            `\n该工具支持的参数: ${knownParams.join(", ")}`,
        };
        await this.recordAudit(args, result, startTime);
        return result;
      }

      // 无相似参数 → 仅警告，不中断
      if (result.data && typeof result.data === "object") {
        (result.data as Record<string, unknown>)._warnings = [
          `⚠️ 传入了未知参数: ${unknownParams.join(", ")}。` +
          `该工具支持的参数: ${knownParams.join(", ")}。` +
          `请检查是否拼写错误。`,
        ];
      }
      console.warn(
        `[${this.name}] 未知参数: ${suggestions.join(", ")} | ` +
        `已知参数: ${knownParams.join(", ")}`,
      );
    }

    // 审计
    const elapsed = (performance.now() - startTime) / 1000;
    await this.recordAudit(args, result, startTime, elapsed);

    return result;
  }

  /**
   * 检测调用者传入的未知参数
   *
   * NOTE: 通过对比 inputSchema.properties 的 key 列表，
   * 找出 args 中不在 schema 中的参数名。
   */
  private detectUnknownParams(args: Record<string, unknown>): string[] {
    const knownParams = this.getKnownParams();
    if (knownParams.length === 0) return []; // schema 不标准，跳过检测
    return Object.keys(args).filter(k => !knownParams.includes(k));
  }

  /** 从 inputSchema 中提取已知参数名列表 */
  private getKnownParams(): string[] {
    const schema = this.inputSchema as { properties?: Record<string, unknown> };
    if (!schema.properties) return [];
    return Object.keys(schema.properties);
  }

  /**
   * 在已知参数中查找与 unknown 最接近的参数名
   *
   * 匹配策略：
   * 1. 子串包含（potcar → potcar_variants）
   * 2. Levenshtein 编辑距离 ≤ 3
   */
  private findClosestParam(unknown: string, knownParams: string[]): string | null {
    const lower = unknown.toLowerCase();

    // 策略 1：子串包含（如 potcar 是 potcar_variants 的子串）
    const substringMatch = knownParams.find(
      k => k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()),
    );
    if (substringMatch) return substringMatch;

    // 策略 2：编辑距离
    let bestMatch: string | null = null;
    let bestDist = Infinity;
    for (const known of knownParams) {
      const dist = this.levenshtein(lower, known.toLowerCase());
      if (dist < bestDist) {
        bestDist = dist;
        bestMatch = known;
      }
    }
    // 阈值：编辑距离 ≤ 3 且不超过较短字符串长度的 50%
    const threshold = Math.min(3, Math.floor(Math.min(lower.length, bestMatch?.length ?? 0) * 0.5));
    return bestDist <= threshold ? bestMatch : null;
  }

  /** Levenshtein 编辑距离 */
  private levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }

  /** 转换为 OpenAI function calling 格式 */
  toOpenAITool(): OpenAIToolDefinition {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: this.inputSchema,
      },
    };
  }

  // ------- 审计日志 -------

  private async recordAudit(
    args: Record<string, unknown>,
    result: ToolResult,
    _startTime: number,
    elapsed = 0,
  ): Promise<void> {
    if (!this.auditDir) return;

    try {
      await mkdir(this.auditDir, { recursive: true });

      const entry = {
        timestamp: new Date().toISOString(),
        tool: this.name,
        input: sanitizeForJson(args),
        success: result.success,
        error: result.error ?? null,
        elapsed_seconds: Math.round(elapsed * 1000) / 1000,
        output_summary: summarizeOutput(result.data),
      };

      const logFile = join(this.auditDir, "tool_calls.jsonl");
      await writeFile(logFile, JSON.stringify(entry) + "\n", { flag: "a" });
    } catch {
      // 审计失败不影响工具执行
    }
  }
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

const MAX_STR_LEN = 2000;

/**
 * 将对象转换为 JSON 安全格式
 * 对过长字符串截断并附加 hash
 */
function sanitizeForJson(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    if (obj.length > MAX_STR_LEN) {
      const hash = createHash("sha256").update(obj).digest("hex").slice(0, 12);
      return `${obj.slice(0, MAX_STR_LEN)}... [truncated, len=${obj.length}, sha256=${hash}]`;
    }
    return obj;
  }
  if (typeof obj === "number" || typeof obj === "boolean") return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeForJson);
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = sanitizeForJson(v);
    }
    return result;
  }
  return String(obj);
}

/** 生成输出数据的简短摘要 */
function summarizeOutput(data: unknown): string | null {
  if (data === null || data === undefined) return null;
  if (typeof data === "string") {
    return data.length <= 500 ? data : `${data.slice(0, 500)}... [len=${data.length}]`;
  }
  if (Array.isArray(data)) return `list with ${data.length} items`;
  if (typeof data === "object") {
    return `dict with keys: ${Object.keys(data as Record<string, unknown>).join(", ")}`;
  }
  return String(data).slice(0, 500);
}
