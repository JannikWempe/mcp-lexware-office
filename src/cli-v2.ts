#!/usr/bin/env node
// Deprecated alias entry point; stderr only — stdout is the MCP protocol channel.
console.error('lexware-office-v2 is deprecated; use lexware-office instead.');
await import('./index.js');
