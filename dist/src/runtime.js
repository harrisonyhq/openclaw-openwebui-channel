let runtime = null;
export function setOpenWebUIRuntime(next) {
    runtime = next;
}
export function getOpenWebUIRuntime() {
    if (!runtime) {
        throw new Error("[open-webui] Runtime not initialized");
    }
    return runtime;
}
