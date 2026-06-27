/**
 * lookup_pseudopotential — 查询 SSSP 推荐赝势
 * 完整移植自 Python lookup_pseudopotential.py
 *
 * 桥接 sssp-db.ts，提供赝势文件名、截断能推荐值的查询服务。
 */
import { DFTTool, type ToolResult } from "./base.js";
import { getSpeciesInfo, getMaxCutoffs, getPseudo, getAvailableElements } from "./data/sssp-db.js";
import { appConfig } from "../config.js";

export class LookupPseudopotentialTool extends DFTTool {
  readonly name = "lookup_pseudopotential";
  readonly description =
    "查询指定元素的 SSSP 推荐赝势信息。" +
    "返回赝势文件名、推荐 ecutwfc 和 ecutrho 截断能。" +
    "可查询单个元素或多个元素（自动取最大截断能）。" +
    "在创建 QE 输入文件之前必须先查询。";

  readonly inputSchema = {
    type: "object",
    properties: {
      elements: {
        type: "array", items: { type: "string" },
        description: "元素符号列表，如 ['Co', 'N', 'C']",
      },
    },
    required: ["elements"],
  };

  get isReadOnly() { return true; }

  validateInput(args: Record<string, unknown>): string | null {
    const elements = args.elements as string[] | undefined;
    if (!elements || elements.length === 0) return "elements 不能为空";
    return null;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const elements = args.elements as string[];
    try {
      const speciesInfo = getSpeciesInfo(elements, appConfig.pseudoDir);
      const [maxWfc, maxRho] = getMaxCutoffs(elements, appConfig.pseudoDir);

      // 构建每个元素的详细信息
      const species: Record<string, unknown>[] = speciesInfo.map(sp => {
        const info = getPseudo(sp.element, appConfig.pseudoDir);
        return {
          element: sp.element,
          pseudo_file: sp.pseudo_file,
          mass: sp.mass,
          type: info?.type ?? "unknown",
          cutoff_wfc: info?.cutoff_wfc ?? 30,
          cutoff_rho: info?.cutoff_rho ?? 240,
        };
      });

      return {
        success: true,
        data: {
          species,
          max_ecutwfc: maxWfc,
          max_ecutrho: maxRho,
          recommendation: `建议: ecutwfc=${maxWfc} Ry, ecutrho=${maxRho} Ry`,
        },
        display: `🔬 赝势查询: ${elements.join(", ")} → ecutwfc=${maxWfc}, ecutrho=${maxRho} Ry`,
      };
    } catch (e) {
      return { success: false, error: `赝势查询失败: ${e instanceof Error ? e.message : e}` };
    }
  }
}
