import { useCallback, useEffect, useRef, useState } from 'react'
import { asAudioSamples } from '../lib/blob'
import { MASTER_SAMPLE_RATE } from '../pipeline/decode'

/**
 * Range playback straight out of the decoded audio already in memory.
 *
 * Playing a clip means playing a time range of the master, not loading a file
 * per clip. That keeps playback instant while a boundary is being dragged --
 * there is no encode to wait for -- and it is what makes previewing an
 * *extended* clip possible at all, since the audio outside the current bounds is
 * right there.
 */
export function usePlayer(master: Float32Array | null) {
  const contextRef = useRef<AudioContext | null>(null)
  const bufferRef = useRef<AudioBuffer | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const startedAtRef = useRef(0)
  const offsetRef = useRef(0)
  const rafRef = useRef<number | null>(null)

  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)

  // Rebuilding the AudioBuffer per play would copy the whole recording every
  // time, so it is built once and reused.
  useEffect(() => {
    bufferRef.current = null
    if (!master || master.length === 0) return
    const context = (contextRef.current ??= new AudioContext())
    const buffer = context.createBuffer(1, master.length, MASTER_SAMPLE_RATE)
    buffer.copyToChannel(asAudioSamples(master), 0)
    bufferRef.current = buffer
  }, [master])

  const stop = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.onended = null
      try {
        sourceRef.current.stop()
      } catch {
        /* already stopped */
      }
      sourceRef.current = null
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    setPlaying(false)
  }, [])

  const tick = useCallback(() => {
    const context = contextRef.current
    if (!context) return
    setTime(offsetRef.current + (context.currentTime - startedAtRef.current))
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const playRange = useCallback(
    (fromS: number, toS?: number) => {
      const context = contextRef.current
      const buffer = bufferRef.current
      if (!context || !buffer) return
      stop()
      void context.resume()

      const from = Math.max(0, Math.min(fromS, buffer.duration))
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      source.onended = () => {
        if (sourceRef.current === source) stop()
      }

      if (toS !== undefined && toS > from) {
        source.start(0, from, Math.min(toS, buffer.duration) - from)
      } else {
        source.start(0, from)
      }

      sourceRef.current = source
      startedAtRef.current = context.currentTime
      offsetRef.current = from
      setTime(from)
      setPlaying(true)
      rafRef.current = requestAnimationFrame(tick)
    },
    [stop, tick],
  )

  const seek = useCallback((to: number) => {
    offsetRef.current = Math.max(0, to)
    setTime(offsetRef.current)
  }, [])

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      void contextRef.current?.close()
    },
    [],
  )

  return { time, playing, playRange, stop, seek }
}
