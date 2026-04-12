const { contextBridge } = require('electron');
const fs = require('fs');
const path = require('path');

// Exponera säkra API:er till renderingsprocessen
contextBridge.exposeInMainWorld('electronAPI', {
    readFile: (filePath) => {
        try {
            // Vi tillåter bara läsning i appens mapp av säkerhetsskäl
            const fullPath = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
            if (fs.existsSync(fullPath)) {
                return fs.readFileSync(fullPath, 'utf8');
            }
        } catch (e) {
            console.error("Fel vid filläsning:", e);
        }
        return null;
    },
    writeFile: (filePath, data) => {
        try {
            const fullPath = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
            fs.writeFileSync(fullPath, data, 'utf8');
            return true;
        } catch (e) {
            console.error("Fel vid filskrivning:", e);
            return false;
        }
    },
    exists: (filePath) => {
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
        return fs.existsSync(fullPath);
    },
    joinPath: (...args) => path.join(...args),
    getDirname: () => __dirname,
    saveImage: (dataUrl, filename) => {
        const fs = require('fs');
        const path = require('path');
        const base64Data = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
        const dir = path.join(__dirname, 'incidents');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, filename), base64Data, 'base64');
        return path.join(dir, filename);
    },
    getActiveWindow: () => {
        const { exec } = require('child_process');
        return new Promise((resolve) => {
            const cmd = 'powershell -Command "Get-Process | Where-Object {$_.MainWindowTitle} | Select-Object -ExpandProperty MainWindowTitle -First 1"';
            exec(cmd, (error, stdout) => {
                if (error) {
                    resolve("Desktop");
                } else {
                    resolve(stdout.trim() || "Desktop");
                }
            });
        });
    },
    ollamaCheck: () => {
        const { ipcRenderer } = require('electron');
        return ipcRenderer.invoke('ollama-check');
    },
    ollamaRequest: (data) => {
        const { ipcRenderer } = require('electron');
        return ipcRenderer.invoke('ollama-request', data);
    }
});
