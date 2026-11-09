// The slice of pi's extension API that pi-extensions/pdf-tinyfish.ts uses,
// so the factory checkout can type-check it. pi's packages are not installed
// here: the extension imports them type-only, and pi's jiti loader resolves
// the real ones at load time. Mirrors @earendil-works/pi-coding-agent 0.80
// (dist/core/extensions/types.d.ts: defineTool, ToolDefinition, registerTool);
// tool params stay `any` because their real types come from TypeBox schemas.
// This file lives outside pi-extensions/ on purpose: pi loads every
// extensions/*.ts as an extension.

declare module "@earendil-works/pi-ai" {
  /** TypeBox's schema builder (pi-ai re-exports `Type` from "typebox") */
  export const Type: any;
}

declare module "@earendil-works/pi-coding-agent" {
  export interface ToolResult {
    content: { type: "text"; text: string }[];
    details?: unknown;
    isError?: boolean;
  }
  export interface ToolDefinition {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(toolCallId: string, params: any, signal: AbortSignal | undefined, ctx: unknown): Promise<ToolResult>;
  }
  export function defineTool(tool: ToolDefinition): ToolDefinition;
  export interface ExtensionAPI {
    registerTool(tool: ToolDefinition): void;
  }
}
