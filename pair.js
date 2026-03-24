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
import QRCode from "qrcode";
import { upload } from "./mega.js";

const router = express.Router();

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error("Error removing file:", e);
    }
}

function getMegaFileId(url) {
    try {
        const match = url.match(/\/file\/([^#]+#[^\/]+)/);
        return match ? match[1] : null;
    } catch (error) {
        console.error("Error extracting Mega file ID:", error);
        return null;
    }
}

router.get("/", async (req, res) => {
    const sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const dirs = `./pair_sessions/session_${sessionId}`;

    if (!fs.existsSync("./pair_sessions")) {
        fs.mkdirSync("./pair_sessions", { recursive: true });
    }

    await removeFile(dirs);

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version } = await fetchLatestBaileysVersion();

            let qrSent = false;
            let isConnected = false;

            const KnightBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        pino({ level: "silent" })
                    ),
                },
                printQRInTerminal: false,
                logger: pino({ level: "silent" }),
                browser: Browsers.macOS("Safari"),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                syncFullHistory: false,
            });

            // Listen for QR code
            KnightBot.ev.on("connection.update", async (update) => {
                const { connection, qr, lastDisconnect } = update;

                // Send QR Code
                if (qr && !qrSent) {
                    console.log("[PAIR] 🟢 QR Code generated! Sending to client...");
                    try {
                        const qrDataURL = await QRCode.toDataURL(qr, {
                            errorCorrectionLevel: "M",
                            type: "image/png",
                            quality: 0.92,
                            margin: 1,
                            color: {
                                dark: "#000000",
                                light: "#FFFFFF",
                            },
                        });

                        qrSent = true;
                        if (!res.headersSent) {
                            res.send({
                                qr: qrDataURL,
                                message: "QR Code Generated! Scan it with your WhatsApp app.",
                            });
                        }
                    } catch (qrError) {
                        console.error("[PAIR] ❌ Error generating QR:", qrError);
                        if (!res.headersSent) {
                            qrSent = true;
                            res.status(500).send({ code: "Failed to generate QR code" });
                        }
                    }
                }

                // Connection successful
                if (connection === "open") {
                    console.log("[PAIR] ✅ Successfully logged in via QR!");
                    isConnected = true;

                    try {
                        await delay(3000);

                        const credsPath = dirs + "/creds.json";

                        if (!fs.existsSync(credsPath)) {
                            throw new Error("Credentials file not found");
                        }

                        console.log("[PAIR] 📤 Uploading credentials to Mega...");
                        const megaUrl = await upload(credsPath, `creds_pair_${sessionId}.json`);
                        console.log("[PAIR] ✅ Upload successful:", megaUrl);

                        const rawId = getMegaFileId(megaUrl);
                        if (!rawId) {
                            throw new Error("Failed to extract Mega file ID");
                        }

                        const sessionIdBase64 = Buffer.from(rawId).toString("base64");
                        const sessionFinal = `DRAC-MD;;${sessionIdBase64}`;

                        console.log("[PAIR] 📝 Session ID generated:", sessionFinal);

                        const msgBody = `✅ *DRAC-MD SESSION CONNECTED*

*Your Session ID:*

\`\`\`
${sessionFinal}
\`\`\`

*⚠️ IMPORTANT:*
• Never share this Session ID with anyone
• Keep this message safe
• Use this ID to link your bot

*How to use:*
1. Copy the Session ID above
2. Add to your DRAC-MD .env file
3. Set: SESSION_ID=${sessionFinal}
4. Restart your bot

> Made with 💜 by DRAC-MD Team`;

                        const userJid = KnightBot.user.id;
                        if (!userJid) {
                            throw new Error("User JID not available");
                        }

                        console.log("[PAIR] 💬 Sending session to WhatsApp...");

                        let sent = false;
                        for (let i = 0; i < 3; i++) {
                            try {
                                await KnightBot.sendMessage(userJid, { text: msgBody });
                                console.log("[PAIR] ✅ Message sent successfully!");
                                sent = true;
                                break;
                            } catch (sendError) {
                                console.error(`[PAIR] Send attempt ${i + 1} failed:`, sendError.message);
                                if (i < 2) await delay(1000);
                            }
                        }

                        if (!sent) {
                            console.warn("[PAIR] ⚠️ Failed to send message after 3 attempts");
                        }

                        console.log("[PAIR] 🧹 Cleaning up...");
                        await delay(2000);
                        removeFile(dirs);
                        console.log("[PAIR] ✅ Cleanup complete!");

                    } catch (err) {
                        console.error("[PAIR] ❌ Error:", err.message);
                        removeFile(dirs);
                    }
                }

                // Connection closed
                if (connection === "close") {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    console.log("[PAIR] Connection closed. Reason:", reason);

                    if (reason === 401) {
                        console.log("[PAIR] ❌ Unauthorized - Session invalid");
                    } else if (reason === 403) {
                        console.log("[PAIR] ❌ Forbidden - Access denied");
                    } else if (!isConnected && !qrSent) {
                        console.log("[PAIR] 🔄 Reconnecting...");
                        await delay(3000);
                        initiateSession();
                    }
                }
            });

            // Save credentials when updated
            KnightBot.ev.on("creds.update", saveCreds);

            // Timeout handler
            setTimeout(() => {
                if (!qrSent) {
                    console.error("[PAIR] ❌ QR Code generation timeout");
                    if (!res.headersSent) {
                        res.status(408).send({ code: "QR Code generation timeout" });
                    }
                    removeFile(dirs);
                }
            }, 60000);

        } catch (err) {
            console.error("[PAIR] ❌ Session error:", err);
            if (!res.headersSent) {
                res.status(503).send({ code: "Service Unavailable", error: err.message });
            }
            removeFile(dirs);
        }
    }

    await initiateSession();
});

export default router;
