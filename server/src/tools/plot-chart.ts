/**
 * plot_chart — DFT 计算图表生成工具
 *
 * 使用 matplotlib 后端生成学术级图表（能带、DOS、pDOS、收敛曲线）。
 * 内置 Nature / APS / ACS / Dark 四套 CNS 级配色预设。
 *
 * 设计原则：
 * - 与 run_pymatgen 同构的沙盒调用模式
 * - Agent 只需传数据文件路径或 extract_dft_results 的返回值
 * - 自动从同目录 scf.out 获取费米能级
 * - 返回 image_path + image_base64（前端可直接渲染）
 */

import { DFTTool, type ToolResult } from "./base.js";
import { spawn } from "child_process";
import { dirname, join, basename } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, mkdirSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 绘图超时：60 秒（大 pDOS 数据集需要更多时间） */
const PLOT_TIMEOUT_MS = 60_000;

export class PlotChartTool extends DFTTool {
  readonly name = "plot_chart";

  readonly description =
    "生成 DFT 计算的学术级图表（matplotlib 后端）。\n\n" +
    "支持图表类型：\n" +
    "- **bands**: 能带结构图（k 路径 vs E）\n" +
    "- **dos**: 态密度图（自动检测 spin-polarized 数据并生成 spin-up/down 镜像图）\n" +
    "- **pdos**: 投影态密度图（按元素/轨道分色，自动检测 nspin=2 并分 spin 通道镜像显示）\n" +
    "- **convergence**: SCF 能量收敛曲线\n" +
    "- **gibbs**: 自由能台阶图（ORR/HER/OER 催化反应路径，水平阶梯 + ΔG 标注）\n" +
    "- **bands_dos**: 能带+DOS 联合图（左右并排，共享 Y 轴，PRL/Nature 标准格式）\n\n" +
    "数据源（三选一，推荐优先用 data_file 避免大数据 JSON 截断）：\n" +
    "1. `data_file`: 直接传 QE 输出文件路径（.dat.gnu / .dos / .out）— **推荐**\n" +
    "2. `data`: 传 extract_dft_results 的返回数据对象\n" +
    "3. `work_dir`: pdos 模式下传目录，自动扫描 pdos_atm* 文件\n" +
    "4. `steps`: gibbs 模式下传反应路径数据 [{label, energy}]\n\n" +
    "配色预设：nature（默认）、aps、acs、dark\n" +
    "输出：300dpi PNG（默认），可选 SVG/PDF。图片保存到 workspace/figures/ 并返回 base64。";

