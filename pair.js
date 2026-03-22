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

// Extract Mega file ID from URL
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
    let num = req.query.number;
    let dirs = "./" + (num || `session`);

    await removeFile(dirs);

    num = num.replace(/[^0-9]/g, "");

    // Validate phone number
    const phone = pn("+" + num);
    if (!phone.isValid()) {
        console.error("Invalid phone number:", num);
        if (!res.headersSent) {
            return res.status(400).send({
                code: "Invalid phone number. Please enter your full international number (e.g. 94771234567)",
            });
        }
    }

    console.log(`[PAIR] Starting pairing for number: ${num}`);

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
                browser: Browsers.macOS("Safari"),
                version,
            });

            // Request pairing code
            if (!KnightBot.authState.creds.registered) {
                await delay(1500);
                const code = await KnightBot.requestPairingCode(num);
                console.log(`[PAIR] Pairing code generated: ${code}`);
                
                if (!res.headersSent) {
                    res.send({ code: code });
                }
            }

            let isConnected = false;

            KnightBot.ev.on("connection.update", async (s) => {
                const { connection, lastDisconnect } = s;

                // Connection established
                if (connection === "open") {
                    console.log("[PAIR] ✅ Connected successfully to WhatsApp!");
                    isConnected = true;

                    // Wait for credentials to be fully saved
                    await delay(3000);

                    try {
                        const credsPath = dirs + "/creds.json";

                        // Check if creds file exists
                        if (!fs.existsSync(credsPath)) {
                            throw new Error("Credentials file not found");
                        }

                        console.log("[PAIR] 📤 Uploading credentials to Mega...");
                        
                        // Upload to Mega
                        const megaUrl = await upload(credsPath, `creds_${num}.json`);
                        console.log("[PAIR] ✅ Upload successful:", megaUrl);

                        // Extract file ID
                        const rawId = getMegaFileId(megaUrl);
                        if (!rawId) {
                            throw new Error("Failed to extract Mega file ID");
                        }

                        const sessionId = Buffer.from(rawId).toString("base64");
                        const sessionFinal = `DRAC-MD;;${sessionId}`;

                        console.log("[PAIR] 📝 Session ID generated:", sessionFinal);

                        // Prepare message
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

                        // Get user JID properly
                        const userJid = KnightBot.user.id;
                        if (!userJid) {
                            throw new Error("User JID not available");
                        }

                        console.log("[PAIR] 💬 Sending session ID to WhatsApp...");
                        console.log("[PAIR] Target JID:", userJid);

                        // Send message with retry logic
                        let sent = false;
                        for (let i = 0; i < 3; i++) {
                            try {
                                await KnightBot.sendMessage(userJid, { 
                                    text: msgBody 
                                });
                                console.log("[PAIR] ✅ Message sent successfully!");
                                sent = true;
                                break;
                            } catch (sendError) {
                                console.error(`[PAIR] Send attempt ${i + 1} failed:`, sendError.message);
                                if (i < 2) {
                                    await delay(1000);
                                }
                            }
                        }

                        if (!sent) {
                            console.warn("[PAIR] ⚠️  Failed to send message after 3 attempts");
                        }

                        console.log("[PAIR] 🧹 Cleaning up session files...");
                        await delay(2000);
                        removeFile(dirs);

                        console.log("[PAIR] ✅ Session cleanup complete!");
                        console.log("[PAIR] 🎉 Pairing process completed successfully!");

                    } catch (err) {
                        console.error("[PAIR] ❌ Error during session handling:", err.message);
                        console.error("[PAIR] Full error:", err);
                    }
                }

                // Connection closed
                if (connection === "close") {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    console.log("[PAIR] Connection closed with reason:", reason);

                    if (reason === 401) {
                        console.log("[PAIR] ❌ Unauthorized - Session needs re-pairing");
                    } else if (!isConnected) {
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
                if (!isConnected) {
                    console.error("[PAIR] ❌ Connection timeout - no response from WhatsApp");
                    if (!res.headersSent) {
                        res.status(408).send({ code: "Connection timeout" });
                    }
                    removeFile(dirs);
                }
            }, 60000);

        } catch (err) {
            console.error("[PAIR] ❌ Session initialization error:", err);
            if (!res.headersSent) {
                res.status(503).send({ 
                    code: "Service Unavailable",
                    error: err.message 
                });
            }
            removeFile(dirs);
        }
    }

    await initiateSession();
});

export default router;
