/**
 * MCP 工具适配器 — 将 DFTTool 子类包装为 MCP Server 工具
 *
 * NOTE: 设计决策 — 使用底层 Server 类直接注册 tools/list 和 tools/call handler，
 * 绕过 McpServer 高级 API 的 Zod schema 要求。
 * 这样可以直接透传 DFTTool 的 JSON Schema 定义，无需转换。
 *
 * DFTTool.execute() 返回 ToolResult，适配器将其转换为 MCP 响应格式。
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DFTTool, type ToolResult } from "./tools/base.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** MCP 工具定义（用于 tools/list 响应） */
interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// MCP Server 工厂
// ---------------------------------------------------------------------------

/**
 * 创建一个注册了所有 DFT 工具的 MCP Server
 *
 * 使用底层 Server 类，直接注册 tools/list 和 tools/call handler，
 * 不经过 McpServer 高级 API（后者强制要求 Zod schema）。
 */
export function createDFTMcpServer(
  tools: DFTTool[],
  serverInfo: { name: string; version: string } = { name: "dft-autopilot", version: "2.0.0" },
): Server {
  const server = new Server(serverInfo, {
    capabilities: {
      tools: {},
      logging: {},
    },
  });

  // 构建工具名 → DFTTool 映射
  const toolMap = new Map<string, DFTTool>();
  const toolDefs: MCPToolDefinition[] = [];

  for (const tool of tools) {
    toolMap.set(tool.name, tool);
    toolDefs.push({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        // NOTE: MCP 协议要求 inputSchema 是一个 JSON Schema 对象
        type: "object",
        ...tool.inputSchema,
      },
    });
    console.error(`[MCP] ✅ 注册工具: ${tool.name}`);
  }

  console.error(`[MCP] 📦 共注册 ${tools.length} 个 DFT 工具`);

  // ---------------------------------------------------------------------------
  // tools/list handler
  // ---------------------------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: toolDefs,
    };
  });

  // ---------------------------------------------------------------------------
  // tools/call handler
  // ---------------------------------------------------------------------------

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const tool = toolMap.get(name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `工具不存在: ${name}` }],
        isError: true,
      };
    }

    try {
      // NOTE: 注入进度通知回调 — 通过 MCP logging 消息推送给客户端
      tool.notifyProgress = (message: string) => {
        server.sendLoggingMessage({
          level: "info",
          logger: name,
          data: message,
        });
      };

      const result = await tool.call(args ?? {});
      tool.notifyProgress = undefined; // 清除回调
      return toolResultToMCP(result, name);
    } catch (err: unknown) {
      tool.notifyProgress = undefined;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[MCP] ❌ 工具 ${name} 执行异常: ${msg}`);
      return {
        content: [{ type: "text" as const, text: `工具执行异常: ${msg}` }],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * 启动 MCP Server 的 stdio 传输
 */
export async function startStdioTransport(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("\n✅ MCP Server 已启动 (stdio 模式)\n");
}

// ---------------------------------------------------------------------------
// ToolResult → MCP 响应格式转换
// ---------------------------------------------------------------------------

/**
 * 将 DFTTool 的 ToolResult 转换为 MCP 工具响应
 *
 * MCP 响应格式：{ content: [{ type: "text", text: "..." }], isError?: boolean }
 * ToolResult 格式：{ success, data?, error?, display?, audit? }
 */
function toolResultToMCP(
  result: ToolResult,
  toolName: string,
): { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean } {
  if (!result.success) {
    return {
      content: [{ type: "text" as const, text: result.error ?? `工具 ${toolName} 执行失败` }],
      isError: true,
    };
  }

  const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];

  if (result.display) {
    content.push({ type: "text", text: result.display });
  }

  if (result.data !== undefined) {
    // NOTE: 从 data 中提取 _image_base64，转为 MCP image 内容块
    // 原 agent.ts 也有类似逻辑：剥离 base64 转多模态 vision 消息
    const data = result.data as Record<string, unknown>;
    const imageBase64 = data._image_base64 as string | undefined;

    if (imageBase64) {
      // 剥离 base64 后再序列化文本数据，避免 ~50k token 的 base64 文本
      const dataForText = { ...data };
      delete dataForText._image_base64;
      content.push({ type: "text", text: JSON.stringify(dataForText, null, 2) });
      content.push({ type: "image", data: imageBase64, mimeType: "image/png" });
    } else {
      const dataStr = JSON.stringify(data, null, 2);
      // NOTE: 对大体积数据截断，防止 MCP 消息过大
      if (dataStr.length > 100_000) {
        content.push({ type: "text", text: dataStr.slice(0, 100_000) + "\n\n... [数据截断，总长 " + dataStr.length + " 字符]" });
      } else {
        content.push({ type: "text", text: dataStr });
      }
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "✅ 操作成功" });
  }

  return { content };
}
