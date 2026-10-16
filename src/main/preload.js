/* Ponte segura: só a tela local de conexão recebe estes comandos (nunca o site do servidor). */
const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("shell", {
    getConfig: () => ipcRenderer.invoke("shell:getConfig"),
    connect: (url, kiosk) => ipcRenderer.invoke("shell:connect", { url, kiosk }),
    retry: () => ipcRenderer.invoke("shell:retry"),
  });
}
