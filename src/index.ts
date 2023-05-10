import { VK } from 'vk-io'
import Telegram from 'node-telegram-bot-api'
import { readFileSync } from 'fs'
import { config as dotenv } from 'dotenv'
import type internal from 'stream'

interface Config {
  vk: {
    group_id: number
    peer_id: number
  }
  tg: {
    chat_id: number
    channel: string
  }
}

class MessageConsumer {
  constructor (readonly conf: Config, readonly vk: VK, readonly tg: Telegram) {}

  async consumeVk (id: number, url: string): Promise<void> {
    const [user, resp] = await Promise.all([
      vk.api.users.get({ user_ids: [id], fields: ['domain'] }),
      fetch(url).then(i => i.arrayBuffer())
    ])
    await this.consume(`<a href="vk.com/id${id}">@${user[0].domain} (VK)</a>`, Buffer.from(resp))
  }

  async consumeTg (user: string, fileId: string): Promise<void> {
    const stream = tg.getFileStream(fileId)
    await this.consume(`@${user}`, stream)
  }

  async consume (user: string, stream: internal.Readable | Buffer): Promise<void> {
    await tg.sendPhoto(this.conf.tg.channel, stream, { caption: `От ${user}`, parse_mode: 'HTML' })
  }
}

function forceEnv (name: string): string {
  const v = process.env[name]
  if (v) return v
  else throw Error(`Environment variable '${name}' required`)
}

dotenv()
const conf: Config = JSON.parse(readFileSync(
  process.env.CONFIG ?? 'config.json',
  { encoding: 'utf-8' }
))
const vk = new VK({
  token: forceEnv('VK_TOKEN'),
  pollingGroupId: Math.abs(conf.vk.group_id)
})
const tg = new Telegram(forceEnv('TG_TOKEN'))
const consumer = new MessageConsumer(conf, vk, tg)

vk.updates.on('message_new', event => {
  if (event.peerId !== conf.vk.peer_id) return
  const id = event.senderId
  event.attachments
    .filter(i => i.type === 'photo')
    .forEach(i => {
      const url = (i.toJSON() as any).largeSizeUrl
      void consumer.consumeVk(id, url)
    })
})

tg.addListener('message', ({ from, photo }) => {
  if (!photo) return
  photo.sort((a, b) => b.file_size! - a.file_size!)
  void consumer.consumeTg(from!.username!, photo[0].file_id)
})

void vk.updates.start()
void tg.startPolling()
