/**
 * lookup_hubbard_u — 通用 DFT 参数查询工具
 * 完整移植自 Python lookup_hubbard_u.py
 *
 * 支持三种查询：
 * 1. hubbard_u — Hubbard U 值查询
 * 2. vdw_recommendation — vdW 色散校正推荐
 * 3. ecutwfc — SSSP 推荐截断能
 */
import { DFTTool, type ToolResult } from "./base.js";

// NOTE: 内置 U 值数据库
// 权威来源: Materials Project 官方文档
// https://docs.materialsproject.org/methodology/materials-methodology/calculation-details/gga+u-calculations/hubbard-u-values
// 方法: Wang et al., PRB 73, 195107 (2006) — 通过实验二元生成焓拟合校准
// FIXME: 仅包含 MP 官方校准的 8 个元素，其他元素的 U 值需用户从文献中自行确定
const U_DB: Record<string, { U: number; shell: string; source: string }> = {
  // MP 官方校准的 8 个元素（氧化物/氟化物体系）
  Co: { U: 3.32, shell: "3d", source: "Materials Project (Wang et al., PRB 2006)" },
  Cr: { U: 3.7,  shell: "3d", source: "Materials Project (Wang et al., PRB 2006)" },
  Fe: { U: 5.3,  shell: "3d", source: "Materials Project (Wang et al., PRB 2006)" },
  Mn: { U: 3.9,  shell: "3d", source: "Materials Project (Wang et al., PRB 2006)" },
  Mo: { U: 4.38, shell: "4d", source: "Materials Project (Wang et al., PRB 2006)" },
  Ni: { U: 6.2,  shell: "3d", source: "Materials Project (Wang et al., PRB 2006)" },
  V:  { U: 3.25, shell: "3d", source: "Materials Project (Wang et al., PRB 2006)" },
  W:  { U: 6.2,  shell: "5d", source: "Materials Project (Wang et al., PRB 2006)" },
};

// NOTE: SSSP Efficiency 截断能数据库
const ECUTWFC_DB: Record<string, { ecutwfc: number; ecutrho: number }> = {
  H:  { ecutwfc: 30, ecutrho: 240 }, C:  { ecutwfc: 40, ecutrho: 320 },
  N:  { ecutwfc: 40, ecutrho: 320 }, O:  { ecutwfc: 45, ecutrho: 360 },
  F:  { ecutwfc: 45, ecutrho: 360 }, S:  { ecutwfc: 35, ecutrho: 280 },
  Ti: { ecutwfc: 35, ecutrho: 280 }, Fe: { ecutwfc: 45, ecutrho: 360 },
  Co: { ecutwfc: 45, ecutrho: 360 }, Ni: { ecutwfc: 45, ecutrho: 360 },
  Cu: { ecutwfc: 40, ecutrho: 320 }, Zn: { ecutwfc: 40, ecutrho: 320 },
  Mo: { ecutwfc: 35, ecutrho: 280 }, Pt: { ecutwfc: 35, ecutrho: 280 },
};

// NOTE: vdW 色散校正推荐
const VDW_DB: Record<string, { method: string; qe_param: string; reason: string }> = {
  adsorption:  { method: "dft-d3", qe_param: "vdw_corr='dft-d3'",         reason: "分子吸附必须使用 vdW 校正" },
  surface:     { method: "dft-d3", qe_param: "vdw_corr='dft-d3'",         reason: "表面体系建议 vdW 校正" },
  layered:     { method: "vdw-df", qe_param: "input_dft='vdw-df2-b86r'",  reason: "层状材料层间 vdW 力" },
  molecular:   { method: "dft-d3", qe_param: "vdw_corr='dft-d3'",         reason: "分子间弱相互作用" },
  bulk_metal:  { method: "none",   qe_param: "# 不需要",                   reason: "体相金属通常不加 vdW" },
};

export class LookupHubbardUTool extends DFTTool {
  readonly name = "lookup_hubbard_u";
  readonly description =
    "查询 DFT 计算推荐参数。支持三种查询类型：\n" +
    "1. hubbard_u — 查询元素的推荐 Hubbard U 值\n" +
    "2. vdw_recommendation — 根据体系类型推荐 vdW 校正方法\n" +
    "3. ecutwfc — 查询元素的 SSSP 推荐截断能\n" +
    "参数选择时必须使用此工具查询。";

  readonly inputSchema = {
    type: "object",
    properties: {
      element: {
        type: "string",
        description: "元素符号（hubbard_u/ecutwfc 用），多元素逗号分隔",
      },
      query_type: {
        type: "string",
        enum: ["hubbard_u", "vdw_recommendation", "ecutwfc"],
        description: "查询类型，默认 hubbard_u",
      },
      system_type: {
        type: "string",
        enum: ["adsorption", "surface", "layered", "molecular", "bulk_metal"],
        description: "体系类型（vdw_recommendation 用）",
      },
    },
    required: ["element"],
  };

  get isReadOnly() { return true; }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const qt = (args.query_type as string) ?? "hubbard_u";
    const el = (args.element as string) ?? "";

    if (qt === "hubbard_u") return this.queryHubbard(el);
    if (qt === "vdw_recommendation") return this.queryVdW((args.system_type as string) ?? "adsorption");
    if (qt === "ecutwfc") return this.queryEcutwfc(el);
    return { success: false, error: `未知查询类型: ${qt}` };
  }

  private queryHubbard(element: string): ToolResult {
    const info = U_DB[element];
    if (info) {
      return {
        success: true,
        data: {
          query_type: "hubbard_u", element,
          hubbard_u: info.U, shell: info.shell, source: info.source,
          recommendation: `${element}: U=${info.U} eV (${info.shell})`,
        },
      };
    }
    return {
      success: true,
      data: {
        query_type: "hubbard_u", element, hubbard_u: null,
        recommendation:
          `${element} 无 Materials Project 官方校准 U 值。` +
          `请使用 search_knowledge 工具从文献中检索该元素的推荐 U 值，` +
          `或询问用户是否有指定值。MP 仅校准了 Co/Cr/Fe/Mn/Mo/Ni/V/W 八个元素。`,
      },
    };
  }

  private queryVdW(systemType: string): ToolResult {
    const rec = VDW_DB[systemType] ?? VDW_DB.adsorption;
    return {
      success: true,
      data: {
        query_type: "vdw_recommendation", system_type: systemType,
        recommended_method: rec.method, qe_parameter: rec.qe_param,
        reason: rec.reason,
      },
    };
  }

  private queryEcutwfc(element: string): ToolResult {
    const elements = element.split(",").map(e => e.trim()).filter(Boolean);
    if (elements.length === 0) return { success: false, error: "请提供元素符号" };
    let maxWfc = 0, maxRho = 0;
    const data: Record<string, { ecutwfc: number; ecutrho: number }> = {};
    for (const el of elements) {
      const info = ECUTWFC_DB[el] ?? { ecutwfc: 50, ecutrho: 400 };
      data[el] = info;
      maxWfc = Math.max(maxWfc, info.ecutwfc);
      maxRho = Math.max(maxRho, info.ecutrho);
    }
    return {
      success: true,
      data: {
        query_type: "ecutwfc", elements: data,
        recommended_ecutwfc: maxWfc, recommended_ecutrho: maxRho,
      },
    };
  }
}
