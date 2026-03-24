import express from "express";
import fs from "fs";
import pino from "pino";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { upload } from "./mega.js";

const router = express.Router();

function cleanup(dirs) {
    try {
        if (fs.existsSync(dirs)) fs.rmSync(dirs, { recursive: true, force: true });
    } catch (e) { console.error("Cleanup error:", e); }
}

router.get("/", async (req, res) => {
    let num = req.query.number;
    if (!num) return res.status(400).send({ error: "Number required" });
    
    num = num.replace(/[^0-9]/g, '');
    const sessionId = `DANUWA_${Math.random().toString(36).substring(7)}`;
    const dirs = `./sessions/${sessionId}`;

    if (!fs.existsSync("./sessions")) fs.mkdirSync("./sessions");

    async function start() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            loadingScreen: false,
            logger: pino({ level: "silent" }),
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
            },
            // This specific browser array fixes the "Normal WhatsApp" pairing issue
            browser: ["Ubuntu", "Chrome", "20.0.04"] 
        });

        if (!sock.authState.creds.registered) {
            await delay(2000);
            try {
                const code = await sock.requestPairingCode(num);
                if (!res.headersSent) res.send({ code });
            } catch (err) {
                if (!res.headersSent) res.status(500).send({ error: "Pairing failed" });
            }
        }

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === "open") {
                await delay(10000); // Critical: Wait for creds.json to fully populate
                const credsPath = `${dirs}/creds.json`;

                if (fs.existsSync(credsPath)) {
                    try {
                        const url = await upload(credsPath, `creds.json`);
                        const megaId = url.split("file/")[1];
                        // Double Base64 encoding is standard for this bot's session format
                        const finalSession = `DANUWA-MD;;${Buffer.from(megaId).toString("base64")}`;

                        await sock.sendMessage(sock.user.id, { 
                            text: `✅ *DANUWA-MD CONNECTED*\n\n*SESSION ID:*\n${finalSession}` 
                        });
                    } catch (uploadErr) {
                        console.error("Upload failed", uploadErr);
                    }
                }
                
                await delay(5000);
                cleanup(dirs);
                // We don't close the process so other requests can come in
            }

            if (connection === "close") {
                const reason = lastDisconnect?.error?.output?.statusCode;
                if (reason !== 401) start(); // Auto-reconnect if not logged out
            }
        });
    }

    start().catch(() => {
        if (!res.headersSent) res.status(500).send({ error: "Internal Error" });
    });
});

export default router;
