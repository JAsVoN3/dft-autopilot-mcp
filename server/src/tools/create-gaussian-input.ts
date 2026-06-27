/**
 * create_gaussian_input — 生成 Gaussian 16 输入文件（.gjf）
 *
 * 单文件格式：%指令 + 路由行 + 标题 + 电荷/多重度 + 坐标
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { DFTTool, type ToolResult } from "./base.js";

export class CreateGaussianInputTool extends DFTTool {
  readonly name = "create_gaussian_input";

  readonly description =
    "生成 Gaussian 16 输入文件（.gjf）。\n" +
    "支持 calc_type: sp / opt / freq / opt_freq / ts / irc / scan / td。\n" +
    "每个关键选择必须在 _reasons 中提供依据。";

  readonly inputSchema = {
    type: "object",
    properties: {
      calc_type: {
        type: "string",
        enum: ["sp", "opt", "freq", "opt_freq", "ts", "irc", "scan", "td"],
        description: "计算类型",
      },
      method: { type: "string", description: "计算方法（如 B3LYP, M06-2X, wB97XD）" },
      basis_set: { type: "string", description: "基组（如 6-311+G(d,p), def2-TZVP）" },
      keywords: {
        type: "array",
        items: { type: "string" },
        description: "额外关键字（如 EmpiricalDispersion=GD3BJ）",
      },
      structure_data: {
        type: "object",
        properties: {
          atoms: {
            type: "array",
            items: {
              type: "object",
              properties: {
                element: { type: "string" },
                position: { type: "array", items: { type: "number" } },
              },
              required: ["element", "position"],
            },
          },
          charge: { type: "number", description: "体系总电荷" },
          multiplicity: { type: "number", description: "自旋多重度" },
        },
        required: ["atoms", "charge", "multiplicity"],
      },
      nproc: { type: "number", description: "CPU 核数（默认 8）" },
      mem: { type: "string", description: "内存（默认 8GB）" },
      title: { type: "string", description: "计算标题" },
      output_dir: { type: "string", description: "输出目录" },
      file_name: { type: "string", description: "文件名（默认 calc_type.gjf）" },
      additional_input: { type: "string", description: "额外输入段（如 ModRedundant 坐标扫描）" },
      _reasons: { type: "object", description: "参数选择理由" },
    },
    required: ["calc_type", "method", "basis_set", "structure_data", "output_dir", "_reasons"],
  };

  validateInput(args: Record<string, unknown>): string | null {
    if (!args.method) return "缺少 method（计算方法）";
    if (!args.basis_set) return "缺少 basis_set（基组）";
    if (!args.structure_data) return "缺少 structure_data";
    if (!args._reasons) return "缺少 _reasons 参数审计";
    const sd = args.structure_data as Record<string, unknown>;
    if (!sd.atoms || !Array.isArray(sd.atoms) || sd.atoms.length === 0) return "atoms 不能为空";
    if (sd.charge === undefined) return "缺少 charge（电荷）";
    if (sd.multiplicity === undefined) return "缺少 multiplicity（多重度）";
    return null;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const calcType = args.calc_type as string;
    const method = args.method as string;
    const basisSet = args.basis_set as string;
    const keywords = (args.keywords as string[]) ?? [];
    const sd = args.structure_data as {
      atoms: { element: string; position: number[] }[];
      charge: number;
      multiplicity: number;
    };
    const nproc = (args.nproc as number) ?? 8;
    const mem = (args.mem as string) ?? "8GB";
    const title = (args.title as string) ?? `${calcType} calculation`;
    const rawOutputDir = args.output_dir as string;
    const fileName = (args.file_name as string) ?? `${calcType}.gjf`;
    const additionalInput = args.additional_input as string | undefined;
    const reasons = args._reasons as Record<string, string>;

    // --- 路径锚定：相对路径锚定到 workspace，绝对路径直接使用 ---
    // NOTE: 与 create_qe_input / create_vasp_input 统一。此前直接用相对 output_dir，
    // 文件落到进程 cwd（项目根）而非 workspace/，导致后续 submit_compute_job 报"工作目录不存在"。
    let outputDir: string;
    if (rawOutputDir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rawOutputDir)) {
      outputDir = rawOutputDir;
    } else if (this.workspaceDir) {
      outputDir = join(this.workspaceDir, rawOutputDir);
    } else {
      console.warn(`[CreateGaussianInput] workspaceDir 未设置，output_dir 将相对于 cwd 解析: ${rawOutputDir}`);
      outputDir = rawOutputDir;
    }

    mkdirSync(outputDir, { recursive: true });

    // 构建路由行（关键字去重：用户 keywords 与 calc_type 自动关键字同名时覆盖并告警）
    const { keywords: routeKeywords, warnings: routeWarnings } = this.buildRouteKeywords(calcType, method, basisSet, keywords);
    const routeLine = `#p ${routeKeywords}`;

    // 构建 gjf 内容
    const lines: string[] = [];

    // %指令段
    lines.push(`%nproc=${nproc}`);
    lines.push(`%mem=${mem}`);
    // NOTE: chk 文件用于后续分析（formchk 等）
    const chkName = fileName.replace(".gjf", ".chk");
    lines.push(`%chk=${chkName}`);

    // 路由行
    lines.push(routeLine);

    // 空行 + 标题
    lines.push("");
    lines.push(title);

    // 空行 + 电荷/多重度
    lines.push("");
    lines.push(`${sd.charge} ${sd.multiplicity}`);

    // 原子坐标（笛卡尔坐标，Å）
    for (const atom of sd.atoms) {
      const [x, y, z] = atom.position;
      lines.push(`${atom.element.padEnd(4)} ${x.toFixed(8).padStart(14)} ${y.toFixed(8).padStart(14)} ${z.toFixed(8).padStart(14)}`);
    }

    // 空行（必须的终止符）
    lines.push("");

    // 额外输入段（如 ModRedundant）
    if (additionalInput) {
      lines.push(additionalInput);
      lines.push("");
    }

    // 最终空行
    lines.push("");

    const content = lines.join("\n");
    const filePath = join(outputDir, fileName);
    writeFileSync(filePath, content);

    // 导出 xyz 结构文件到 structures/ 目录
    const parentDir = dirname(outputDir);
    const structDir = join(parentDir, "structures");
    if (!existsSync(structDir)) mkdirSync(structDir, { recursive: true });
    const xyzContent = this.buildXyz(sd.atoms, title);
    const systemName = title.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 30);
    writeFileSync(join(structDir, `${systemName}_initial.xyz`), xyzContent);

    const display =
      `📝 Gaussian 输入文件已生成\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `• 计算类型: ${calcType}\n` +
      `• 方法: ${method}/${basisSet}\n` +
      `• 原子数: ${sd.atoms.length}\n` +
      `• 电荷/多重度: ${sd.charge}/${sd.multiplicity}\n` +
      `• 资源: ${nproc} 核, ${mem}\n` +
      `• 文件: ${filePath}` +
      (routeWarnings.length > 0 ? `\n\n${routeWarnings.join("\n")}` : "");

    return {
      success: true,
      data: {
        file_path: filePath,
        file_name: fileName,
        output_dir: outputDir,
        n_atoms: sd.atoms.length,
        route_line: routeLine,
        ...(routeWarnings.length > 0 ? { route_warnings: routeWarnings } : {}),
        audit: { timestamp: new Date().toISOString(), calc_type: calcType, method, basis_set: basisSet, reasons },
      },
      display,
    };
  }

  /**
   * 根据计算类型构建路由行关键字（去重）
   *
   * NOTE: calc_type 会自动生成关键字（如 opt_freq → "opt freq"）。若用户在 keywords 中
   * 再传同名关键字（如 opt=tight / freq=noraman），旧实现直接拼接会让 route 出现重复
   * opt/freq，Gaussian L1 报 "Illegal IType or MSType" 直接终止。
   * 这里按关键字"名"（'=' 或 '(' 之前的部分）去重：用户提供的版本覆盖工具自动生成的裸关键字，
   * 并在发生覆盖（值不同）时返回告警，提示自动设置（如 ts/calcfc）可能被替换。
   */
  private buildRouteKeywords(
    calcType: string,
    method: string,
    basisSet: string,
    extra: string[],
  ): { keywords: string; warnings: string[] } {
    const warnings: string[] = [];
    // 按关键字名去重，保持插入顺序；method/basis 固定首位，不参与去重
    const merged = new Map<string, string>();
    for (const kw of this.autoKeywordsFor(calcType)) {
      merged.set(this.keywordRoot(kw), kw);
    }
    for (const kw of extra) {
      const root = this.keywordRoot(kw);
      const prev = merged.get(root);
      if (prev !== undefined && prev !== kw) {
        warnings.push(
          `⚠️ 关键字 "${kw}" 与 calc_type=${calcType} 自动生成的 "${prev}" 同名，已用你提供的版本覆盖。` +
          `若需保留自动设置（如 ts/calcfc/modredundant），请在该关键字中自行写全。`,
        );
      }
      merged.set(root, kw);
    }
    const keywords = [`${method}/${basisSet}`, ...merged.values()].join(" ");
    return { keywords, warnings };
  }

  /** calc_type → 自动注入的路由关键字 */
  private autoKeywordsFor(calcType: string): string[] {
    switch (calcType) {
      case "sp": return ["sp"];
      case "opt": return ["opt"];
      case "freq": return ["freq"];
      case "opt_freq": return ["opt", "freq"];
      case "ts": return ["opt=(ts,calcfc,noeigentest)"];
      case "irc": return ["irc=(calcfc,maxpoints=50)"];
      case "scan": return ["opt=modredundant"];
      case "td": return ["td=(nstates=10)"];
      default: return [];
    }
  }

  /** 提取 Gaussian 关键字的"名"（'=' 或 '(' 之前的部分，小写），用于同名去重 */
  private keywordRoot(kw: string): string {
    return kw.split(/[=(]/)[0].trim().toLowerCase();
  }

  /** 生成 XYZ 格式结构文件 */
  private buildXyz(atoms: { element: string; position: number[] }[], title: string): string {
    const lines = [`${atoms.length}`, title];
    for (const atom of atoms) {
      const [x, y, z] = atom.position;
      lines.push(`${atom.element}  ${x.toFixed(8)}  ${y.toFixed(8)}  ${z.toFixed(8)}`);
    }
    return lines.join("\n") + "\n";
  }
}