  readonly inputSchema = {
    type: "object",
    properties: {
      chart_type: {
        type: "string",
        enum: ["bands", "dos", "pdos", "convergence", "gibbs", "bands_dos"],
        description: "图表类型",
      },
      data_file: {
        type: "string",
        description: "QE 输出数据文件路径（bands.dat.gnu / nio.dos 等）",
      },
      data: {
        type: "object",
        description: "extract_dft_results 返回的结构化数据",
      },
      work_dir: {
        type: "string",
        description: "pdos 模式下的工作目录（自动扫描 pdos_atm* 文件）",
      },
      fermi_energy: {
        type: "number",
        description: "费米能级 (eV)。未提供时自动从同目录 scf.out 获取",
      },
      energy_range: {
        type: "array",
        items: { type: "number" },
        description: "能量窗口 [min, max] (eV)，默认 [-6, 6]",
      },
      elements_filter: {
        type: "array",
        items: { type: "string" },
        description: "pdos 模式下的元素过滤器",
      },
      style: {
        type: "string",
        enum: ["nature", "aps", "acs", "dark"],
        description: "配色预设，默认 nature",
      },
      figsize: {
        type: "array",
        items: { type: "number" },
        description: "图片尺寸 [width, height] (inches)",
      },
      dpi: {
        type: "number",
        description: "分辨率，默认 300",
      },
      output_format: {
        type: "string",
        enum: ["png", "svg", "pdf"],
        description: "输出格式，默认 png",
      },
      output_path: {
        type: "string",
        description: "保存路径。未提供时自动保存到 workspace/figures/",
      },
      title: {
        type: "string",
        description: "图表标题",
      },
      k_labels: {
        type: "array",
        items: { type: "string" },
        description: "能带图的 K 路径标签（如 ['Γ', 'X', 'M', 'Γ']）",
      },
      k_positions: {
        type: "array",
        items: { type: "number" },
        description: "能带图的 K 路径标签位置（对应 k_labels）",
      },
      spin_resolved: {
        type: "boolean",
        description: "是否分 spin 通道显示。true=强制分 spin 镜像，false=强制合并，不传=自动检测",
      },
      orbital_filter: {
        type: "array",
        items: { type: "string" },
        description: "pdos 模式下按轨道类型过滤，如 ['d', 'p'] 只画 d 和 p 轨道。不传则显示全部。",
      },
      auto_filter: {
        type: "boolean",
        description: "pdos 模式下是否自动过滤掉峰值 < 0.05 states/eV 的轨道。默认 false。",
      },
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            energy: { type: "number" },
          },
        },
        description: "gibbs 模式：反应路径各步数据 [{label: 'O₂ + *', energy: 0.0}, ...]",
      },
      reference_potential: {
        type: "number",
        description: "gibbs 模式：可选平衡电位（V），将画一条水平虚线标注",
      },
      bands_data_file: {
        type: "string",
        description: "bands_dos 模式：能带 .dat.gnu 文件路径",
      },
      dos_data_file: {
        type: "string",
        description: "bands_dos 模式：DOS 数据文件路径（.dos 格式）",
      },
    },
    required: ["chart_type"],
  };

  get isReadOnly() { return true; }

  validateInput(args: Record<string, unknown>): string | null {
    const chartType = args.chart_type as string;
    if (!chartType) return "chart_type 不能为空";
    if (!["bands", "dos", "pdos", "convergence", "gibbs", "bands_dos"].includes(chartType)) {
      return `不支持的图表类型: ${chartType}`;
    }
    // gibbs 类型使用 steps 参数，不需要 data_file/data/work_dir
    if (chartType === "gibbs") {
      if (!args.steps || !(args.steps as unknown[]).length) {
        return "gibbs 类型需要提供 steps 数组（反应路径数据）";
      }
      return null;
    }
    // bands_dos 类型使用 bands_data_file / dos_data_file
    if (chartType === "bands_dos") {
      if (!args.bands_data_file && !args.dos_data_file) {
        return "bands_dos 类型需要提供 bands_data_file 或 dos_data_file";
      }
      return null;
    }
    // 至少需要一个数据源
    if (!args.data_file && !args.data && !args.work_dir) {
      return "至少需要提供 data_file、data 或 work_dir 之一作为数据源";
    }
    return null;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const chartType = args.chart_type as string;

    try {
      // NOTE: 自动获取费米能级（如果未提供）
      if (args.fermi_energy === undefined && args.data_file) {
        const fermi = this.findFermiEnergy(args.data_file as string);
        if (fermi !== null) {
          args.fermi_energy = fermi;
        }
      }

      // NOTE: 自动生成输出路径
      if (!args.output_path && this.workspaceDir) {
        const figDir = join(this.workspaceDir, "figures");
        mkdirSync(figDir, { recursive: true });
        const fmt = (args.output_format as string) || "png";
        const timestamp = Date.now();
        args.output_path = join(figDir, `${chartType}_${timestamp}.${fmt}`);
      }

      const scriptPath = join(__dirname, "..", "..", "scripts", "plot_chart.py");
      const result = await this.callPlotEngine(scriptPath, args);

      if (!result.success) {
        return {
          success: false,
          error: result.error ?? "绘图失败",
          data: result.traceback ? { traceback: result.traceback } : undefined,
        };
      }

      const plotData = result.data as Record<string, unknown>;
      return {
        success: true,
        data: {
          image_path: plotData.image_path,
          // NOTE: _image_base64 会被 agent.ts 从 tool result 文本中剥离，
          // 转为多模态 vision 消息注入（~1000 token/张，远优于文本 base64 的 ~50k token）
          _image_base64: plotData.image_base64,
          chart_type: plotData.chart_type,
          style: plotData.style,
          output_format: plotData.output_format,
        },
        display: `📊 ${chartType} 图表已生成: ${plotData.image_path ? basename(plotData.image_path as string) : "unknown"} | 风格: ${plotData.style}`,
      };
    } catch (e) {
      return {
        success: false,
        error: `绘图异常: ${e instanceof Error ? e.message : e}`,
      };
    }
  }

  /**
   * 自动从同目录 scf.out 获取费米能级
   */
  private findFermiEnergy(dataFile: string): number | null {
    const dir = dirname(dataFile);
    for (const name of ["scf.out", "nscf.out"]) {
      const scfPath = join(dir, name);
      if (existsSync(scfPath)) {
        try {
          const content = readFileSync(scfPath, "utf-8");
          const m = content.match(/the Fermi energy is\s+([-\d.]+)\s+ev/i);
          if (m) return parseFloat(m[1]);
        } catch { /* 搜索失败不影响主流程 */ }
      }
    }
    return null;
  }

  /**
   * 调用 Python 绘图引擎
   */
  private callPlotEngine(
    scriptPath: string,
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; data?: unknown; error?: string; traceback?: string }> {
    return new Promise((resolve) => {
      // NOTE: 跨平台 Python 调用
      // Windows 侧直接用 python，Linux 侧优先 venv
      const isWindows = process.platform === "win32";
      let proc;
      if (isWindows) {
        proc = spawn("python", [scriptPath], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });
      } else {
        const venvPython = "/opt/dft-venv/bin/python3";
        const pythonCmd = `${venvPython} "${scriptPath}" 2>/dev/null || python3 "${scriptPath}"`;
        proc = spawn("bash", ["-c", pythonCmd], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });
      }

      let stdout = "";
      let stderr = "";
      let killed = false;

      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        killed = true;
        proc.kill("SIGKILL");
      }, PLOT_TIMEOUT_MS);

      proc.stdin.on("error", () => { /* EPIPE 在 close 中处理 */ });
      proc.stdin.write(JSON.stringify(args));
      proc.stdin.end();

      proc.on("close", (code) => {
        clearTimeout(timer);

        if (killed) {
          resolve({
            success: false,
            error: `绘图超时 (${PLOT_TIMEOUT_MS / 1000}s)。数据量可能过大。`,
          });
          return;
        }

        if (code !== 0) {
          try {
            const errObj = JSON.parse(stdout.trim());
            resolve({
              success: false,
              error: errObj.error ?? `退出码 ${code}`,
              traceback: errObj.traceback,
            });
          } catch {
            resolve({
              success: false,
              error: `Python 退出码 ${code}: ${stderr.slice(0, 500)}`,
            });
          }
          return;
        }

        try {
          const result = JSON.parse(stdout.trim());
          if (result.error) {
            resolve({ success: false, error: result.error, traceback: result.traceback });
          } else {
            resolve({ success: true, data: result });
          }
        } catch {
          resolve({
            success: false,
            error: `JSON 解析失败: ${stdout.slice(0, 300)}`,
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
}
