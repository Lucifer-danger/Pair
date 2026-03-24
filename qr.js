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
        return null;
    }
}

router.get("/", async (req, res) => {
    const sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const dirs = `./qr_sessions/session_${sessionId}`;

    if (!fs.existsSync("./qr_sessions")) {
        fs.mkdirSync("./qr_sessions", { recursive: true });
    }

    await removeFile(dirs);

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version } = await fetchLatestBaileysVersion();

            let qrSent = false;

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
                browser: Browsers.windows("Chrome"),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                syncFullHistory: false,
            });

            KnightBot.ev.on("connection.update", async (update) => {
                const { connection, qr, lastDisconnect } = update;

                // Send QR Code to client
                if (qr && !qrSent) {
                    console.log("[QR] 🟢 QR Code generated!");

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
                        res.send({
                            qr: qrDataURL,
                            message: "QR Code Generated! Scan it with your WhatsApp app.",
                            instructions: [
                                "1. Open WhatsApp on your phone",
                                "2. Go to Settings > Linked Devices",
                                '3. Tap "Link a Device"',
                                "4. Scan the QR code above",
                            ],
                        });
                        console.log("[QR] ✅ QR Code sent to client");
                    } catch (qrError) {
                        console.error("[QR] ❌ Error generating QR:", qrError);
                        if (!qrSent) {
                            qrSent = true;
                            res.status(500).send({ code: "Failed to generate QR code" });
                        }
                    }
                }

                // Successfully connected
                if (connection === "open") {
                    console.log("[QR] ✅ Connected successfully!");

                    try {
                        await delay(3000);

                        const credsPath = dirs + "/creds.json";

                        // Wait for creds file
                        let attempts = 0;
                        while (!fs.existsSync(credsPath) && attempts < 20) {
                            await delay(500);
                            attempts++;
                        }

                        if (!fs.existsSync(credsPath)) {
                            throw new Error("Credentials file not created");
                        }

                        console.log("[QR] 📤 Uploading to Mega...");
                        const megaUrl = await upload(credsPath, `creds_qr_${sessionId}.json`);

                        const megaFileId = getMegaFileId(megaUrl);
                        if (megaFileId) {
                            console.log("[QR] ✅ Uploaded to Mega:", megaFileId);

                            const userJid = KnightBot.user?.id;
                            if (userJid) {
                                await KnightBot.sendMessage(userJid, {
                                    text: `Your Session:\n\`\`\`\nDRAC-MD;;${Buffer.from(megaFileId).toString("base64")}\n\`\`\``,
                                });
                                console.log("[QR] ✅ Session sent!");
                            }
                        }

                        console.log("[QR] 🧹 Cleaning up...");
                        await delay(2000);
                        removeFile(dirs);
                        console.log("[QR] ✅ Complete!");

                    } catch (error) {
                        console.error("[QR] ❌ Error:", error.message);
                        removeFile(dirs);
                    }
                }

                // Connection closed
                if (connection === "close") {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    console.log("[QR] Connection closed:", reason);

                    if (reason !== 401 && reason !== 403) {
                        if (!qrSent) {
                            console.log("[QR] 🔄 Reconnecting...");
                            await delay(3000);
                            await initiateSession();
                        }
                    }
                }
            });

            KnightBot.ev.on("creds.update", saveCreds);

            // Timeout
            setTimeout(() => {
                if (!qrSent) {
                    console.error("[QR] ❌ Timeout - No QR generated");
                    res.status(408).send({ code: "QR generation timeout" });
                    removeFile(dirs);
                }
            }, 45000);

        } catch (err) {
            console.error("[QR] ❌ Error:", err);
            if (!res.headersSent) {
                res.status(503).send({ code: "Service Unavailable" });
            }
            removeFile(dirs);
        }
    }

    await initiateSession();
});

process.on("uncaughtException", (err) => {
    let e = String(err);
    if (e.includes("conflict")) return;
    if (e.includes("not-authorized")) return;
    if (e.includes("Socket connection timeout")) return;
    if (e.includes("rate-overlimit")) return;
    if (e.includes("Connection Closed")) return;
    if (e.includes("Timed Out")) return;
    if (e.includes("Value not found")) return;
    if (e.includes("Stream Errored")) return;
    if (e.includes("statusCode: 515") || e.includes("statusCode: 503")) return;
    console.error("[QR] Uncaught Exception:", err);
});

export default router;
