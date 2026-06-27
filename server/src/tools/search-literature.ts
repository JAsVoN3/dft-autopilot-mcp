/**
 * search_literature — 学术文献搜索工具
 *
 * 接入外部学术 API 搜索 DFT 相关论文，帮助 Agent 查找：
 * - 特定体系的计算参数（如 "Co-N4 SAC DFT+U value"）
 * - 对比基准数据（如 "ORR adsorption energy benchmark"）
 * - 方法学参考（如 "NEB transition state DFT"）
 *
 * 数据源优先级：Semantic Scholar → OpenAlex → CrossRef（三级降级）
 */

import { DFTTool, type ToolResult } from "./base.js";
import { appConfig } from "../config.js";

// NOTE: Semantic Scholar API 超时与限流常量
const API_TIMEOUT_MS = 15000;
const MAX_RESULTS_LIMIT = 10;

interface PaperResult {
  title: string;
  authors: string;
  year: number | null;
  abstract: string | null;
  citationCount: number | null;
  doi: string | null;
  url: string | null;
  source: string;
}

export class SearchLiteratureTool extends DFTTool {
  readonly name = "search_literature";
  readonly description =
    "搜索学术论文/科学文献，查找特定体系的 DFT 计算参数、方法学推荐或对比数据。" +
    "数据源: Semantic Scholar + OpenAlex + CrossRef（2 亿+ 论文，三级降级）。" +
    "适用场景：查找 Hubbard U 值文献来源、对比实验/计算结果、" +
    "确认计算方法学选择等。返回论文标题、摘要、引用数和 DOI。";

