import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

let runtime: PluginRuntime | null = null;

export function setOpenWebUIRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getOpenWebUIRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("[open-webui] Runtime not initialized");
  }
  return runtime;
}
