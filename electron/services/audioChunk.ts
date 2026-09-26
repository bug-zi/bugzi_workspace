// ASR 音频切片模块（优化建议区第58轮反馈修复）：转写分片此前假设 mp3（帧自含、帧对齐任意切），
// 但订阅源常见 m4a（MP4/AAC 容器）——中段切片丢 ftyp/moov 头后是无效容器，服务端解码 500
// （实测：首片带头 200 / 中段碎片 500 / ADTS 重封装片 200）。本模块按真实容器分流：
//   mp3  → 帧同步切片（原逻辑迁入）
//   mp4  → 解析 moov 取 AAC 帧表 + 合成 ADTS 头重封装，按帧边界切片
//   其他 → 整文件单片（≤45MB 直传由调用方保证；更大则服务端报错）
// ADTS 头合成参数取自 esds 的 AudioSpecificConfig（freqIdx/chCfg），profile 固定 AAC-LC。

import type { Buffer as NodeBuffer } from 'node:buffer'

/** 单片目标大小（~40MiB，实测硅基流动接受；文档上限 50MB/1h——40MiB@最低常见码率 97kbps ≈ 57min，安全） */
const CHUNK_TARGET = 40 * 1024 * 1024

export interface AsrChunkPlan {
  chunks: NodeBuffer[]
  mime: string
  ext: string
}

function* iterBoxes(buf: NodeBuffer, start: number, end: number): Generator<{ off: number; size: number; type: string }> {
  let off = start
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off)
    let hdr = 8
    if (size === 1) {
      if (off + 16 > end) return
      size = Number(buf.readBigUInt64BE(off + 8))
      hdr = 16
    } else if (size === 0) {
      size = end - off
    }
    if (size < hdr || off + size > end) return
    yield { off, size, type: buf.toString('latin1', off + 4, off + 8) }
    off += size
  }
}

function findBox(buf: NodeBuffer, start: number, end: number, type: string) {
  for (const b of iterBoxes(buf, start, end)) if (b.type === type) return b
  return null
}

function isMp3(buf: NodeBuffer): boolean {
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true // "ID3"
  return buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0
}

function isMp4(buf: NodeBuffer): boolean {
  return buf.length >= 8 && buf.toString('latin1', 4, 8) === 'ftyp'
}

/** mp3 帧同步字节（0xFF + 次字节高 5 位全 1）向后查找，分片切在帧边界上 */
function findFrameSync(buf: NodeBuffer, from: number): number {
  for (let i = Math.max(0, from); i < buf.length - 1; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) return i
  }
  return buf.length
}

function sliceMp3(buf: NodeBuffer): NodeBuffer[] {
  const chunks: NodeBuffer[] = []
  let offset = 0
  while (offset < buf.length) {
    let end = Math.min(offset + CHUNK_TARGET, buf.length)
    if (end < buf.length) end = findFrameSync(buf, end)
    if (end <= offset) end = buf.length // 防御：帧同步找不到时剩余全切
    chunks.push(buf.subarray(offset, end))
    offset = end
  }
  return chunks
}

/** mp4 音轨参数：esds 的 AudioSpecificConfig 位域 + 逐 sample（偏移,长度）表 */
interface Mp4AudioTrack {
  freqIdx: number
  chCfg: number
  samples: { off: number; len: number }[]
}

