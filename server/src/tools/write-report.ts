/**
 * write_report — 生成结构化 Markdown 报告
 *
 * 设计原则：
 * - Agent 直接写 Markdown 正文（content 字段），工具只负责写入文件 + 附加元数据
 * - methodology 和 comparison_table 作为可选的模板化生成，自动追加到正文前/后
 * - Agent 擅长写文本，不应被迫构造嵌套 JSON 对象
 *
 * 增强功能：
 * - methodology: 自动生成中英双语"计算方法"段落，可直接 copy 到论文 SI
 * - comparison_table: 多体系对比表，自动格式化
 * - export_format: 导出格式（md/pdf/docx/all）
 */
import { writeFile, mkdir } from "fs/promises";
import { dirname, basename, isAbsolute } from "path";
import { existsSync } from "fs";
import { DFTTool, type ToolResult } from "./base.js";

/** Methodology 模板参数 */
interface MethodologyParams {
  /** 语言：cn=中文, en=英文, bilingual=双语 */
  language?: "cn" | "en" | "bilingual";
  /** 泛函名称（PBE, PBE+U, HSE06 等） */
  functional?: string;
  /** 基组/赝势类型 */
  basis_type?: string;
  /** 计算软件 */
  software?: string;
  /** 赝势库 */
  pseudopotential_library?: string;
  /** K 点信息 */
  kpoints_info?: string;
  /** 截断能 */
  ecutwfc?: number;
  ecutrho?: number;
  /** 收敛标准 */
  convergence_criteria?: string;
  /** 特殊处理说明（Hubbard U、vdW、SOC 等） */
  custom_notes?: string;
}

export class WriteReportTool extends DFTTool {
  readonly name = "write_report";
  readonly description =
    "生成结构化 Markdown 报告文件。\n\n" +
    "**使用方式**：先在回复正文中用 Markdown 写完整的报告内容，然后调用此工具，" +
    "只需传 title 和 output_path 即可（content 参数可省略，工具会自动从你的回复正文中提取报告内容）。\n\n" +
    "**可选增强**：\n" +
    "- `methodology`: 传入参数自动生成学术级\"计算方法\"段落（中英双语），会追加到正文前\n" +
    "- `comparison_table`: 传入列名和数据行，自动生成格式化对比表，会追加到正文前\n" +
    "- `export_format`: 导出格式 md/pdf/docx/all\n\n" +
    "示例：\n" +
    "write_report(title='Si 能带结构计算报告', output_path='Si_bulk/report.md')";

  readonly inputSchema = {
    type: "object",
    properties: {
      title: { type: "string", description: "报告标题" },
      output_path: { type: "string", description: "输出文件路径（.md）" },
      content: {
        type: "string",
        description:
          "报告正文（Markdown 格式）。可省略——如果你已在回复正文中输出报告，工具会自动提取。" +
          "不需要包含标题行（工具会自动加 # title）。",
      },
      methodology: {
        type: "object",
        description:
          "可选。计算方法模板参数，自动生成学术级 Methodology 段落。\n" +
          "包含：functional, software, ecutwfc, ecutrho, kpoints_info, basis_type, " +
          "pseudopotential_library, convergence_criteria, custom_notes, language (cn/en/bilingual)",
      },
      comparison_table: {
        type: "object",
        properties: {
          caption: { type: "string", description: "表格标题" },
          columns: {
            type: "array", items: { type: "string" },
            description: "列名，如 ['体系', '带隙/eV', '磁矩/μB', '方法']",
          },
          rows: {
            type: "array",
            items: { type: "array", items: {} },
            description: "每行数据，如 [['Si', 1.12, 0, 'PBE'], ['GaAs', 1.42, 0, 'PBE']]",
          },
        },
        description: "可选。多体系对比表，自动生成格式化 Markdown 表格",
      },
      export_format: {
        type: "string",
        enum: ["md", "pdf", "docx", "all"],
        description: "导出格式。默认 md。docx 为 Word 格式。all = md + docx + pdf",
      },
    },
    required: ["title", "output_path"],
  };

