import { useJob } from '../../store/useJob'
import { EditorScreen } from './EditorScreen'
import { ProcessingScreen } from './ProcessingScreen'
import { StartScreen } from './StartScreen'

/**
 * The clip extractor: open a recording, get named clips out.
 *
 * Which screen shows is the job's status, not navigation. There is nothing to
 * link to and no way to be on the editor without a processed file behind it.
 */
export function ExtractTab() {
  const status = useJob((state) => state.status)

  return status === 'ready' ? (
    <EditorScreen />
  ) : status === 'idle' ? (
    <StartScreen />
  ) : (
    <ProcessingScreen />
  )
}
