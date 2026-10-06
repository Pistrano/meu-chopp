/* Ponte segura entre a interface e o sistema (contextIsolation ligado) */
const { contextBridge, ipcRenderer } = require("electron");

const ALLOWED = /^(auth|units|dashboard|alerts|barris|transfer|history|audit|users):[a-zA-Z]+$/;

contextBridge.exposeInMainWorld("api", {
  invoke: (channel, payload) => {
    if (!ALLOWED.test(channel)) throw new Error("Canal não permitido: " + channel);
    return ipcRenderer.invoke(channel, payload);
  },
});
