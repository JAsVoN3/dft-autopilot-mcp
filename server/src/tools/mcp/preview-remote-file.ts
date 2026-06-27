/**
 * preview-remote-file.ts — 实时预览超算上的远程文件
 *
 * NOTE: 支持在计算运行中查看输出文件内容（相当于 tail -f）
 * 通过 SCNet EFile preview API 实现，不需要等作业完成
 *
 * 功能模式：
 * 1. tail 模式（默认）：显示文件最后 N 行
 * 2. 全文模式（tail=false）：读取完整文件
 * 3. 搜索模式（grep 参数）：在远程文件中搜索关键词，返回匹配行及上下文
 * 4. 目录列表（不传 filename）：列出远程目录所有文件
 */
import { DFTTool, type ToolResult } from "../base.js";
import { getComputeProvider } from "../../compute/index.js";

/** 默认 tail 行数 */
const DEFAULT_TAIL_LINES = 100;
/** tail 模式下读取的字节数上限（从文件末尾倒推） */
const TAIL_BYTES = 8192;
/** grep 模式下每个匹配结果的默认上下文行数 */
const GREP_CONTEXT_LINES = 2;
/** grep 模式下最大匹配数 */
const MAX_GREP_MATCHES = 30;
/** 全文读取的最大分页轮次（防止超大文件无限循环） */
const MAX_FULL_READ_PAGES = 20;
/** 返回内容的字符上限（防止超大输出击穿 token 限制，Bug #5） */
const MAX_OUTPUT_CHARS = 12000;

export class PreviewRemoteFileTool extends DFTTool {
  name = "preview_remote_file";
  description =
    "实时预览超算上的远程文件内容或列出目录。\n\n" +
    "**读取文件末尾**（默认模式）：\n" +
    "  preview_remote_file(task_id='xxx', filename='OSZICAR')  → 最后 100 行\n" +
    "  preview_remote_file(task_id='xxx', filename='OUTCAR', tail_lines=200)  → 最后 200 行\n\n" +
    "**搜索文件内容**（grep 模式）：\n" +
    "  preview_remote_file(task_id='xxx', filename='OUTCAR', grep='EDIFF')  → 搜索包含 EDIFF 的行\n" +
    "  preview_remote_file(task_id='xxx', filename='OUTCAR', grep='F=', grep_last=5)  → 只看最后 5 条匹配\n\n" +
    "**读取完整文件**：\n" +
    "  preview_remote_file(task_id='xxx', filename='scf.out', tail=false)\n\n" +
    "**列出目录**（不传 filename）：\n" +
    "  preview_remote_file(task_id='xxx')  → 列出远程目录所有文件和大小\n\n" +
    "⚠️ 注意：OUTCAR 等大文件（>10MB）建议用 grep 或 tail 模式，不要全文读取。";

