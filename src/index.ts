import { VK } from 'vk-io'
import Telegram from 'node-telegram-bot-api'
import { readFileSync } from 'fs'
import { config as dotenv } from 'dotenv'
import * as jpeg from 'jpeg-js'
import * as nsfwjs from 'nsfwjs'
import * as tf from '@tensorflow/tfjs-node'
import { type NSFWJS } from 'nsfwjs'
tf.enableProdMode()

interface Config {
  vk: {
    group_id: number
    peer_id: number
  }
  tg: {
    chat_id: number
    channel: string
  }
  model: string
}

class MessageConsumer {
  constructor (readonly conf: Config, readonly vk: VK, readonly tg: Telegram, readonly nsfw: NSFWJS) {}

  async consumeVk (id: number, url: string): Promise<void> {
    console.log('VK link: ', url)
    const [user, resp] = await Promise.all([
      this.vk.api.users.get({ user_ids: [id], fields: ['domain'] }),
      fetch(url).then(i => i.arrayBuffer())
    ])
    await this.consume(
      `<a href="vk.com/id${id}">@${user[0].domain} (VK)</a>`,
      resp
    )
  }

  async consumeTg (user: string, fileId: string): Promise<void> {
    const link = await this.tg.getFileLink(fileId)
    console.log('TG link: ', link)
    const resp = await fetch(link).then(i => i.arrayBuffer())
    await this.consume(`@${user}`, resp)
  }

  async consume (user: string, array: ArrayBuffer): Promise<void> {
    const image = jpeg.decode(array, { useTArray: true })
    const numChannels = 3
    const numPixels = image.width * image.height
    const values = new Int32Array(numPixels * numChannels)
    for (let i = 0; i < numPixels; i++) {
      for (let c = 0; c < numChannels; ++c) { values[i * numChannels + c] = image.data[i * 4 + c] }
    }
    const tensor = tf.tensor3d(values, [image.height, image.width, numChannels], 'int32')
    const results = (await this.nsfw.classify(tensor)).reduce<Record<string, number>>((obj, val) => {
      obj[val.className] = val.probability
      return obj
    }, {})
    tensor.dispose()
    if (Math.max(results.Sexy, results.Porn, results.Hentai) > 0.3) {
      await this.tg.sendPhoto(
        this.conf.tg.channel,
        Buffer.from(array),
        { caption: `От ${user}`, parse_mode: 'HTML' }
      )
    }
  }
}

function forceEnv (name: string): string {
  const v = process.env[name]
  if (v) return v
  else throw Error(`Environment variable '${name}' required`)
}

void (async function main () {
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
  const consumer = new MessageConsumer(conf, vk, tg, await nsfwjs.load(`file://${conf.model}/`, { size: 299 }))

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
})()
