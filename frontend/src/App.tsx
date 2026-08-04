import { ExploreTab } from './components/explore/ExploreTab'
import { ExtractTab } from './components/extract/ExtractTab'
import { Navbar } from './components/Navbar'
import { ReviewTab } from './components/review/ReviewTab'
import { UploadTab } from './components/upload/UploadTab'
import { useTabs } from './store/useTabs'

export function App() {
  const tab = useTabs((state) => state.tab)
  const setTab = useTabs((state) => state.setTab)

  // Inactive tabs are hidden, not unmounted. Extract holds a decoded recording
  // and a live AudioContext that unmounting would tear down, and losing an
  // hour's clip editing to a glance at another tab is not a defensible trade.
  // Explore keeps its place in a 42,000 row list on the same reasoning.
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
        <div hidden={tab !== 'explore'}>
          <ExploreTab />
        </div>
      </main>
    </>
  )
}