function parseMp4Audio(buf: NodeBuffer): Mp4AudioTrack {
  const moov = findBox(buf, 0, buf.length, 'moov')
  if (!moov) throw new Error('AUDIO_SEGMENT_PARSE_FAILED')
  // 可能多轨（字幕/章节），取含 mp4a 的音轨
  for (const trak of iterBoxes(buf, moov.off + 8, moov.off + moov.size)) {
    if (trak.type !== 'trak') continue
    const mdia = findBox(buf, trak.off + 8, trak.off + trak.size, 'mdia')
    const minf = mdia && findBox(buf, mdia.off + 8, mdia.off + mdia.size, 'minf')
    const stbl = minf && findBox(buf, minf.off + 8, minf.off + minf.size, 'stbl')
    if (!stbl) continue
    const stblStart = stbl.off + 8
    const stblEnd = stbl.off + stbl.size
    const stsd = findBox(buf, stblStart, stblEnd, 'stsd')
    if (!stsd) continue
    // stsd payload：version/flags(4)+entry_count(4) 后是 AudioSampleEntry（8 头 + 28 固定字段）→ esds
    const mp4a = findBox(buf, stsd.off + 16, stsd.off + stsd.size, 'mp4a')
    if (!mp4a) continue
    const esds = findBox(buf, mp4a.off + 8 + 28, mp4a.off + mp4a.size, 'esds')
    const stsz = findBox(buf, stblStart, stblEnd, 'stsz')
    const stsc = findBox(buf, stblStart, stblEnd, 'stsc')
    const stco = findBox(buf, stblStart, stblEnd, 'stco')
    const co64 = stco ? null : findBox(buf, stblStart, stblEnd, 'co64')
    if (!esds || !stsz || !stsc || (!stco && !co64)) throw new Error('AUDIO_SEGMENT_PARSE_FAILED')

    // esds 描述符链：03 ES →(body+3) 04 DecoderConfig →(body+13) 05 DecoderSpecific(=ASC)
    function readDesc(off: number): { size: number; body: number } {
      let size = 0
      let o = off + 1
      for (let i = 0; i < 4; i++) {
        const b = buf[o]
        size = (size << 7) | (b & 0x7f)
        o++
        if (!(b & 0x80)) break
      }
      return { size, body: o }
    }
    const eOff = esds.off + 12 // 越过 box 头 + version/flags
    const d1 = readDesc(eOff)
    const d2 = readDesc(d1.body + 3)
    const d3 = readDesc(d2.body + 13)
    const asc0 = buf[d3.body]
    const asc1 = buf[d3.body + 1]
    const freqIdx = ((asc0 & 0x07) << 1) | (asc1 >> 7)
    const chCfg = (asc1 >> 3) & 0x0f
    if (freqIdx === 0x0f || chCfg === 0) throw new Error('AUDIO_SEGMENT_PARSE_FAILED')

    // stsz → 每帧长度
    const szOff = stsz.off + 12
    const count = buf.readUInt32BE(szOff + 4)
    const uniform = buf.readUInt32BE(szOff)
    const sizes: number[] = []
    if (uniform !== 0) for (let i = 0; i < count; i++) sizes.push(uniform)
    else for (let i = 0; i < count; i++) sizes.push(buf.readUInt32BE(szOff + 8 + i * 4))

    // stsc（chunk→每 chunk 帧数，稀疏表）+ stco/co64（chunk 文件偏移）→ 逐帧偏移
    const scOff = stsc.off + 12
    const entryCount = buf.readUInt32BE(scOff)
    const entries: { first: number; spc: number }[] = []
    for (let i = 0; i < entryCount; i++) {
      entries.push({ first: buf.readUInt32BE(scOff + 4 + i * 12), spc: buf.readUInt32BE(scOff + 4 + i * 12 + 4) })
    }
    const chunkOffsets: number[] = []
    if (stco) {
      const o = stco.off + 12
      const n = buf.readUInt32BE(o)
      for (let i = 0; i < n; i++) chunkOffsets.push(buf.readUInt32BE(o + 4 + i * 4))
    } else {
      const o = co64!.off + 12
      const n = buf.readUInt32BE(o)
      for (let i = 0; i < n; i++) chunkOffsets.push(Number(buf.readBigUInt64BE(o + 4 + i * 8)))
    }
    const spcOf: number[] = []
    for (let e = 0; e < entries.length; e++) {
      const last = e + 1 < entries.length ? entries[e + 1].first - 1 : chunkOffsets.length
      for (let c = entries[e].first; c <= last; c++) spcOf[c - 1] = entries[e].spc
    }
    const samples: { off: number; len: number }[] = []
    for (let c = 0; c < chunkOffsets.length; c++) {
      let off = chunkOffsets[c]
      for (let s = 0; s < (spcOf[c] ?? 0); s++) {
        const len = sizes[samples.length]
        if (len == null) break
        samples.push({ off, len })
        off += len
      }
    }
    if (samples.length !== count) throw new Error('AUDIO_SEGMENT_PARSE_FAILED')
    return { freqIdx, chCfg, samples }
  }
  throw new Error('AUDIO_SEGMENT_PARSE_FAILED')
}

/** AAC 帧加 7 字节 ADTS 头重封装，攒到 targetBytes 即产出一片（每片都从帧边界开始，任意片合法可解码） */
function buildAdtsChunks(buf: NodeBuffer, track: Mp4AudioTrack, targetBytes = CHUNK_TARGET): NodeBuffer[] {
  const { freqIdx, chCfg, samples } = track
  const chunks: NodeBuffer[] = []
  const parts: NodeBuffer[] = []
  let size = 0
  const flush = (): void => {
    if (size > 0) chunks.push(Buffer.concat(parts.splice(0), size))
    size = 0
  }
  for (let i = 0; i < samples.length; i++) {
    const { off, len } = samples[i]
    const frameLen = len + 7
    if (frameLen > 0x1fff) throw new Error('AUDIO_SEGMENT_PARSE_FAILED')
    const h = Buffer.from([
      0xff,
      0xf1, // syncword + MPEG-4 + layer 0 + protection_absent
      (1 << 6) | (freqIdx << 2) | (chCfg >> 2), // profile=AAC-LC(1)
      ((chCfg & 3) << 6) | ((frameLen >> 11) & 0x03),
      (frameLen >> 3) & 0xff,
      ((frameLen & 7) << 5) | 0x1f, // buffer fullness 0x7FF 高 5 位
      0xfc // fullness 低 6 位 + 一帧一 ADTS 包
    ])
    parts.push(h, buf.subarray(off, off + len))
    size += frameLen
    if (size >= targetBytes) flush()
  }
  flush()
  return chunks
}

/** 按真实容器分流切片：mp3 帧对齐 / mp4→ADTS 重封装 / 其他整文件单 */
export function sliceAudioForAsr(buf: NodeBuffer): AsrChunkPlan {
  if (isMp3(buf)) return { chunks: sliceMp3(buf), mime: 'audio/mpeg', ext: 'mp3' }
  if (isMp4(buf)) {
    const track = parseMp4Audio(buf)
    return { chunks: buildAdtsChunks(buf, track), mime: 'audio/aac', ext: 'aac' }
  }
  return { chunks: [buf], mime: 'audio/mpeg', ext: 'mp3' }
}