  inputSchema = {
    type: "object" as const,
    properties: {
      task_id: {
        type: "string",
        description: "作业 task_id。用于自动定位远程工作目录。与 remote_dir 二选一。",
      },
      remote_dir: {
        type: "string",
        description:
          "远程目录绝对路径（如 '/work/home/xxx/jobs/abc123'）。" +
          "当 MCP 重启后 task 记录丢失时，可直接指定。与 task_id 二选一。",
      },
      filename: {
        type: "string",
        description:
          "要预览的文件名（如 'scf.out'、'OSZICAR'）。不传则列出远程目录所有文件。" +
          "支持子目录路径如 '01/OUTCAR'（NEB 场景）。",
      },
      tail: {
        type: "boolean",
        description:
          "是否只显示文件末尾。默认 true，设为 false 查看全文。grep 模式下此参数无效。",
      },
      tail_lines: {
        type: "number",
        description:
          `末尾显示行数。默认 ${DEFAULT_TAIL_LINES}。可调大以看更多历史（如 500）。`,
      },
      grep: {
        type: "string",
        description:
          "搜索关键词（大小写不敏感）。返回包含该关键词的所有行及上下文。" +
          "适合在大文件中精确定位信息（如在 OUTCAR 中搜 'EDIFF'、'magnetization'）。" +
          "默认字面匹配；需要正则/多模式时设 regex=true（如 grep='130 F=|140 F=', regex=true）。",
      },
      regex: {
        type: "boolean",
        description:
          "grep 是否按正则表达式解析（默认 false = 字面匹配）。" +
          "true 时支持 alternation `|`、字符类等（大小写不敏感）。无效正则会报错。",
      },
      grep_last: {
        type: "number",
        description:
          "grep 模式下只返回最后 N 条匹配（适用于只关心最新状态的场景）。" +
          "例如 grep='F=', grep_last=10 → 只看 OSZICAR 最后 10 步能量。",
      },
      grep_after: {
        type: "number",
        description:
          "grep 模式：每条匹配后额外显示 N 行（等价 grep -A）。" +
          "例如取 OUTCAR 最后一个 'TOTAL-FORCE' 块：grep='TOTAL-FORCE', grep_after=40, grep_last=1。",
      },
      grep_before: {
        type: "number",
        description: "grep 模式：每条匹配前额外显示 N 行（等价 grep -B）。",
      },
      grep_context: {
        type: "number",
        description:
          "grep 模式：每条匹配前后各显示 N 行（等价 grep -C，默认 2）。" +
          "被 grep_after / grep_before 覆盖（如指定后者则各自生效）。",
      },
    },
    required: [],
  };

