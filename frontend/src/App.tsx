import { EditorScreen } from './components/EditorScreen'
import { Navbar } from './components/Navbar'
import { ProcessingScreen } from './components/ProcessingScreen'
import { UploadScreen } from './components/UploadScreen'
import { useJob } from './store/useJob'

export function App() {
  const status = useJob((state) => state.status)
  const reset = useJob((state) => state.reset)

  return (
    <>
      <Navbar onHome={reset} />
      <main>
        {status === 'ready' ? (
          <EditorScreen />
        ) : status === 'idle' ? (
          <UploadScreen />
        ) : (
          <ProcessingScreen />
        )}
      </main>
    </>
  )
}
