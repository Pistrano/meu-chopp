/* ==========================================================
   BarrilFacil — aplicativo para Windows (PC / tablet / tela do quiosque)
   É só uma janela que se conecta ao servidor central; nenhum dado
   fica guardado neste aparelho. O endereço do servidor é informado
   uma vez e fica salvo em config.json.
   ========================================================== */
const { app, BrowserWindow, Menu, ipcMain, net, dialog, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");

const CONNECT_PAGE = path.join(__dirname, "connect.html");
let win = null;

/* Atualização automática do aplicativo (electron-updater, via GitHub Releases).
   Só funciona no aplicativo instalado (npm run dist). Se o pacote não estiver instalado ou algo falhar,
   o app segue funcionando normalmente: atualizar nunca pode impedir o uso. */
let autoUpdater = null;
try { ({ autoUpdater } = require("electron-updater")); } catch (_) { autoUpdater = null; }
let verificacaoManual = false; // true só quando a pessoa pede em "Verificar atualizações…"

const configFile = () => path.join(app.getPath("userData"), "config.json");

// Sem endereço padrão: na primeira abertura o app sempre pede o endereço do servidor (connect.html)
const DEFAULT_SERVER_URL = "";

function readConfig() {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(configFile(), "utf8")
    );

    return {
      ...cfg,
      serverUrl: cfg.serverUrl || DEFAULT_SERVER_URL
    };
  } catch (_) {
    return {
      serverUrl: DEFAULT_SERVER_URL,
      kiosk: false
    };
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}

function normalizeUrl(input) {
  let value = String(input || "").trim().replace(/\/+$/, "");
  if (!value) throw new Error("Informe o endereço do servidor.");
  if (!/^https?:\/\//i.test(value)) value = (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?$/i.test(value) ? "http://" : "https://") + value;
  const u = new URL(value);
  return u.origin;
}

function showConnect(error) {
  win.loadFile(CONNECT_PAGE, { query: error ? { erro: error } : {} });
}

function openApp() {
  const cfg = readConfig();
  if (!cfg.serverUrl) return showConnect();
  win.setFullScreen(!!cfg.kiosk);
  win.loadURL(cfg.serverUrl).catch(() => {}); // falhas aparecem em did-fail-load
}

function setupAutoUpdate() {
  if (!app.isPackaged || !autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // se a pessoa ignorar o aviso, instala ao fechar o app

  const caixa = (opts) => dialog.showMessageBox(win, { type: "info", buttons: ["OK"], ...opts });

  autoUpdater.on("update-available", (info) => {
    if (verificacaoManual) caixa({ title: "BarrilFacil", message: `Versão ${info.version} encontrada.`, detail: "Ela está sendo baixada em segundo plano. Você será avisado quando estiver pronta." });
  });
  autoUpdater.on("update-not-available", () => {
    if (verificacaoManual) caixa({ title: "BarrilFacil", message: "Você já está na versão mais recente.", detail: `Versão ${app.getVersion()}.` });
    verificacaoManual = false;
  });
  autoUpdater.on("error", (err) => {
    console.error("[atualização]", err && err.message);
    if (verificacaoManual) caixa({ type: "warning", title: "BarrilFacil", message: "Não foi possível verificar atualizações.", detail: "Confira a internet deste aparelho e tente de novo mais tarde." });
    verificacaoManual = false;
  });
  autoUpdater.on("update-downloaded", async (info) => {
    verificacaoManual = false;
    // Não reinicia sozinho: poderia interromper alguém no meio de um engate ou recolhimento.
    const { response } = await dialog.showMessageBox(win, {
      type: "info", title: "BarrilFacil", buttons: ["Reiniciar agora", "Depois"], defaultId: 1, cancelId: 1,
      message: `A versão ${info.version} está pronta.`,
      detail: "Reinicie o aplicativo para atualizar. Se escolher \"Depois\", a atualização é instalada quando o aplicativo for fechado.",
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  const verificar = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(verificar, 10 * 1000);                 // logo depois de abrir
  setInterval(verificar, 6 * 60 * 60 * 1000);       // e a cada 6 horas (o tablet/PC da unidade fica ligado o dia todo)
}

function verificarAtualizacoes() {
  const aviso = (message) => dialog.showMessageBox(win, { type: "info", buttons: ["OK"], title: "BarrilFacil", message, detail: `Versão ${app.getVersion()}.` });
  if (!app.isPackaged) return aviso("A atualização automática só funciona no aplicativo instalado.");
  if (!autoUpdater) return aviso("Esta versão do aplicativo foi gerada sem o componente de atualização automática.");
  verificacaoManual = true;
  return autoUpdater.checkForUpdates().catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f1115" : "#f4f5f7", // evita o clarão branco ao abrir no tema escuro
    title: "BarrilFacil",
    icon: path.join(__dirname, "..", "..", "build", "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "BarrilFacil", submenu: [
      { label: "Alterar servidor…", click: () => showConnect() },
      { label: "Recarregar", accelerator: "CmdOrCtrl+R", click: () => win.webContents.reload() },
      { label: "Tela cheia", accelerator: "F11", click: () => win.setFullScreen(!win.isFullScreen()) },
      { type: "separator" },
      { label: `Versão ${app.getVersion()}`, enabled: false },
      { label: "Verificar atualizações…", click: () => verificarAtualizacoes() },
      { type: "separator" },
      { label: "Sair", role: "quit" },
    ] },
  ]));

  // Só navega para o servidor configurado ou para as telas locais de conexão
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    const cfg = readConfig();
    let allowed = url.startsWith("file://");
    try { allowed = allowed || (cfg.serverUrl && new URL(url).origin === new URL(cfg.serverUrl).origin); } catch (_) { /* inválida */ }
    if (!allowed) event.preventDefault();
  });
  // Servidor fora do ar / sem internet: volta para a tela de conexão (que tenta de novo sozinha)
  win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || String(url).startsWith("file://")) return;
    showConnect(`Não foi possível conectar ao servidor (${desc}).`);
  });

  openApp();
  setupAutoUpdate();
}

/* A tela de conexão (arquivo local) é a única que pode usar estes comandos */
const fromLocalPage = (event) => String(event.senderFrame && event.senderFrame.url).startsWith("file://");

ipcMain.handle("shell:getConfig", (event) => (fromLocalPage(event) ? readConfig() : {}));
ipcMain.handle("shell:retry", (event) => { if (fromLocalPage(event)) openApp(); });
ipcMain.handle("shell:connect", async (event, { url, kiosk }) => {
  if (!fromLocalPage(event)) return { ok: false, error: "Não permitido." };
  try {
    const serverUrl = normalizeUrl(url);
    const res = await net.fetch(serverUrl + "/healthz", { signal: AbortSignal.timeout(8000) });
    // Servidores de antes da troca de nome respondem com o nome antigo: também são aceitos
    if (!res.ok || !/BarrilFacil|MeuChopp/.test(await res.text())) throw new Error("Esse endereço não é um servidor BarrilFacil.");
    writeConfig({ serverUrl, kiosk: !!kiosk });
    setImmediate(openApp);
    return { ok: true };
  } catch (err) {
    const msg = err.name === "TimeoutError" ? "O servidor não respondeu a tempo." : err.message;
    return { ok: false, error: `Não foi possível conectar: ${msg}` };
  }
});

const gotLock = app.requestSingleInstanceLock(); // evita abrir duas janelas no mesmo aparelho
if (!gotLock) app.quit();
else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
  app.on("window-all-closed", () => app.quit());
}
