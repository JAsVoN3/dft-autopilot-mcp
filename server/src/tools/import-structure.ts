/**
 * import_structure — 从文件导入晶体结构
 * 完整移植自 Python import_structure.py（144 行）
 *
 * 支持 CIF / POSCAR / XYZ / PDB 格式。
 * 通过 Python 桥接脚本调用 pymatgen/ASE 完成解析。
 */
import { DFTTool, type ToolResult } from "./base.js";
import { spawn } from "child_process";
import { join, extname, basename, dirname } from "path";
import { existsSync } from "fs";
import { stat } from "fs/promises";
import { fileURLToPath } from "url";
import { appConfig } from "../config.js";

// NOTE: ESM 环境下没有 __dirname，需通过 import.meta.url 推导
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FORMAT_MAP: Record<string, string> = {
  ".cif": "cif", ".vasp": "poscar", ".poscar": "poscar",
  ".xyz": "xyz", ".pdb": "pdb",
};

export class ImportStructureTool extends DFTTool {
  readonly name = "import_structure";
  readonly description =
    "从结构文件导入晶体结构数据。" +
    "支持格式: CIF, POSCAR, XYZ, PDB。" +
    "自动检测文件格式，转换为可用于 create_qe_input 的结构。";

  readonly inputSchema = {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "结构文件路径（.cif/.vasp/.poscar/.xyz/.pdb）",
      },
      file_format: {
        type: "string",
        enum: ["cif", "poscar", "xyz", "pdb"],
        description: "文件格式（可选，默认自动检测）",
      },
    },
    required: ["file_path"],
  };

  get isReadOnly() { return true; }

  validateInput(args: Record<string, unknown>): string | null {
    if (!args.file_path || typeof args.file_path !== "string") return "file_path 不能为空";
    return null;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    let filePath = args.file_path as string;
    let fileFormat = args.file_format as string | undefined;

    // NOTE: 相对路径解析 — 兼容 Windows 盘符（D:\）和 Linux 绝对路径（/）
    const isAbsolute = filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath);
    if (!isAbsolute && this.workspaceDir) {
      filePath = join(this.workspaceDir, filePath);
    }

    try { await stat(filePath); } catch {
      return { success: false, error: `文件不存在: ${filePath}` };
    }

    // 自动检测格式
    if (!fileFormat) {
      const ext = extname(filePath).toLowerCase();
      const name = basename(filePath).toUpperCase();
      if (name === "POSCAR" || name === "CONTCAR") {
        fileFormat = "poscar";
      } else {
        fileFormat = FORMAT_MAP[ext];
      }
      if (!fileFormat) {
        return { success: false, error: `无法检测格式: ${ext}，请指定 file_format` };
      }
    }

    try {
      const scriptPath = join(
        __dirname, "..", "..", "scripts", "import_structure.py",
      );
      const result = await this.callPythonBridge(scriptPath, {
        file_path: filePath,
        file_format: fileFormat,
      });

      if (!result.success) {
        return { success: false, error: result.error ?? "Python 桥接失败" };
      }

      const data = result.data as Record<string, unknown>;
      return {
        success: true,
        data,
        display: `📦 导入结构: ${data.formula} (${data.n_atoms} atoms)`,
      };
    } catch (e) {
      return { success: false, error: `导入失败: ${e instanceof Error ? e.message : e}` };
    }
  }

  private callPythonBridge(
    scriptPath: string,
    args: Record<string, unknown>,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    return new Promise((resolve) => {
      // NOTE: 跨平台 Python 调用（与 run-pymatgen.ts / plot-chart.ts 同步）
      const isWindows = process.platform === "win32";
      let proc;
      if (isWindows) {
        proc = spawn("python", [scriptPath], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } else {
        const venvPython = "/opt/dft-venv/bin/python3";
        const pythonCmd = `${venvPython} "${scriptPath}" 2>/dev/null || python3 "${scriptPath}"`;
        proc = spawn("bash", ["-c", pythonCmd], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      }
      let stdout = "", stderr = "";
      proc.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
      proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
      // NOTE: 防止 EPIPE 崩溃
      proc.stdin.on("error", () => {});
      proc.stdin.write(JSON.stringify(args));
      proc.stdin.end();
      proc.on("close", (code) => {
        if (code !== 0) { resolve({ success: false, error: `Python 退出码 ${code}: ${stderr.slice(0, 500)}` }); return; }
        try { resolve({ success: true, data: JSON.parse(stdout) }); }
        catch { resolve({ success: false, error: `输出解析失败: ${stdout.slice(0, 500)}` }); }
      });
      proc.on("error", (err) => { resolve({ success: false, error: `进程启动失败: ${err.message}` }); });
    });
  }
}
