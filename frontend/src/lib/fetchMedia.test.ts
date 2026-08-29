import { describe, expect, it } from 'vitest'
import { filenameFromUrl, interpretMp3cow, youtubeId, ytDownloadPath } from './fetchMedia'

describe('youtubeId', () => {
  it('reads the id from every shape of youtube link', () => {
    expect(youtubeId('https://www.youtube.com/watch?v=b4XpMTUlorc')).toBe('b4XpMTUlorc')
    expect(youtubeId('https://youtu.be/b4XpMTUlorc')).toBe('b4XpMTUlorc')
    expect(youtubeId('https://www.youtube.com/shorts/b4XpMTUlorc')).toBe('b4XpMTUlorc')
    expect(youtubeId('https://www.youtube.com/embed/b4XpMTUlorc')).toBe('b4XpMTUlorc')
    expect(youtubeId('https://www.youtube.com/watch?list=abc&v=b4XpMTUlorc')).toBe('b4XpMTUlorc')
  })

  it('drops the query and fragment junk around the id', () => {
    expect(youtubeId('https://www.youtube.com/watch?v=b4XpMTUlorc&t=30s')).toBe('b4XpMTUlorc')
    expect(youtubeId('https://youtu.be/b4XpMTUlorc?si=share')).toBe('b4XpMTUlorc')
    expect(youtubeId('https://www.youtube.com/watch?v=b4XpMTUlorc#top')).toBe('b4XpMTUlorc')
  })

  it('is null for everything that is not a video link', () => {
    expect(youtubeId('https://example.com/watch?v=b4XpMTUlorc'.replace('watch?v=', 'file/'))).toBeNull()
    expect(youtubeId('https://www.youtube.com/')).toBeNull()
    expect(youtubeId('https://www.youtube.com/watch?v=short')).toBeNull()
    expect(youtubeId('https://files.catbox.moe/abc.mp3')).toBeNull()
  })
})

describe('filenameFromUrl', () => {
  it('keeps a basename that already has an accepted extension', () => {
    expect(filenameFromUrl('https://a.com/dir/sound.mp3?token=x#y', null)).toBe('sound.mp3')
  })

  it('decodes percent encoding', () => {
    expect(filenameFromUrl('https://a.com/my%20sound.ogg', null)).toBe('my sound.ogg')
  })

  it('maps the content type when the path has no usable extension', () => {
    expect(filenameFromUrl('https://a.com/stream', 'audio/mpeg')).toBe('stream.mp3')
    expect(filenameFromUrl('https://a.com/stream', 'audio/ogg')).toBe('stream.ogg')
    expect(filenameFromUrl('https://a.com/stream', 'audio/wav')).toBe('stream.wav')
    expect(filenameFromUrl('https://a.com/stream', 'audio/flac')).toBe('stream.flac')
    expect(filenameFromUrl('https://a.com/stream', 'video/webm')).toBe('stream.webm')
    expect(filenameFromUrl('https://a.com/stream', 'video/mp4')).toBe('stream.mp4')
    expect(filenameFromUrl('https://a.com/stream', 'audio/mp4')).toBe('stream.m4a')
    expect(filenameFromUrl('https://a.com/stream', 'audio/aac')).toBe('stream.aac')
    expect(filenameFromUrl('https://a.com/dl.php', 'audio/mpeg')).toBe('dl.php.mp3')
  })

  it('ignores a charset suffix on the type', () => {
    expect(filenameFromUrl('https://a.com/stream', 'audio/ogg;charset=utf-8')).toBe('stream.ogg')
  })

  it('falls back to .mp3 so the decoder still gets a try', () => {
    expect(filenameFromUrl('https://a.com/stream', null)).toBe('stream.mp3')
    expect(filenameFromUrl('https://a.com/stream', 'application/octet-stream')).toBe('stream.mp3')
  })

  it('uses the host when the path has no basename', () => {
    expect(filenameFromUrl('https://a.com/', 'audio/mpeg')).toBe('a.com.mp3')
  })
})

describe('interpretMp3cow', () => {
  it('keeps waiting on the working statuses', () => {
    expect(interpretMp3cow({ status: '' })).toEqual({ kind: 'pending' })
    expect(interpretMp3cow({ status: '3' })).toEqual({ kind: 'pending' })
  })

  it('hands back the download and title when done', () => {
    expect(interpretMp3cow({ status: '1', download: 'https://x/dl.php?id=ab', title: 'song' })).toEqual({
      kind: 'done',
      download: 'https://x/dl.php?id=ab',
      title: 'song',
    })
  })

  it('does not trust a done answer without a link', () => {
    expect(interpretMp3cow({ status: '1', title: 'song' }).kind).toBe('failed')
  })

  it('passes the converter own error message through', () => {
    expect(interpretMp3cow({ status: '0', message: 'Video is too long' })).toEqual({
      kind: 'failed',
      message: 'Video is too long',
    })
    expect(interpretMp3cow({ status: '0' }).kind).toBe('failed')
  })

  it('treats the captcha and ad states as dead ends', () => {
    expect(interpretMp3cow({ status: 'c', url: 'https://x/captcha' }).kind).toBe('failed')
    expect(interpretMp3cow({ status: 'p' }).kind).toBe('failed')
  })

  it('fails on shapes it has never seen', () => {
    expect(interpretMp3cow({ status: 'banana' }).kind).toBe('failed')
    expect(interpretMp3cow(null).kind).toBe('failed')
    expect(interpretMp3cow('nope').kind).toBe('failed')
  })
})

describe('ytDownloadPath', () => {
  it('rewrites a good download link onto the proxy route', () => {
    expect(ytDownloadPath('https://ijf.wejfknwejfkerf.org/dl.php?id=570a34456a740ce7')).toBe(
      '/yt/dl?h=ijf.wejfknwejfkerf.org&i=570a34456a740ce7',
    )
  })

  it('refuses hosts outside the allowlist', () => {
    expect(() => ytDownloadPath('https://evil.example.com/dl.php?id=abcd')).toThrow()
    expect(() => ytDownloadPath('https://wejfknwejfkerf.org.evil.com/dl.php?id=abcd')).toThrow()
  })

  it('refuses ids that are not hex', () => {
    expect(() => ytDownloadPath('https://i.wejfknwejfkerf.org/dl.php?id=../etc')).toThrow()
    expect(() => ytDownloadPath('https://i.wejfknwejfkerf.org/dl.php')).toThrow()
  })

  it('refuses something that is not a link at all', () => {
    expect(() => ytDownloadPath('not a link')).toThrow()
  })
})
