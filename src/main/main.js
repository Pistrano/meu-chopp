/* MeuChopp — processo principal do Electron */
const { app, BrowserWindow, Menu, dialog } = require("electron");
const path = require("path");
const { initDatabase } = require("./db");
const { registerHandlers } = require("./ipc");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#f4f5f7",
    title: "MeuChopp",
    icon: path.join(__dirname, "..", "..", "build", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (app.isPackaged) Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady().then(async () => {
  try {
    await initDatabase(app.getPath("userData"));
  } catch (err) {
    dialog.showErrorBox("MeuChopp", "Não foi possível abrir o banco de dados:\n" + err.message);
    app.quit();
    return;
  }
  registerHandlers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
