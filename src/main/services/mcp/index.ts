/**
 * The MCP service.
 *
 * ```ts
 * const mcp = createMcpSocketServer({ paths, tools: registry, logger, approvals });
 * await mcp.start();
 *
 * // per step, before spawning the CLI:
 * const step = mcp.registerStep({ stepId, runId, allowedTools });
 * const config = await mcp.writeConfigForStep(stepId);
 * //   claude --mcp-config config.path --strict-mcp-config
 * //          --allowedTools <config.toolIds(allowedTools).join(' ')>
 * // after the step:
 * await config.cleanup();
 * step.revoke();
 *
 * // on quit:
 * await mcp.stop();
 * ```
 */
export { createMcpSocketServer } from './server';
export type {
  McpSocketServer,
  McpSocketServerOptions,
  McpSocketServerStatus,
  McpToolSource,
} from './server';

export {
  allowAllApprovalGate,
  isDeniedResult,
  isPendingResult,
} from './approvals';
export type {
  ApprovalCheckResult,
  ApprovalGate,
  ApprovalGateContext,
} from './approvals';

export { createStepScopeRegistry } from './steps';
export type {
  RegisteredStep,
  StepRegistrationInput,
  StepScope,
  StepScopeRegistry,
} from './steps';

export {
  buildMcpConfigDocument,
  DEFAULT_MCP_SERVER_NAME,
  mcpServerWildcard,
  mcpToolName,
  mcpToolNames,
  normalizeServerName,
  withMcpConfigFile,
  writeMcpConfigFile,
} from './config';
export type {
  McpConfigDocument,
  McpConfigHandle,
  McpConfigInput,
  McpServerEntry,
  WriteMcpConfigOptions,
} from './config';

export {
  assertNoForbiddenTools,
  compactToolResult,
  describeTool,
  forbiddenToolReason,
} from './tools';
export type { McpToolDescriptor, ToolCallResult } from './tools';

export { UnixSocketTransport } from './transport';
export type { UnixSocketTransportOptions } from './transport';

export {
  HANDSHAKE_VERSION,
  parseAck,
  parseHandshakeFrame,
  serializeAck,
  serializeHandshake,
  SHIM_ENV,
  SOCKET_FILENAME,
  TOKEN_FILENAME,
} from './protocol';
export type { HandshakeAck, HandshakeFrame } from './protocol';
