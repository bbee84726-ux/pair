
const express = require("express");
const fs = require("fs");
const { exec } = require("child_process");
const pino = require("pino");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const { upload } = require("./mega");

const router = express.Router();

const SESSION_PATH = "./session";

function removeFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return false;

        fs.rmSync(filePath, {
            recursive: true,
            force: true
        });

        return true;
    } catch (err) {
        console.error("Failed to remove:", filePath, err);
        return false;
    }
}

function randomMegaId(length = 6, numberLength = 4) {
    const characters =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    let result = "";

    for (let i = 0; i < length; i++) {
        result += characters.charAt(
            Math.floor(Math.random() * characters.length)
        );
    }

    const number = Math.floor(
        Math.random() * Math.pow(10, numberLength)
    );

    return `${result}${number}`;
}

router.get("/", async (req, res) => {
    let num = req.query.number;

    if (!num) {
        return res.status(400).json({
            error: "number query parameter is required"
        });
    }

    num = String(num).replace(/[^0-9]/g, "");

    if (!num) {
        return res.status(400).json({
            error: "Invalid phone number"
        });
    }

    async function DanuwaPair() {
        let socket;

        try {
            const { state, saveCreds } =
                await useMultiFileAuthState(SESSION_PATH);

            socket = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        pino({ level: "fatal" }).child({
                            level: "fatal"
                        })
                    )
                },

                printQRInTerminal: false,

                logger: pino({
                    level: "fatal"
                }),

                browser: Browsers.macOS("Safari")
            });

            /*
             * Save credentials whenever they change.
             */
            socket.ev.on("creds.update", saveCreds);

            /*
             * Request pairing code.
             */
            if (!state.creds.registered) {
                await delay(1500);

                try {
                    const code =
                        await socket.requestPairingCode(num);

                    if (!res.headersSent) {
                        res.json({
                            code
                        });
                    }
                } catch (err) {
                    console.error(
                        "Pairing code error:",
                        err
                    );

                    if (!res.headersSent) {
                        res.status(500).json({
                            error: "Failed to generate pairing code"
                        });
                    }

                    await removeFile(SESSION_PATH);
                    return;
                }
            }

            /*
             * Connection events.
             */
            socket.ev.on(
                "connection.update",
                async (update) => {
                    const {
                        connection,
                        lastDisconnect
                    } = update;

                    /*
                     * WhatsApp connection opened.
                     */
                    if (connection === "open") {
                        console.log(
                            "WhatsApp connection opened."
                        );

                        try {
                            /*
                             * Wait for credentials to finish saving.
                             */
                            await delay(5000);

                            const credsPath =
                                `${SESSION_PATH}/creds.json`;

                            if (!fs.existsSync(credsPath)) {
                                throw new Error(
                                    "creds.json was not created"
                                );
                            }

                            /*
                             * Upload session to Mega.
                             */
                            const megaUrl = await upload(
                                fs.createReadStream(credsPath),
                                `${randomMegaId()}.json`
                            );

                            if (!megaUrl) {
                                throw new Error(
                                    "Mega upload failed"
                                );
                            }

                            const stringSession =
                                megaUrl.replace(
                                    "https://mega.nz/file/",
                                    ""
                                );

                            const userJid =
                                jidNormalizedUser(
                                    socket.user.id
                                );

                            /*
                             * Send session ID to WhatsApp user.
                             */
                            await socket.sendMessage(
                                userJid,
                                {
                                    text: stringSession
                                }
                            );

                            console.log(
                                "Session sent successfully."
                            );

                        } catch (err) {
                            console.error(
                                "Session generation error:",
                                err
                            );

                            /*
                             * Restart PM2 only if needed.
                             */
                            exec(
                                "pm2 restart danuwa",
                                (error) => {
                                    if (error) {
                                        console.error(
                                            "PM2 restart error:",
                                            error
                                        );
                                    }
                                }
                            );

                            return;
                        }

                        /*
                         * Remove temporary session.
                         */
                        await delay(100);

                        removeFile(SESSION_PATH);

                        /*
                         * Do NOT call process.exit() here.
                         * It would terminate the entire Node.js process.
                         */
                    }

                    /*
                     * Connection closed.
                     */
                    else if (connection === "close") {
                        const statusCode =
                            lastDisconnect?.error?.output
                                ?.statusCode;

                        console.log(
                            "WhatsApp connection closed.",
                            "Status:",
                            statusCode
                        );

                        /*
                         * 401 = logged out / invalid session.
                         * Do not reconnect using the same session.
                         */
                        if (
                            statusCode ===
                            DisconnectReason.loggedOut
                        ) {
                            console.log(
                                "Logged out. Removing session."
                            );

                            await removeFile(SESSION_PATH);
                            return;
                        }

                        /*
                         * Reconnect for temporary disconnects.
                         */
                        console.log(
                            "Reconnecting in 10 seconds..."
                        );

                        await delay(10000);

                        try {
                            await DanuwaPair();
                        } catch (err) {
                            console.error(
                                "Reconnect failed:",
                                err
                            );
                        }
                    }
                }
            );

        } catch (err) {
            console.error(
                "DanuwaPair error:",
                err
            );

            /*
             * Clean temporary session.
             */
            await removeFile(SESSION_PATH);

            /*
             * Send error only if response hasn't
             * already been sent.
             */
            if (!res.headersSent) {
                return res.status(503).json({
                    code: "Service Unavailable"
                });
            }

            /*
             * Restart PM2.
             */
            exec(
                "pm2 restart danuwa-md",
                (error) => {
                    if (error) {
                        console.error(
                            "PM2 restart error:",
                            error
                        );
                    }
                }
            );
        }
    }

    await DanuwaPair();
});

/*
 * Global error handlers.
 */
process.on("uncaughtException", (err) => {
    console.error(
        "Caught exception:",
        err
    );

    exec(
        "pm2 restart danuwa",
        (error) => {
            if (error) {
                console.error(
                    "PM2 restart error:",
                    error
                );
            }
        }
    );
});

process.on("unhandledRejection", (reason) => {
    console.error(
        "Unhandled promise rejection:",
        reason
    );
});

module.exports = router;
