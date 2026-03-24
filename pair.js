import express from "express";
import fs from "fs";
import pino from "pino";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { upload } from "./mega.js";

const router = express.Router();

function removeFile(FilePath) {
    try {
        if (fs.existsSync(FilePath)) fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error("Error removing file:", e);
    }
}

router.get("/", async (req, res) => {
    let phoneNumber = req.query.number;
    
    // Validate phone number
    if (!phoneNumber || phoneNumber === "default") {
        return res.status(400).send({ error: "A valid phone number is required for Pairing Code." });
    }

    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
    const sessionId = Date.now().toString();
    const dirs = `./pair_sessions/session_${sessionId}`;

    if (!fs.existsSync("./pair_sessions")) fs.mkdirSync("./pair_sessions", { recursive: true });

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);
        try {
            const { version } = await fetchLatestBaileysVersion();
            const KnightBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                // Required browser setting for pairing codes
                browser: ["Ubuntu", "Chrome", "20.0.04"],
            });

            // REQUEST PAIRING CODE
            if (!state.creds.registered) {
                await delay(1500); // Small delay to ensure socket is ready
                const code = await KnightBot.requestPairingCode(phoneNumber);
                if (!res.headersSent) {
                    res.send({ code: code });
                }
            }

            KnightBot.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect } = update;

                if (connection === "open") {
                    await delay(5000); // Wait for credentials to save to disk
                    const credsPath = `${dirs}/creds.json`;
                    
                    if (fs.existsSync(credsPath)) {
                        const megaUrl = await upload(credsPath, `creds_${sessionId}.json`);
                        const rawId = megaUrl.split('/file/')[1];
                        const sessionFinal = `DRAC-MD;;${Buffer.from(rawId).toString("base64")}`;

                        await KnightBot.sendMessage(KnightBot.user.id, { 
                            text: `✅ *CONNECTED*\n\n*Session ID:*\n\`\`\`${sessionFinal}\`\`\`` 
                        });
                    }
                    await delay(2000);
                    removeFile(dirs);
                }

                if (connection === "close") {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    if (reason !== 401) initiateSession();
                }
            });

            KnightBot.ev.on("creds.update", saveCreds);
        } catch (err) {
            console.error(err);
            if (!res.headersSent) res.status(500).send({ error: "Internal Server Error" });
        }
    }
    await initiateSession();
});

export default router;
