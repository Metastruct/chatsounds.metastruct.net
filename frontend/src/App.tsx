import { useState } from 'react'
import { ExtractTab } from './components/extract/ExtractTab'
import { Navbar, type Tab } from './components/Navbar'
import { ReviewTab } from './components/review/ReviewTab'
import { UploadTab } from './components/upload/UploadTab'

export function App() {
  const [tab, setTab] = useState<Tab>('extract')

  // Inactive tabs are hidden, not unmounted. Extract holds a decoded recording
  // and a live AudioContext that unmounting would tear down, and losing an
  // hour's clip editing to a glance at another tab is not a defensible trade.
  return (
    <>
      <Navbar tab={tab} onTab={setTab} />
      <main>
        <div hidden={tab !== 'extract'}>
          <ExtractTab />
        </div>
        <div hidden={tab !== 'upload'}>
          <UploadTab />
        </div>
        <div hidden={tab !== 'review'}>
          <ReviewTab />
        </div>
      </main>
    </>
  )
}
