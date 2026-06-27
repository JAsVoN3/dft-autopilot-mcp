/**
 * run_pymatgen — pymatgen/ASE 代码沙盒工具
 *
 * Agent 只需编写核心建模逻辑（几行 pymatgen 代码），
 * 工具自动处理：环境激活、import 预装、输入注入、输出序列化、审计日志。
 *
 * 设计原则：
 * - 与 create_qe_input 同构：Agent 提供"内容"，工具负责"包装"
 * - 预装 pymatgen/ASE 全套 API，Agent 不需要写 import
 * - 自动检测 result 类型（Structure/Atoms/dict），统一输出 structure_data
 * - 30 秒执行超时，防止死循环
 */

import { DFTTool, type ToolResult } from "./base.js";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { appConfig } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 沙盒执行超时：30 秒 */
const SANDBOX_TIMEOUT_MS = 30_000;

export class RunPymatgenTool extends DFTTool {
  readonly name = "run_pymatgen";

  readonly description =
    "执行自定义 pymatgen/ASE 建模代码。适用于 build_structure 无法覆盖的复杂场景。\n\n" +
    "使用方式：\n" +
    "1. 在 code 中编写核心建模逻辑（无需 import，环境已预装）\n" +
    "2. 将最终结构赋值给 `result` 变量\n" +
    "3. 如需输入结构，通过 structure_data 传入（自动注入为 `structure` 变量）\n\n" +
    "预装模块：pymatgen.core, SlabGenerator, ASE (Atoms, build), numpy\n" +
    "预装工具函数：dict_to_structure, structure_to_dict, pmg_to_ase, ase_to_dict, ase_to_pmg\n\n" +
    "示例：\n" +
    "```python\n" +
    "# 构建 TiO2 rutile 110 面 slab\n" +
    "from pymatgen.ext.matproj import MPRester  # 需要额外 import 可直接写\n" +
    "slab = SlabGenerator(structure, [1,1,0], 10, 15).get_slabs()[0]\n" +
    "slab.make_supercell([2,2,1])\n" +
    "result = slab\n" +
    "```\n\n" +
    "**返回值说明**：\n" +
    "- `structure_data`: 可直接传入 create_qe_input 的结构数据\n" +
    "- `stdout`: 代码执行期间的 print() 输出（截断前 2000 字符），可用于调试和验证中间结果";

