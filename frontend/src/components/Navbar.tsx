import { useState } from 'react'
import { Icon } from './Icon'

/**
 * metastruct.net's navbar chrome, carrying this app's three tabs.
 *
 * The visual shell (logo, heights, hover behaviour) is still theirs, but the
 * items are ours: the site links that used to fill the bar belonged to the rest
 * of metastruct.net, and this page stopped being one page of it the moment it
 * grew tabs of its own. The logo still leads back to the mothership.
 */

export type { Tab } from '../store/useTabs'
import type { Tab } from '../store/useTabs'

const TABS: { id: Tab; label: string; icon: 'scissors' | 'cloudUpload' | 'clipboardCheck' }[] = [
  { id: 'extract', label: 'Extract', icon: 'scissors' },
  { id: 'upload', label: 'Upload', icon: 'cloudUpload' },
  { id: 'review', label: 'Review', icon: 'clipboardCheck' },
]

interface Props {
  tab: Tab
  onTab: (tab: Tab) => void
}

export function Navbar({ tab, onTab }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <nav className="navbar" aria-label="main navigation">
      <div className="container is-wide">
        <div className="navbar-brand">
          <a href="https://metastruct.net" title="Meta Construct" rel="noreferrer">
            <img src="/logo.svg" className="logo navbar-item" alt="Meta Construct" />
          </a>
          <button
            type="button"
            className={`navbar-burger${open ? ' is-active' : ''}`}
            aria-label="menu"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </button>
        </div>

        <div className={`navbar-menu${open ? ' is-active' : ''}`}>
          <div className="navbar-start">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`navbar-item${tab === item.id ? ' is-active' : ''}`}
                aria-current={tab === item.id ? 'page' : undefined}
                onClick={() => {
                  setOpen(false)
                  onTab(item.id)
                }}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </nav>
  )
}
