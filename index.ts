import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { openWebUIPlugin } from "./src/channel.js";
import { setOpenWebUIRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "open-webui",
  name: "Open WebUI",
  description: "Open WebUI channels integration via REST API and Socket.IO.",
  plugin: openWebUIPlugin,
  setRuntime: setOpenWebUIRuntime,
});