  validateInput(args: Record<string, unknown>): string | null {
    if (!args.task_id && !args.remote_dir) return "必须提供 task_id 或 remote_dir";
    return null;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const taskId = args.task_id as string | undefined;
    const filename = args.filename as string | undefined;
    const tail = (args.tail as boolean) ?? true;
    const tailLines = (args.tail_lines as number) ?? DEFAULT_TAIL_LINES;
    const grep = args.grep as string | undefined;
    const grepLast = args.grep_last as number | undefined;
    const grepRegex = (args.regex as boolean) ?? false;
    const grepAfter = args.grep_after as number | undefined;
    const grepBefore = args.grep_before as number | undefined;
    const grepContext = args.grep_context as number | undefined;

    // NOTE: 优先从 task_id 获取远程目录，回退到直接传入的 remote_dir
    let remoteDir = args.remote_dir as string | undefined;
    if (taskId) {
      const task = getComputeProvider().getTask(taskId);
      if (task) {
        remoteDir = task.remoteDir;
      }
    }
    if (!remoteDir) {
      return {
        success: false,
        error: `找不到远程目录。task_id=${taskId} 的记录可能在 MCP 重启后丢失，请直接提供 remote_dir。`,
      };
    }

    try {
      // 没有指定文件名 → 列出远程目录
      if (!filename) {
        return this.listDirectory(remoteDir);
      }

      const remotePath = `${remoteDir}/${filename}`;

      // grep 模式 → 搜索文件
      if (grep) {
        return this.grepFile(remotePath, filename, grep, {
          grepLast,
          regex: grepRegex,
          after: grepAfter,
          before: grepBefore,
          context: grepContext,
        });
      }

      // tail 模式（默认）
      if (tail) {
        return this.tailFile(remotePath, filename, tailLines);
      }

      // 全文模式
      return this.readFullFile(remotePath, filename);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: `预览失败: ${msg}` };
    }
  }

  // ------- 列出目录 -------
  private async listDirectory(remoteDir: string): Promise<ToolResult> {
    const files = await getComputeProvider().listRemoteDir(remoteDir);
    return {
      success: true,
      data: {
        remote_dir: remoteDir,
        files: files.map(f => ({
          name: f.name,
          size_kb: Math.round((f.size / 1024) * 10) / 10,
          modified: f.lastModifiedTime,
        })),
        file_count: files.length,
      },
      display:
        `📂 ${remoteDir} | ${files.length} 个文件\n` +
        files
          .map(f => `  ${f.name} (${Math.round((f.size / 1024) * 10) / 10} KB)`)
          .join("\n"),
    };
  }

  // ------- tail 模式 -------
  private async tailFile(
    remotePath: string,
    filename: string,
    tailLines: number,
  ): Promise<ToolResult> {
    // 先探测文件大小
    const probe = await getComputeProvider().previewFile(remotePath, 0);
    const totalSize = probe.endIndex;

    // NOTE: 根据请求行数动态计算回读字节数
    // 假设每行平均 80 字节，额外多读 20% 以确保覆盖
    const estimatedBytes = Math.max(TAIL_BYTES, tailLines * 100);
    const tailStart = Math.max(0, totalSize - estimatedBytes);

    let content: string;
    if (tailStart === 0) {
      // 文件不大，直接用首次 probe 的内容
      content = probe.content;
      // 如果 hasNext，继续读取剩余部分
      if (probe.hasNext) {
        content = await this.readAllContent(remotePath);
      }
    } else {
      const result = await getComputeProvider().previewFile(remotePath, tailStart);
      content = result.content;
      // 如果还有下一页（文件特别大），继续追加
      if (result.hasNext) {
        let next = result;
        let pages = 0;
        while (next.hasNext && pages < MAX_FULL_READ_PAGES) {
          next = await getComputeProvider().previewFile(remotePath, next.endIndex);
          content += next.content;
          pages++;
        }
      }
    }

    const lines = content.split(/\r?\n/);
    const lastLines = lines.slice(-tailLines);

    // 字符上限保护：保留尾部（最新内容，Bug #5）
    let body = lastLines.join("\n");
    let capped = false;
    if (body.length > MAX_OUTPUT_CHARS) {
      body = "…（已截断头部）\n" + body.slice(-MAX_OUTPUT_CHARS);
      capped = true;
    }

    return {
      success: true,
      data: {
        path: remotePath,
        total_size: totalSize,
        content: body,
        lines_shown: lastLines.length,
        total_lines_approx: lines.length,
        ...(capped ? { note: `输出超 ${MAX_OUTPUT_CHARS} 字符已截断，请减小 tail_lines 或用 grep` } : {}),
      },
      display:
        `📄 ${filename} (${this.formatSize(totalSize)}) | 最后 ${lastLines.length} 行` +
        (capped ? "（已截断）" : "") + ":\n" +
        "```\n" +
        body +
        "\n```",
    };
  }

  // ------- grep 搜索模式 -------
  /**
   * 分页读取远程文件全文后在本地执行关键词搜索
   *
   * NOTE: SCNet preview API 没有服务端搜索能力，
   * 只能全量读取后在工具层做 grep。对于特别大的文件（>50MB）可能较慢。
   */
  private async grepFile(
    remotePath: string,
    filename: string,
    pattern: string,
    opts: {
      grepLast?: number;
      regex?: boolean;
      after?: number;
      before?: number;
      context?: number;
    } = {},
  ): Promise<ToolResult> {
    const { grepLast, regex, after, before, context } = opts;

    // 匹配器：默认字面（大小写不敏感），regex=true 时按正则解析（Bug #4）
    let matcher: (line: string) => boolean;
    if (regex) {
      let re: RegExp;
      try {
        re = new RegExp(pattern, "i");
      } catch (e) {
        return {
          success: false,
          error: `无效的正则表达式 "${pattern}": ${e instanceof Error ? e.message : e}`,
        };
      }
      matcher = (line) => re.test(line);
    } else {
      const lowerPattern = pattern.toLowerCase();
      matcher = (line) => line.toLowerCase().includes(lowerPattern);
    }

    // 上下文行数（Bug #21）：grep_after/before 优先，否则用 grep_context，再否则默认 2
    const afterN = after ?? context ?? GREP_CONTEXT_LINES;
    const beforeN = before ?? context ?? GREP_CONTEXT_LINES;

    const fullContent = await this.readAllContent(remotePath);
    const lines = fullContent.split(/\r?\n/);

    // 找到所有匹配行的索引
    const matchIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (matcher(lines[i])) matchIndices.push(i);
    }

    // 如果指定了 grep_last，只取最后 N 条
    const selectedIndices = grepLast
      ? matchIndices.slice(-grepLast)
      : matchIndices.slice(-MAX_GREP_MATCHES);

    // 构建带上下文的输出（含字符上限保护，Bug #5）
    const contextBlocks: string[] = [];
    const usedLines = new Set<number>();
    let outputChars = 0;
    let capped = false;

    for (const idx of selectedIndices) {
      const start = Math.max(0, idx - beforeN);
      const end = Math.min(lines.length - 1, idx + afterN);
      const block: string[] = [];
      for (let i = start; i <= end; i++) {
        if (!usedLines.has(i)) {
          const prefix = i === idx ? ">>>" : "   ";
          block.push(`${prefix} L${i + 1}: ${lines[i]}`);
          usedLines.add(i);
        }
      }
      if (block.length > 0) {
        const blockText = block.join("\n");
        if (outputChars + blockText.length > MAX_OUTPUT_CHARS) {
          capped = true;
          break;
        }
        contextBlocks.push(blockText);
        outputChars += blockText.length + 4; // + 分隔符
      }
    }

    const output = contextBlocks.join("\n---\n");
    const totalMatches = matchIndices.length;
    const shownMatches = contextBlocks.length;
    const notes: string[] = [];
    if (totalMatches > selectedIndices.length) {
      notes.push(`共 ${totalMatches} 条匹配，只取最后 ${selectedIndices.length} 条`);
    }
    if (capped) {
      notes.push(`输出超过 ${MAX_OUTPUT_CHARS} 字符上限，已截断（请缩小 grep_after/before 或用 grep_last）`);
    }

    return {
      success: true,
      data: {
        path: remotePath,
        pattern,
        regex: !!regex,
        total_matches: totalMatches,
        shown_matches: shownMatches,
        total_lines: lines.length,
        content: output,
        ...(grepLast ? { grep_last: grepLast } : {}),
        ...(notes.length > 0 ? { note: notes.join("；") } : {}),
      },
      display:
        `🔍 ${filename} | grep ${regex ? "/正则/" : `"${pattern}"`} → ${totalMatches} 条匹配` +
        (notes.length > 0 ? `（${notes.join("；")}）` : "") +
        `\n\`\`\`\n${output}\n\`\`\``,
    };
  }

  // ------- 全文读取 -------
  private async readFullFile(
    remotePath: string,
    filename: string,
  ): Promise<ToolResult> {
    const content = await this.readAllContent(remotePath);
    const lines = content.split(/\r?\n/);

    // 字符上限保护：全文模式保留头部，并提示改用 tail/grep（Bug #5）
    let body = content;
    let capped = false;
    if (body.length > MAX_OUTPUT_CHARS) {
      body = body.slice(0, MAX_OUTPUT_CHARS) + "\n…（全文超长已截断头部，请用 tail 或 grep 精确定位）";
      capped = true;
    }

    return {
      success: true,
      data: {
        path: remotePath,
        content: body,
        total_lines: lines.length,
        total_size: content.length,
        ...(capped ? { note: `全文 ${this.formatSize(content.length)} 超 ${MAX_OUTPUT_CHARS} 字符已截断，请用 tail 或 grep` } : {}),
      },
      display:
        `📄 ${filename} (${this.formatSize(content.length)}, ${lines.length} 行)` +
        (capped ? "（已截断）" : "") + ":\n" +
        "```\n" +
        body +
        "\n```",
    };
  }

  // ------- 工具方法 -------

  /**
   * 分页读取远程文件全部内容
   *
   * NOTE: SCNet preview API 单次读取有大小限制，
   * 需要通过 startIndex + hasNext 分页拼接
   */
  private async readAllContent(remotePath: string): Promise<string> {
    let content = "";
    let startIndex = 0;
    let pages = 0;

    while (pages < MAX_FULL_READ_PAGES) {
      const result = await getComputeProvider().previewFile(remotePath, startIndex);
      content += result.content;
      if (!result.hasNext) break;
      startIndex = result.endIndex;
      pages++;
    }
    return content;
  }

  /** 格式化文件大小 */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