  readonly inputSchema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "搜索查询，如 'Co-N4 SAC DFT+U value'、" +
          "'ORR adsorption energy benchmark PBE'、" +
          "'transition metal oxide band gap hybrid functional'",
      },
      max_results: {
        type: "integer",
        description: "最大返回结果数（默认 5，最大 10）",
      },
      year_min: {
        type: "integer",
        description: "最早发表年份过滤（如 2018），仅搜索该年之后的论文",
      },
    },
    required: ["query"],
  };

  get isReadOnly() {
    return true;
  }

  validateInput(args: Record<string, unknown>): string | null {
    const query = args.query as string | undefined;
    if (!query?.trim()) return "query 不能为空";
    return null;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = args.query as string;
    const maxResults = Math.min(
      (args.max_results as number) ?? 5,
      MAX_RESULTS_LIMIT,
    );
    const yearMin = args.year_min as number | undefined;

    // NOTE: 三级降级链：Semantic Scholar → OpenAlex → CrossRef
    const sources: Array<{
      name: string;
      fn: () => Promise<PaperResult[]>;
    }> = [
      { name: "Semantic Scholar", fn: () => this.searchSemanticScholar(query, maxResults, yearMin) },
      { name: "OpenAlex", fn: () => this.searchOpenAlex(query, maxResults, yearMin) },
      { name: "CrossRef", fn: () => this.searchCrossRef(query, maxResults) },
    ];

    let papers: PaperResult[] = [];
    let dataSource = "";
    const errors: string[] = [];

    for (const src of sources) {
      try {
        papers = await src.fn();
        dataSource = src.name;
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${src.name}: ${msg.slice(0, 60)}`);
        console.warn(`[search_literature] ${src.name} 失败: ${msg}`);
      }
    }

    // 全部失败
    if (!dataSource) {
      return {
        success: true,
        data: {
          query,
          results: [],
          note:
            `三个数据源均不可用。${errors.join("; ")}。` +
            `请使用 search_knowledge（本地 RAG）或 lookup_hubbard_u 替代。`,
        },
      };
    }

    return {
      success: true,
      data: {
        query,
        data_source: dataSource,
        n_results: papers.length,
        results: papers,
        ...(errors.length > 0
          ? {
              fallback_note: `前置数据源不可用 (${errors.join("; ")})，已降级到 ${dataSource}`,
              // NOTE: Bug #4 修复 — 降级后明确标注相关性可能下降
              relevance_warning: `${dataSource} 的搜索相关性可能低于 Semantic Scholar，结果仅供参考。建议结合 search_knowledge 本地 RAG 交叉验证。`,
            }
          : {}),
      },
      display:
        papers.length > 0
          ? `📄 文献搜索: ${papers.length} 篇论文 [${dataSource}] (query: ${query.slice(0, 40)}...)`
          : `📄 文献搜索: 无结果`,
    };
  }

  // ---------------------------------------------------------------------------
  // Semantic Scholar API
  // https://api.semanticscholar.org/api-docs/graph
  // ---------------------------------------------------------------------------

  private async searchSemanticScholar(
    query: string,
    limit: number,
    yearMin?: number,
  ): Promise<PaperResult[]> {
    const params = new URLSearchParams({
      query,
      limit: String(limit),
      fields: "title,authors,year,abstract,citationCount,externalIds,url",
    });

    // 年份过滤
    if (yearMin) {
      params.set("year", `${yearMin}-`);
    }

    const url = `https://api.semanticscholar.org/graph/v1/paper/search?${params}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // NOTE: 有 API Key 时使用，可提升限流配额
    if (appConfig.semanticScholarApiKey) {
      headers["x-api-key"] = appConfig.semanticScholarApiKey;
    }

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`S2 API ${response.status}: ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as {
      data?: Array<{
        title: string;
        authors?: Array<{ name: string }>;
        year?: number;
        abstract?: string;
        citationCount?: number;
        externalIds?: { DOI?: string };
        url?: string;
      }>;
    };

    if (!data.data) return [];

    return data.data.map((paper) => ({
      title: paper.title,
      authors: (paper.authors ?? [])
        .slice(0, 3)
        .map((a) => a.name)
        .join(", "),
      year: paper.year ?? null,
      abstract: paper.abstract ?? null,
      citationCount: paper.citationCount ?? null,
      doi: paper.externalIds?.DOI ?? null,
      url: paper.url ?? null,
      source: "Semantic Scholar",
    }));
  }

  // ---------------------------------------------------------------------------
  // OpenAlex API（降级备选）
  // https://docs.openalex.org/api-entities/works
  // ---------------------------------------------------------------------------

  private async searchOpenAlex(
    query: string,
    limit: number,
    yearMin?: number,
  ): Promise<PaperResult[]> {
    const params = new URLSearchParams({
      search: query,
      per_page: String(limit),
      // NOTE: polite pool — 提供 mailto 可获得更高限流
      mailto: process.env.LITERATURE_MAILTO || "dft-autopilot@example.com",
    });

    // 年份过滤
    if (yearMin) {
      params.set("filter", `from_publication_date:${yearMin}-01-01`);
    }

    const url = `https://api.openalex.org/works?${params}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`OpenAlex API ${response.status}: ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as {
      results?: Array<{
        title?: string;
        authorships?: Array<{ author: { display_name: string } }>;
        publication_year?: number;
        abstract_inverted_index?: Record<string, number[]>;
        cited_by_count?: number;
        doi?: string;
        id?: string;
      }>;
    };

    if (!data.results) return [];

    return data.results.map((work) => ({
      title: work.title ?? "(untitled)",
      authors: (work.authorships ?? [])
        .slice(0, 3)
        .map((a) => a.author.display_name)
        .join(", "),
      year: work.publication_year ?? null,
      // NOTE: OpenAlex 返回的是 inverted index 格式的摘要，需要还原
      abstract: work.abstract_inverted_index
        ? this.reconstructAbstract(work.abstract_inverted_index)
        : null,
      citationCount: work.cited_by_count ?? null,
      doi: work.doi ? work.doi.replace("https://doi.org/", "") : null,
      url: work.id ?? null,
      source: "OpenAlex",
    }));
  }

  /**
   * 将 OpenAlex 的 inverted index 摘要还原为正常文本
   *
   * OpenAlex 存储摘要为 {"word": [position1, position2]} 格式，
   * 需要按位置重新排列成连贯文本。
   */
  private reconstructAbstract(
    invertedIndex: Record<string, number[]>,
  ): string {
    const words: Array<[number, string]> = [];
    for (const [word, positions] of Object.entries(invertedIndex)) {
      for (const pos of positions) {
        words.push([pos, word]);
      }
    }
    words.sort((a, b) => a[0] - b[0]);
    return words.map(([, w]) => w).join(" ");
  }

  // ---------------------------------------------------------------------------
  // CrossRef API（第 3 降级源）
  // https://api.crossref.org
  // NOTE: 无需 API Key，但不返回摘要，适合获取 DOI 和基本元数据
  // ---------------------------------------------------------------------------

  private async searchCrossRef(
    query: string,
    limit: number,
  ): Promise<PaperResult[]> {
    const params = new URLSearchParams({
      "query.bibliographic": query,
      rows: String(limit),
      select: "DOI,title,author,published-print,is-referenced-by-count",
      mailto: process.env.LITERATURE_MAILTO || "dft-autopilot@example.com",
    });

    const url = `https://api.crossref.org/works?${params}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`CrossRef API ${response.status}`);
    }

    const data = (await response.json()) as {
      message?: {
        items?: Array<{
          DOI?: string;
          title?: string[];
          author?: Array<{ given?: string; family?: string }>;
          "published-print"?: { "date-parts"?: number[][] };
          "is-referenced-by-count"?: number;
        }>;
      };
    };

    if (!data.message?.items) return [];

    return data.message.items.map((item) => {
      const year = item["published-print"]?.["date-parts"]?.[0]?.[0] ?? null;
      return {
        title: item.title?.[0] ?? "(untitled)",
        authors: (item.author ?? [])
          .slice(0, 3)
          .map((a) => [a.given, a.family].filter(Boolean).join(" "))
          .join(", "),
        year,
        abstract: null, // CrossRef 通常不返回摘要
        citationCount: item["is-referenced-by-count"] ?? null,
        doi: item.DOI ?? null,
        url: item.DOI ? `https://doi.org/${item.DOI}` : null,
        source: "CrossRef",
      };
    });
  }
}
