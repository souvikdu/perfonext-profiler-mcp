#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerLoadProfile } from './tools/load-profile.js';
import { registerGetHotspots } from './tools/get-hotspots.js';
import { registerExplainFunction } from './tools/explain-function.js';
import { registerCompareProfiles } from './tools/compare-profiles.js';
import { registerSuggestOptimizations } from './tools/suggest-optimizations.js';
import { registerGetProfileSummary } from './tools/get-profile-summary.js';
import { registerReadSourceContext } from './tools/read-source-context.js';
import { registerGetPackageCosts } from './tools/get-package-costs.js';

const server = new McpServer({
  name: 'perfonext-profiler-mcp',
  version: '0.4.0',
});

// Register all tools
registerLoadProfile(server);
registerGetHotspots(server);
registerExplainFunction(server);
registerCompareProfiles(server);
registerSuggestOptimizations(server);
registerGetProfileSummary(server);
registerReadSourceContext(server);
registerGetPackageCosts(server);

// Start server with stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
