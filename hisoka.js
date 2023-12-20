import "dotenv/config"
import serialize, { Client } from "./lib/serialize.js"
import { formatSize, parseFileSize, sendTelegram } from "./lib/function.js"

import makeWASocket, { delay, useMultiFileAuthState, fetchLatestWaWebVersion, makeInMemoryStore, jidNormalizedUser, PHONENUMBER_MCC, DisconnectReason } from "@whiskeysockets/baileys"
import pino from "pino"
import { Boom } from "@hapi/boom"
import fs from "fs"
import os from "os"
import { exec } from "child_process"
import treeKill from "./lib/tree-kill.js"

const logger = pino({ timestamp: () => `,"time":"${new Date().toJSON()}"` }).child({ class: "hisoka" })
logger.level = "fatal"

const usePairingCode = process.env.PAIRING_NUMBER

const store = makeInMemoryStore({ logger })
if (process.env.WRITE_STORE === 'true') store.readFromFile(`./${process.env.SESSION_NAME}/store.json`)

const startSock = async () => {
   const { state, saveCreds } = await useMultiFileAuthState(`./${process.env.SESSION_NAME}`)
   const { version, isLatest } = await fetchLatestWaWebVersion()

   console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

   const hisoka = makeWASocket.default({
      version,
      logger,
      printQRInTerminal: !usePairingCode,
      auth: state,
      browser: ['Chrome (Linux)', '', ''],
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: true,
      syncFullHistory: true,
      getMessage
   })

   store.bind(hisoka.ev)
   await Client({ hisoka, store })

   // login dengan pairing
   if (usePairingCode && !hisoka.authState.creds.registered) {
      let phoneNumber = usePairingCode.replace(/[^0-9]/g, '')

      if (!Object.keys(PHONENUMBER_MCC).some(v => phoneNumber.startsWith(v))) throw "Start with your country's WhatsApp code, Example : 62xxx"

      await delay(3000)
      let code = await hisoka.requestPairingCode(phoneNumber)
      console.log(`\x1b[32m${code?.match(/.{1,4}/g)?.join("-") || code}\x1b[39m`)
   }

   // ngewei info, restart or close
   hisoka.ev.on("connection.update", (update) => {
      const { lastDisconnect, connection, qr } = update
      if (connection) {
         console.info(`Connection Status : ${connection}`)
      }

      if (connection === "close") {
         let reason = new Boom(lastDisconnect?.error)?.output.statusCode

         switch (reason) {
            case DisconnectReason.badSession:
               console.info(`Bad Session File, Restart Required`)
               startSock()
               break
            case DisconnectReason.connectionClosed:
               console.info("Connection Closed, Restart Required")
               startSock()
               break
            case DisconnectReason.connectionLost:
               console.info("Connection Lost from Server, Reconnecting...")
               startSock()
               break
            case DisconnectReason.connectionReplaced:
               console.info("Connection Replaced, Restart Required")
               startSock()
               break
            case DisconnectReason.restartRequired:
               console.info("Restart Required, Restarting...")
               startSock()
               break
            case DisconnectReason.loggedOut:
               console.error("Device has Logged Out, please rescan again...")
               hisoka.end()
               fs.rmSync(`./${process.env.SESSION_NAME}`, { recursive: true, force: true })
               exec("npm run stop:pm2", (err) => {
                  if (err) return treeKill(process.pid)
               })
               break
            case DisconnectReason.multideviceMismatch:
               console.error("Nedd Multi Device Version, please update and rescan again...")
               hisoka.end()
               fs.rmSync(`./${process.env.SESSION_NAME}`, { recursive: true, force: true })
               exec("npm run stop:pm2", (err) => {
                  if (err) return treeKill(process.pid)
               })
               break
            default:
               console.log("Aku ra ngerti masalah opo iki")
               startSock()
         }
      }

      if (connection === "open") {
         hisoka.sendMessage(jidNormalizedUser(hisoka.user.id), { text: `${hisoka.user?.name} has Connected...` })
      }
   })

   // write session kang
   hisoka.ev.on("creds.update", saveCreds)

   // add contacts update to store
   hisoka.ev.on("contacts.update", (update) => {
      for (let contact of update) {
         let id = jidNormalizedUser(contact.id)
         if (store && store.contacts) store.contacts[id] = { ...(store.contacts?.[id] || {}), ...(contact || {}) }
      }
   })

   // add contacts upsert to store
   hisoka.ev.on("contacts.upsert", (update) => {
      for (let contact of update) {
         let id = jidNormalizedUser(contact.id)
         if (store && store.contacts) store.contacts[id] = { ...(contact || {}), isContact: true }
      }
   })

   // nambah perubahan grup ke store
   hisoka.ev.on("groups.update", (updates) => {
      for (const update of updates) {
         const id = update.id
         if (store.groupMetadata[id]) {
            store.groupMetadata[id] = { ...(store.groupMetadata[id] || {}), ...(update || {}) }
         }
      }
   })

   // merubah status member
   hisoka.ev.on('group-participants.update', ({ id, participants, action }) => {
      const metadata = store.groupMetadata[id]
      if (metadata) {
         switch (action) {
            case 'add':
            case "revoked_membership_requests":
               metadata.participants.push(...participants.map(id => ({ id: jidNormalizedUser(id), admin: null })))
               break
            case 'demote':
            case 'promote':
               for (const participant of metadata.participants) {
                  let id = jidNormalizedUser(participant.id)
                  if (participants.includes(id)) {
                     participant.admin = (action === "promote" ? "admin" : null)
                  }
               }
               break
            case 'remove':
               metadata.participants = metadata.participants.filter(p => !participants.includes(jidNormalizedUser(p.id)))
               break
         }
      }
   })

   // bagian pepmbaca status ono ng kene
   hisoka.ev.on("messages.upsert", async ({ messages }) => {
      if (!messages[0].message) return
      let m = await serialize(hisoka, messages[0], store)

      // nambah semua metadata ke store
      if (store.groupMetadata && Object.keys(store.groupMetadata).length === 0) store.groupMetadata = await hisoka.groupFetchAllParticipating()

      // untuk membaca pesan status
      if (m.key && !m.key.fromMe && m.key.remoteJid === "status@broadcast") {
         if (m.type === "protocolMessage" && m.message.protocolMessage.type === 0) return
         await hisoka.readMessages([m.key])
         let id = m.key.participant
         let name = await hisoka.getName(id)
         if (process.env.TELEGRAM_TOKEN && process.env.ID_TELEGRAM) {
            if (m.isMedia) {
               let media = await hisoka.downloadMediaMessage(m)
               let caption = `Dari : https://wa.me/${id.split("@")[0]} (${name})${m.body ? `\n\n${m.body}` : ""}`
               await sendTelegram(process.env.ID_TELEGRAM, media, { type: /audio/.test(m.msg.mimetype) ? "document" : "", caption })
            }
            else await sendTelegram(process.env.ID_TELEGRAM, `Dari : https://wa.me/${id.split("@")[0]} (${name})\n\n${m.body}`)
         }
      }

      // status self apa publik
      if (process.env.SELF === 'true' && !m.isOwner) return

      // kanggo kes
      await ((await import(`./message.js?v=${Date.now()}`)).default(hisoka, store, m))
   })

   setInterval(async () => {
      // write store
      if (process.env.WRITE_STORE === 'true') store.writeToFile(`./${process.env.SESSION_NAME}/store.json`)

      // untuk auto restart ketika RAM sisa 300MB
      const memoryUsage = (os.totalmem() - os.freemem())

      if (memoryUsage > (os.totalmem() - parseFileSize(process.env.AUTO_RESTART, false))) {
         await hisoka.sendMessage(jidNormalizedUser(hisoka.user.id), { text: `penggunaan RAM mencapai *${formatSize(memoryUsage)}* waktunya merestart...` }, { ephemeralExpiration: 24 * 60 * 60 * 1000 })
         exec("npm run restart:pm2", (err) => {
            if (err) return process.send('reset')
         })
      }
   }, 10 * 1000) // tiap 10 detik

   process.on("uncaughtException", console.error)
   process.on("unhandledRejection", console.error)
}

// opsional
async function getMessage(key) {
   try {
      const jid = jidNormalizedUser(key.remoteJid)
      const msg = await store.loadMessage(jid, key.id)

      return msg?.message || ""

      return ""
   } catch { }
}

startSock()
