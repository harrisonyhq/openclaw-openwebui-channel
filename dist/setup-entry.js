import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { openWebUIPlugin } from "./src/channel.js";
export default defineSetupPluginEntry(openWebUIPlugin);
