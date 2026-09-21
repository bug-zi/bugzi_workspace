// MCP 搜索渠道（辩真核查同款 findSearchTool；动态 import 防环依赖，services.ts 先例）。
// 返回工具原始文本；无可用搜索工具抛错，渠道失败由上层留痕不炸任务。
export async function searchViaMcp(
  query: string,
  onLog?: (m: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const { findSearchTool } = await import('../../../ai/mcp')
  const found = await findSearchTool(onLog, signal)
  if (!found) {
    throw new Error('未找到可用的搜索工具，请检查 MCP 服务器是否提供 search 类工具')
  }
  const { mcp, tool } = found
  onLog?.(`使用搜索工具：${tool}`)
  return mcp.callTool(tool, { query })
}