  validateInput(args: Record<string, unknown>): string | null {
    if (!args.title) return "title 不能为空";
    if (!args.output_path) return "output_path 不能为空";
    // NOTE: content 可省略，Agent 层会从 assistantContent 回捐
    return null;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const title = args.title as string;
    let outputPath = args.output_path as string;
    const content = args.content as string;
    const methodology = args.methodology as MethodologyParams | undefined;
    const exportFormat = (args.export_format as string) ?? "md";
    const compTable = args.comparison_table as {
      caption?: string; columns?: string[]; rows?: unknown[][];
    } | undefined;

    // NOTE: 相对路径自动解析到 workspaceDir
    if (!isAbsolute(outputPath) && this.workspaceDir) {
      outputPath = `${this.workspaceDir}/${outputPath}`;
    }

    try {
      await mkdir(dirname(outputPath), { recursive: true });
      const lines: string[] = [];

      // 标题 + 元信息
      lines.push(`# ${title}`, "");
      const now = new Date();
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      lines.push(`> 生成时间: ${dateStr}`);
      lines.push("> 生成工具: DFT AutoPilot Agent", "");

      // Methodology 段落（如果提供模板参数）
      if (methodology) {
        const methSection = this.generateMethodology(methodology);
        lines.push(methSection, "");
      }

      // 多体系对比表（如果提供）
      if (compTable?.columns && compTable.rows) {
        lines.push(`## ${compTable.caption ?? "体系对比"}`, "");
        lines.push(`| ${compTable.columns.join(" | ")} |`);
        lines.push(`|${compTable.columns.map(() => "------").join("|")}|`);
        for (const row of compTable.rows) {
          lines.push(`| ${row.join(" | ")} |`);
        }
        lines.push("");
      }

      // Agent 撰写的正文（核心内容）
      lines.push(content);

      const reportContent = lines.join("\n");
      await writeFile(outputPath, reportContent, "utf-8");

      // 导出处理（支持 md / pdf / docx / all）
      let pdfPath: string | undefined;
      let docxPath: string | undefined;
      const shouldPdf = exportFormat === "pdf" || exportFormat === "all";
      const shouldDocx = exportFormat === "docx" || exportFormat === "all";

      if (shouldPdf) {
        pdfPath = await this.exportPdf(outputPath, reportContent);
      }
      if (shouldDocx) {
        docxPath = await this.exportDocx(outputPath);
      }

      // NOTE: 统计正文的章节数（## 开头的行数）
      const sectionCount = (content.match(/^## /gm) ?? []).length;

      return {
        success: true,
        data: {
          output_path: outputPath,
          n_sections: sectionCount + (methodology ? 1 : 0),
          size_bytes: Buffer.byteLength(reportContent, "utf-8"),
          has_methodology: !!methodology,
          has_comparison_table: !!compTable,
          // NOTE: 完整 markdown 内容随工具调用结果返回，前端直接渲染到 Canvas
          reportContent,
          ...(pdfPath ? { pdf_path: pdfPath } : {}),
          ...(docxPath ? { docx_path: docxPath } : {}),
        },
        display:
          `📝 报告已生成: ${basename(outputPath)} (${sectionCount} 节)` +
          (methodology ? " | 📄 含 Methodology" : "") +
          (compTable ? " | 📊 含对比表" : "") +
          (pdfPath ? ` | 📑 PDF: ${basename(pdfPath)}` : "") +
          (docxPath ? ` | 📃 DOCX: ${basename(docxPath)}` : ""),
      };
    } catch (e) {
      return { success: false, error: `报告生成失败: ${e instanceof Error ? e.message : e}` };
    }
  }

  /**
   * 生成 Methodology 段落（中英双语）
   *
   * NOTE: 生成的段落符合 Nature/Science/JACS 的 Methods 章节格式，
   * 客户可以直接 copy 到论文的 Supplementary Information 或 Methods 部分。
   */
  private generateMethodology(params: MethodologyParams): string {
    const lang = params.language ?? "bilingual";
    const functional = params.functional ?? "PBE";
    const software = params.software ?? "Quantum ESPRESSO 7.4.1";
    const basis = params.basis_type ?? "PAW/USPP";
    const ppLib = params.pseudopotential_library ?? "SSSP efficiency v1.3.0";
    const ecutwfc = params.ecutwfc ?? 60;
    const ecutrho = params.ecutrho ?? 600;
    const kInfo = params.kpoints_info ?? "Γ-centered Monkhorst-Pack mesh";
    const convCrit = params.convergence_criteria ?? "1.0×10⁻⁸ Ry";
    const custom = params.custom_notes ?? "";

    const lines: string[] = [];

    // 英文版
    if (lang === "en" || lang === "bilingual") {
      lines.push("## Computational Methodology", "");
      lines.push(
        `First-principles calculations were performed within the framework of density functional theory (DFT) ` +
        `using the ${functional} exchange-correlation functional, as implemented in ${software}. ` +
        `${basis} pseudopotentials from the ${ppLib} library were employed. ` +
        `The kinetic energy cutoff for plane waves was set to ${ecutwfc} Ry ` +
        `(${ecutrho} Ry for the charge density). ` +
        `The Brillouin zone was sampled using a ${kInfo}. ` +
        `The self-consistent field (SCF) convergence threshold was set to ${convCrit}.`,
      );
      if (custom) {
        lines.push("", custom);
      }
      lines.push("");
    }

    // 中文版
    if (lang === "cn" || lang === "bilingual") {
      if (lang === "bilingual") {
        lines.push("---", "");
      }
      lines.push("## 计算方法", "");
      lines.push(
        `本工作采用密度泛函理论（DFT）框架，使用 ${functional} 交换关联泛函，` +
        `基于 ${software} 程序包实现。采用 ${ppLib} 提供的 ${basis} 赝势。` +
        `平面波动能截断设为 ${ecutwfc} Ry（电荷密度截断 ${ecutrho} Ry）。` +
        `布里渊区采用 ${kInfo} 进行采样。` +
        `自洽场（SCF）收敛阈值设为 ${convCrit}。`,
      );
      if (custom) {
        lines.push("", custom);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * 将 Markdown 报告导出为 PDF
   *
   * NOTE: 优先尝试 pandoc（学术质量最高），回退到简单 HTML 方案
   */
  private async exportPdf(mdPath: string, _content: string): Promise<string | undefined> {
    const pdfPath = mdPath.replace(/\.md$/, ".pdf");
    const { spawn: spawnProc } = await import("child_process");

    // 方案 1：尝试 pandoc
    try {
      const success = await new Promise<boolean>((resolve) => {
        const proc = spawnProc("pandoc", [
          mdPath,
          "-o", pdfPath,
          "--pdf-engine=xelatex",
          "-V", "geometry:margin=1in",
          "-V", "mainfont:Noto Sans CJK SC",
          "-V", "monofont:Noto Sans Mono",
          "--highlight-style=tango",
        ], { stdio: "pipe" });

        proc.on("close", (code) => resolve(code === 0));
        proc.on("error", () => resolve(false));
      });

      if (success && existsSync(pdfPath)) {
        console.log(`[WriteReport] 📑 PDF 已生成 (pandoc): ${pdfPath}`);
        return pdfPath;
      }
    } catch { /* pandoc 不可用，尝试下一个方案 */ }

    // 方案 2：尝试 wkhtmltopdf（HTML → PDF）
    try {
      const htmlContent = this.markdownToSimpleHtml(_content);
      const htmlPath = mdPath.replace(/\.md$/, ".html");
      await writeFile(htmlPath, htmlContent, "utf-8");

      const success = await new Promise<boolean>((resolve) => {
        const proc = spawnProc("wkhtmltopdf", [
          "--encoding", "utf-8",
          "--page-size", "A4",
          "--margin-top", "20mm",
          "--margin-bottom", "20mm",
          "--margin-left", "25mm",
          "--margin-right", "25mm",
          htmlPath, pdfPath,
        ], { stdio: "pipe" });

        proc.on("close", (code) => resolve(code === 0));
        proc.on("error", () => resolve(false));
      });

      if (success && existsSync(pdfPath)) {
        console.log(`[WriteReport] 📑 PDF 已生成 (wkhtmltopdf): ${pdfPath}`);
        return pdfPath;
      }
    } catch { /* wkhtmltopdf 不可用 */ }

    console.warn("[WriteReport] ⚠️ PDF 导出跳过：pandoc 和 wkhtmltopdf 均不可用");
    return undefined;
  }

  /**
   * 将 Markdown 报告导出为 Word (docx) 格式
   *
   * NOTE: 使用 pandoc md → docx 转换，保留学术排版。
   * publication-ready 输出常需要 Word 格式（便于贴入论文 / SI 或进一步排版）。
   */
  private async exportDocx(mdPath: string): Promise<string | undefined> {
    const docxPath = mdPath.replace(/\.md$/, ".docx");
    const { spawn: spawnProc } = await import("child_process");

    try {
      const success = await new Promise<boolean>((resolve) => {
        const proc = spawnProc("pandoc", [
          mdPath,
          "-o", docxPath,
          "--from=markdown",
          "--to=docx",
        ], { stdio: "pipe" });

        proc.on("close", (code) => resolve(code === 0));
        proc.on("error", () => resolve(false));
      });

      if (success && existsSync(docxPath)) {
        console.log(`[WriteReport] 📃 DOCX 已生成 (pandoc): ${docxPath}`);
        return docxPath;
      }
    } catch { /* pandoc 不可用 */ }

    console.warn("[WriteReport] ⚠️ DOCX 导出跳过：pandoc 不可用");
    return undefined;
  }

  /**
   * 简易 Markdown → HTML 转换（用于 PDF 导出的降级方案）
   */
  private markdownToSimpleHtml(md: string): string {
    const html = md
      // 标题
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^# (.+)$/gm, "<h1>$1</h1>")
      // 加粗/斜体
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      // 代码
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      // 列表
      .replace(/^- (.+)$/gm, "<li>$1</li>")
      // 表格（简易处理）
      .replace(/^\|(.+)\|$/gm, (_, row) => {
        const cells = row.split("|").map((c: string) => `<td>${c.trim()}</td>`).join("");
        return `<tr>${cells}</tr>`;
      })
      // 引用
      .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>")
      // 换行
      .replace(/\n\n/g, "</p><p>")
      .replace(/\n/g, "<br>");

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
body {
  font-family: "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif;
  font-size: 11pt;
  line-height: 1.6;
  color: #333;
  max-width: 800px;
  margin: 0 auto;
  padding: 20px;
}
h1 { font-size: 18pt; border-bottom: 2px solid #333; padding-bottom: 6px; }
h2 { font-size: 14pt; border-bottom: 1px solid #999; padding-bottom: 4px; margin-top: 24px; }
h3 { font-size: 12pt; margin-top: 18px; }
table { border-collapse: collapse; width: 100%; margin: 12px 0; }
td, th { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
tr:nth-child(even) { background: #f9f9f9; }
code { background: #f4f4f4; padding: 2px 4px; border-radius: 3px; font-size: 10pt; }
blockquote { border-left: 3px solid #ccc; margin: 10px 0; padding: 5px 15px; color: #666; }
</style>
</head>
<body>
<p>${html}</p>
</body>
</html>`;
  }
}