  readonly inputSchema = {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "Python 建模代码。无需 import 常用模块（已预装）。" +
          "必须将最终结构赋值给 `result` 变量。" +
          "支持的 result 类型：pymatgen Structure、ASE Atoms、dict。",
      },
      structure_data: {
        type: "object",
        description:
          "可选。输入结构数据，自动注入为 `structure` 变量（pymatgen Structure 对象）。",
      },
      extra_imports: {
        type: "array",
        items: { type: "string" },
        description:
          "可选。额外的 import 语句列表。例: ['from pymatgen.analysis.interfaces import CoherentInterfaceBuilder']",
      },
      description: {
        type: "string",
        description: "建模操作的科学目的说明",
      },
    },
    required: ["code"],
  };

  validateInput(args: Record<string, unknown>): string | null {
    const code = args.code as string;
    if (!code || code.trim().length === 0) return "code 不能为空";

    // NOTE: 基本安全检查，防止 Agent 执行危险操作
    const dangerous = ["os.system", "subprocess", "shutil.rmtree", "__import__('os')"];
    for (const d of dangerous) {
      if (code.includes(d)) {
        return `代码包含不安全操作: ${d}`;
      }
    }

    return null;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const code = args.code as string;
    const desc = (args.description as string) ?? "";

    try {
      const scriptPath = join(
        __dirname, "..", "..", "scripts", "run_pymatgen_sandbox.py",
      );

      const result = await this.callSandbox(scriptPath, {
        code,
        structure_data: args.structure_data ?? null,
        extra_imports: args.extra_imports ?? [],
      });

      if (!result.success) {
        return {
          success: false,
          error: result.error ?? "沙盒执行失败",
          // NOTE: 将 traceback 也返回给 Agent，方便它自我修正
          data: result.traceback ? { traceback: result.traceback } : undefined,
        };
      }

      const sd = result.data as Record<string, unknown>;

      // 提取并移除内部增强字段（不污染 structure_data）
      const analysis = sd._analysis as string | undefined;
      const imageBase64 = sd._image_base64 as string | undefined;
      // NOTE: Bug #7 — result 非结构对象时 Python 端返回 warning + result_value（标量/字符串）
      const warning = sd.warning as string | undefined;
      const resultValue = sd.result_value;
      delete sd._analysis;
      delete sd._image_base64;
      delete sd._stdout; // 已由 callSandbox 提取到 result.stdout，避免污染 structure_data

      return {
        success: true,
        data: {
          structure_data: sd,
          n_atoms: sd.n_atoms,
          elements: sd.elements,
          formula: sd.formula,
          // 方案 B：结构体检报告（文本），Agent 可直接阅读判断结构是否正确
          ...(analysis ? { analysis } : {}),
          // 方案 A：3D 可视化图（base64 PNG），供多模态 LLM "看" 结构
          ...(imageBase64 ? { _image_base64: imageBase64 } : {}),
          // NOTE: 非结构 result 的提示与值（Bug #7），顶层暴露便于 Agent 直接读取
          ...(warning ? { warning } : {}),
          ...(resultValue !== undefined ? { result_value: resultValue } : {}),
          // NOTE: stdout 为 Agent 代码 print() 输出（已与协议流隔离），截断前 2000 字符
          ...(result.stdout ? { stdout: result.stdout } : {}),
        },
        display: warning
          ? `🐍 pymatgen 沙盒: ${warning}${resultValue !== undefined ? ` → ${String(resultValue).slice(0, 200)}` : ""}`
          : `🐍 pymatgen 沙盒: ${sd.formula ?? "结构"} (${sd.n_atoms} atoms) | ${desc}`,
        audit: {
          code,
          description: desc,
          has_input_structure: !!args.structure_data,
        },
      };
    } catch (e) {
      return {
        success: false,
        error: `沙盒异常: ${e instanceof Error ? e.message : e}`,
      };
    }
  }

  /** 调用 Python 沙盒脚本 */
  private callSandbox(
    scriptPath: string,
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; data?: unknown; error?: string; traceback?: string; stdout?: string }> {
    return new Promise((resolve) => {
      // NOTE: 跨平台 Python 调用（与 plot-chart.ts 同步）
      const isWindows = process.platform === "win32";
      let proc;
      if (isWindows) {
        proc = spawn("python", [scriptPath], {
          stdio: ["pipe", "pipe", "pipe"],
          // NOTE: 强制 UTF-8，避免 Windows 默认 gbk 编码下 emoji/中文破坏 stdout（Bug #22）
          env: { ...process.env, PYTHONIOENCODING: "utf-8" },
          // NOTE: cwd 设为 workspaceDir，使脚本中的相对路径指向 workspace
          cwd: this.workspaceDir ?? process.cwd(),
        });
      } else {
        const venvPython = "/opt/dft-venv/bin/python3";
        const pythonCmd = `${venvPython} "${scriptPath}" 2>/dev/null || python3 "${scriptPath}"`;
        proc = spawn("bash", ["-c", pythonCmd], {
          stdio: ["pipe", "pipe", "pipe"],
          // NOTE: 强制 UTF-8，避免 Windows 默认 gbk 编码下 emoji/中文破坏 stdout（Bug #22）
          env: { ...process.env, PYTHONIOENCODING: "utf-8" },
          // NOTE: cwd 设为 workspaceDir，使脚本中的相对路径指向 workspace
          cwd: this.workspaceDir ?? process.cwd(),
        });
      }

      let stdout = "";
      let stderr = "";
      let killed = false;

      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      // NOTE: 30 秒超时保护
      const timer = setTimeout(() => {
        killed = true;
        proc.kill("SIGKILL");
      }, SANDBOX_TIMEOUT_MS);

      // NOTE: Python 子进程可能在 stdin 写入前退出（如 conda 环境不存在），
      // 导致 EPIPE 未捕获异常并崩溃进程。必须先注册 error handler。
      proc.stdin.on("error", () => {
        // EPIPE 等错误在 close 事件中统一处理
      });
      proc.stdin.write(JSON.stringify(args));
      proc.stdin.end();

      proc.on("close", (code) => {
        clearTimeout(timer);

        if (killed) {
          resolve({
            success: false,
            error: `执行超时 (${SANDBOX_TIMEOUT_MS / 1000}s)。请简化代码或检查是否有死循环。`,
          });
          return;
        }

        // NOTE: Agent 的代码可能包含 print() 调试输出，
        // 导致 stdout 是 "文字...\n{JSON}" 的混合格式。
        // 必须从混合输出中提取最后一个 JSON 块。
        const jsonStr = this.extractJson(stdout);

        if (code !== 0) {
          if (jsonStr) {
            try {
              const errObj = JSON.parse(jsonStr);
              resolve({
                success: false,
                error: errObj.error ?? `退出码 ${code}`,
                traceback: errObj.traceback,
                // NOTE: 用户 print 现由 Python 端隔离到 _stdout 字段（Bug #6），优先取它
                stdout: typeof errObj._stdout === "string" ? errObj._stdout : stdout.slice(0, 2000),
              });
              return;
            } catch { /* fallthrough */ }
          }
          resolve({
            success: false,
            error: `Python 退出码 ${code}: ${stderr.slice(0, 500)}`,
          });
          return;
        }

        if (!jsonStr) {
          resolve({
            success: false,
            error: `输出中未找到 JSON 块。stdout: ${stdout.slice(0, 500)}`,
          });
          return;
        }

        try {
          const result = JSON.parse(jsonStr);
          if (result.error) {
            resolve({ success: false, error: result.error, traceback: result.traceback });
          } else {
            // NOTE: 用户 print 现由 Python 端隔离到 _stdout 字段（Bug #6/#22）
            resolve({
              success: true,
              data: result,
              stdout: typeof result._stdout === "string" ? result._stdout : stdout.slice(0, 2000),
            });
          }
        } catch {
          resolve({
            success: false,
            error: `JSON 解析失败: ${jsonStr.slice(0, 300)}`,
          });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          error: `进程启动失败: ${err.message}`,
        });
      });
    });
  }

  /**
   * 从混合 stdout 中提取最后一个完整的 JSON 对象。
   *
   * Agent 的代码经常包含 print() 调试输出，导致 stdout 是：
   *   "Vacancy atom 1: ...\n{\"cell_parameters\": ...}"
   * 直接 JSON.parse 会失败。此方法从后往前找到最外层 { } 配对。
   */
  private extractJson(raw: string): string | null {
    // 先尝试直接解析（最快路径）
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      try { JSON.parse(trimmed); return trimmed; } catch { /* fallthrough */ }
    }

    // 从后往前找最后一个 } 的位置，然后反向匹配 {
    const lastBrace = trimmed.lastIndexOf("}");
    if (lastBrace === -1) return null;

    let depth = 0;
    for (let i = lastBrace; i >= 0; i--) {
      if (trimmed[i] === "}") depth++;
      if (trimmed[i] === "{") depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(i, lastBrace + 1);
        try { JSON.parse(candidate); return candidate; } catch { /* continue */ }
      }
    }
    return null;
  }
}
