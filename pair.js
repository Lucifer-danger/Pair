import express from "express";
import fs from "fs";
import pino from "pino";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pn from "awesome-phonenumber";
import { upload } from "./mega.js"; // ඔයාගේ mega logic එක පාවිච්චි කරනවා

const router = express.Router();

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error("Error removing file:", e);
    }
}

// Mega link එකෙන් ID එක විතරක් වෙන් කරගන්න logic එක
function getMegaFileId(url) {
    try {
        const match = url.match(/\/file\/([^#]+#[^\/]+)/);
        return match ? match[1] : null;
    } catch (error) {
        return null;
    }
}

router.get("/", async (req, res) => {
    let num = req.query.number;
    let dirs = "./" + (num || `session`);

    await removeFile(dirs);

    num = num.replace(/[^0-9]/g, "");

    const phone = pn("+" + num);
    if (!phone.isValid()) {
        if (!res.headersSent) {
            return res.status(400).send({
                code: "Invalid phone number. Please enter your full international number (e.g. 94771234567)",
            });
        }
    }

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);
        const { version } = await fetchLatestBaileysVersion();

        try {
            const KnightBot = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                browser: Browsers.macOS("Safari"), // Pairing code එකට හොඳම මේක
                version,
            });

            // Pairing Code එක Request කිරීම
            if (!KnightBot.authState.creds.registered) {
                await delay(1500);
                const code = await KnightBot.requestPairingCode(num);
                if (!res.headersSent) {
                    res.send({ code: code });
                }
            }

            // --- [මෙතන තමයි වැදගත්ම FIX එක තියෙන්නේ] ---
            KnightBot.ev.on("connection.update", async (s) => {
                const { connection, lastDisconnect } = s;

                if (connection === "open") {
                    console.log("Connected successfully to WhatsApp!");
                    await delay(10000); // Creds හරි හැටි save වෙන්න වෙලාව දෙනවා

                    try {
                        const credsPath = dirs + "/creds.json";
                        
                        // 1. Mega එකට upload කිරීම
                        const megaUrl = await upload(credsPath, "creds.json");
                        
                        // 2. Session ID එක සකස් කිරීම
                        const rawId = getMegaFileId(megaUrl);
                        const sessionId = Buffer.from(rawId).toString("base64");
                        
                        const sessionFinal = `DRAC-MD;;${sessionId}`;
                        
                        const msgBody = `✅ *DRAC-MD SESSION CONNECTED*\n\n*Session ID:* \n\n${sessionFinal}\n\n> *ඔයාගේ මේ Session ID එක කාටවත් දෙන්න එපා.*`;

                        // 3. තමන්ටම මැසේජ් එකක් යැවීම
                        await KnightBot.sendMessage(KnightBot.user.id, { text: msgBody });
                        
                        console.log("Session ID sent to WhatsApp!");

                        // 4. Cleanup
                        await delay(2000);
                        removeFile(dirs);
                        // process.exit(0); // අවශ්‍ය නම් පමණක් පාවිච්චි කරන්න

                    } catch (err) {
                        console.error("Mega upload or message error:", err);
                    }
                }

                if (connection === "close") {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    if (reason !== 401) { // 401 කියන්නේ logout වීම, එහෙම නැත්නම් ආයෙත් reconnect වෙනවා
                        initiateSession();
                    }
                }
            });

            KnightBot.ev.on("creds.update", saveCreds);

        } catch (err) {
            console.error("Error initializing session:", err);
            if (!res.headersSent) {
                res.status(503).send({ code: "Service Unavailable" });
            }
        }
    }

    await initiateSession();
});

export default router;
